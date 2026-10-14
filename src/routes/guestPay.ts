import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import { newPayToken, newClaimCode } from "../lib/payLinks.js";
import { startCharge, ChargeError } from "../lib/charges.js";
import { publicRateLimit } from "../lib/publicRateLimit.js";
import { normalizeNgPhone } from "../lib/sms.js";

const chargeBody = z.object({
  email: z.string().trim().email().max(160),
  phone: z.string().trim().max(30).optional(),
  // Defaults to the full balance.
  amountMinor: z.number().int().min(100).optional(),
});

// Pay without a WelliPay account. The provider shares an invoice's payment
// link; the link holds an unguessable token. Whoever has the link can pay that
// one invoice, and nothing else.
const guestPayRoutes: FastifyPluginAsync = async (app) => {
  // Staff: create or replace the payment link token for an invoice.
  app.post("/provider/invoices/:id/pay-link", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = z.object({ rotate: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, problems.badRequest("Invalid body.", "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const invoice = await prisma.invoice.findFirst({ where: { id, tenantId } });
    if (!invoice) return sendProblem(reply, problems.notFound("Invoice not found."));
    if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
      return sendProblem(reply, problems.conflict(`This invoice is ${invoice.status.toLowerCase()}.`, "invoice_not_payable"));
    }
    if (invoice.payToken && !parsed.data.rotate) return reply.code(200).send({ payToken: invoice.payToken });
    const updated = await prisma.invoice.update({ where: { id }, data: { payToken: newPayToken() } });
    return reply.code(200).send({ payToken: updated.payToken });
  });

  app.get("/public/pay/:token", { config: publicRateLimit(30) }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const invoice = await prisma.invoice.findUnique({ where: { payToken: token }, include: { lines: true, tenant: { select: { name: true } } } });
    if (!invoice) return sendProblem(reply, problems.notFound("This payment link is not valid."));
    const patient = await prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId: invoice.tenantId, patientRef: invoice.patientRef } } });
    const firstName = patient?.fullName.trim().split(/\s+/)[0];
    const balance = BigInt(invoice.amountMinor) - BigInt(invoice.paidAmountMinor);
    return reply.code(200).send({
      providerName: invoice.tenant.name,
      invoiceRef: invoice.providerInvoiceRef,
      description: invoice.description,
      patientFirstName: firstName,
      currency: invoice.currency,
      amountMinor: toMinorNumber(invoice.amountMinor),
      paidAmountMinor: toMinorNumber(invoice.paidAmountMinor),
      balanceMinor: toMinorNumber(balance > 0n ? balance : 0n),
      status: invoice.status,
      lines: invoice.lines
        .sort((a: { position: number }, b: { position: number }) => a.position - b.position)
        .map((l: { description: string; quantity: number; unitPriceMinor: number }) => ({ description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
    });
  });

  app.post("/public/pay/:token/charge", { config: publicRateLimit(10) }, async (request, reply) => {
    const parsed = chargeBody.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const { token } = request.params as { token: string };
    const invoice = await prisma.invoice.findUnique({ where: { payToken: token } });
    if (!invoice) return sendProblem(reply, problems.notFound("This payment link is not valid."));
    const claimCode = newClaimCode();
    const phone = normalizeNgPhone(parsed.data.phone);
    try {
      const charge = await startCharge({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        email: parsed.data.email,
        amountMinor: parsed.data.amountMinor !== undefined ? BigInt(parsed.data.amountMinor) : undefined,
        source: "GUEST",
        claimCode,
        payerPhone: phone ?? undefined,
        callbackUrl: env.PAY_PAGE_URL ? `${env.PAY_PAGE_URL}?t=${encodeURIComponent(token)}` : undefined,
      });
      return reply.code(201).send({
        reference: charge.reference,
        authorizationUrl: charge.authorizationUrl,
        amountMinor: toMinorNumber(charge.amountMinor),
        claimCode,
      });
    } catch (err) {
      if (err instanceof ChargeError) return sendProblem(reply, { status: err.status, title: err.status === 502 ? "Bad Gateway" : "Error", detail: err.message, code: err.code });
      throw err;
    }
  });

  // The guest's receipt. Status comes from the webhook, never from the redirect.
  app.get("/public/pay/:token/charges/:reference", { config: publicRateLimit(60) }, async (request, reply) => {
    const { token, reference } = request.params as { token: string; reference: string };
    const invoice = await prisma.invoice.findUnique({ where: { payToken: token }, include: { tenant: { select: { name: true } } } });
    if (!invoice) return sendProblem(reply, problems.notFound("This payment link is not valid."));
    const charge = await prisma.paystackCharge.findFirst({ where: { reference, invoiceId: invoice.id } });
    if (!charge) return sendProblem(reply, problems.notFound());
    const payment = charge.paymentId ? await prisma.payment.findUnique({ where: { id: charge.paymentId } }) : null;
    return reply.code(200).send({
      reference: charge.reference,
      status: charge.status,
      amountMinor: toMinorNumber(charge.amountMinor),
      currency: "NGN",
      providerName: invoice.tenant.name,
      invoiceRef: invoice.providerInvoiceRef,
      description: invoice.description,
      paidAt: payment?.occurredAt.toISOString(),
      failureReason: charge.failureReason ?? undefined,
      // The code that lets a patient add this payment to a WelliPay profile.
      claimCode: charge.source === "GUEST" && charge.status !== "FAILED" ? (charge.claimCode ?? undefined) : undefined,
    });
  });
};

export default guestPayRoutes;
