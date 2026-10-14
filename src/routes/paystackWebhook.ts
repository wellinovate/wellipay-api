import type { FastifyPluginAsync } from "fastify";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { queueEvent } from "../lib/webhooks.js";
import { toMinorNumber } from "../lib/money.js";
import { fundingTotals } from "../lib/funding.js";
import { mapPaystackChannel, verifyPaystackSignature } from "../lib/paystack.js";
import type { Prisma } from "@prisma/client";

interface PaystackEvent {
  event?: string;
  data?: { reference?: string; amount?: number; currency?: string; channel?: string; id?: number | string; gateway_response?: string };
}

// Paystack calls this when a charge succeeds or fails. It is public, so the
// only authentication is the HMAC signature over the raw body. Registered in
// its own encapsulated plugin so the raw-body JSON parser below does not
// affect any other route.
//
// Always answers 200 once the signature is valid, even for references it does
// not know or events it ignores: Paystack retries non-2xx responses, and a
// retry cannot fix those cases.
const paystackWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post("/webhooks/paystack", async (request, reply) => {
    if (!env.PAYSTACK_SECRET_KEY) return reply.code(503).send();
    const raw = typeof request.body === "string" ? request.body : "";
    const signature = request.headers["x-paystack-signature"];
    if (!verifyPaystackSignature(env.PAYSTACK_SECRET_KEY, raw, typeof signature === "string" ? signature : undefined)) {
      return reply.code(401).send();
    }

    let event: PaystackEvent;
    try {
      event = JSON.parse(raw) as PaystackEvent;
    } catch {
      return reply.code(400).send();
    }
    const reference = event.data?.reference;
    if (!reference || (event.event !== "charge.success" && event.event !== "charge.failed")) {
      return reply.code(200).send();
    }

    const charge = await prisma.paystackCharge.findUnique({ where: { reference } });
    if (!charge) {
      request.log.warn({ reference }, "Paystack webhook for unknown reference");
      return reply.code(200).send();
    }
    if (charge.status !== "PENDING") return reply.code(200).send(); // already handled

    if (event.event === "charge.failed") {
      await prisma.paystackCharge.updateMany({
        where: { id: charge.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: (event.data?.gateway_response ?? "Charge failed").slice(0, 200) },
      });
      return reply.code(200).send();
    }

    // charge.success: the amount and currency must match what was asked for.
    const paidKobo = event.data?.amount;
    if (event.data?.currency !== "NGN" || !Number.isInteger(paidKobo) || BigInt(paidKobo as number) !== BigInt(charge.amountMinor)) {
      request.log.error({ reference, paid: event.data?.amount, expected: toMinorNumber(charge.amountMinor) }, "Paystack amount mismatch");
      await prisma.paystackCharge.updateMany({
        where: { id: charge.id, status: "PENDING" },
        data: { status: "FAILED", failureReason: "Amount or currency did not match the charge." },
      });
      return reply.code(200).send();
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Claim the charge. Of two concurrent deliveries only one gets count 1.
      const claimed = await tx.paystackCharge.updateMany({ where: { id: charge.id, status: "PENDING" }, data: { status: "SUCCESS" } });
      if (claimed.count === 0) return;

      const invoice = await tx.invoice.findFirst({ where: { id: charge.invoiceId, tenantId: charge.tenantId } });
      if (!invoice) throw new Error(`Invoice ${charge.invoiceId} missing for Paystack charge ${charge.id}`);

      const payment = await tx.payment.create({
        data: {
          tenantId: charge.tenantId,
          providerPaymentRef: `paystack_${reference}`,
          invoiceId: invoice.id,
          patientRef: invoice.patientRef,
          facilityRef: invoice.facilityRef,
          channel: mapPaystackChannel(event.data?.channel),
          reference: event.data?.id !== undefined ? String(event.data.id) : reference,
          amountMinor: charge.amountMinor,
          currency: "NGN",
        },
      });
      const paid = invoice.paidAmountMinor + charge.amountMinor;
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmountMinor: paid, status: paid >= invoice.amountMinor ? "PAID" : "PARTIALLY_PAID" },
      });
      await tx.paystackCharge.update({ where: { id: charge.id }, data: { paymentId: payment.id } });
      await queueEvent(tx, {
        tenantId: charge.tenantId,
        eventType: "payment.recorded",
        resourceRef: payment.id,
        data: { paymentRef: payment.id, invoiceId: invoice.id, amountMinor: toMinorNumber(charge.amountMinor), channel: payment.channel },
      });

      // A sponsor's pledge: mark it paid and update the funding request. If
      // the pledge was already settled another way, the money is still recorded
      // above and only the pledge is left alone.
      if (charge.fundingContributionId) {
        const settled = await tx.fundingContribution.updateMany({
          where: { id: charge.fundingContributionId, status: "PENDING" },
          data: { status: "PAID", paidAt: new Date() },
        });
        if (settled.count === 1) {
          const contribution = await tx.fundingContribution.findUnique({ where: { id: charge.fundingContributionId } });
          if (contribution) {
            const siblings = await tx.fundingContribution.findMany({ where: { requestId: contribution.requestId } });
            const { totalPaid, status } = fundingTotals(siblings, contribution.id, charge.amountMinor);
            const fundingRequest = await tx.familyFundingRequest.update({
              where: { id: contribution.requestId },
              data: { fundedAmountMinor: totalPaid, status },
            });
            await queueEvent(tx, {
              tenantId: charge.tenantId,
              eventType: "family.contribution.updated",
              resourceRef: fundingRequest.id,
              data: { requestRef: fundingRequest.id, status: fundingRequest.status, fundedAmountMinor: toMinorNumber(fundingRequest.fundedAmountMinor) },
            });
          }
        } else {
          request.log.warn({ reference, fundingContributionId: charge.fundingContributionId }, "Pledge already settled when Paystack charge succeeded");
        }
      }
    });

    return reply.code(200).send();
  });
};

export default paystackWebhookRoutes;
