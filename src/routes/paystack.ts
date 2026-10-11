import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { resolveActor } from "../lib/actor.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import { initializeTransaction, PaystackError } from "../lib/paystack.js";
import { sendProblem, problems } from "../lib/problem.js";

const createChargeSchema = z.object({
  invoiceId: z.string().min(1),
  email: z.string().email().max(160),
  // Defaults to the invoice's outstanding balance.
  amountMinor: z.number().int().min(100).optional(),
});

function serializeCharge(c: {
  id: string; invoiceId: string; reference: string; amountMinor: bigint; status: string;
  authorizationUrl: string | null; paymentId: string | null; failureReason: string | null; createdAt: Date;
}) {
  return {
    chargeId: c.id,
    invoiceId: c.invoiceId,
    reference: c.reference,
    amountMinor: toMinorNumber(c.amountMinor),
    currency: "NGN",
    status: c.status,
    authorizationUrl: c.authorizationUrl ?? undefined,
    paymentId: c.paymentId ?? undefined,
    failureReason: c.failureReason ?? undefined,
    createdAt: c.createdAt.toISOString(),
  };
}

// Starts a Paystack checkout for an invoice. Returns a URL to send the payer
// to. Nothing is recorded as paid here: the Payment is created only when
// Paystack's signed webhook confirms the charge (src/routes/paystackWebhook.ts).
const paystackRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/paystack/charges",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      if (!env.PAYSTACK_SECRET_KEY) {
        return sendProblem(reply, { status: 503, title: "Service Unavailable", detail: "Paystack is not configured on this service.", code: "paystack_not_configured" });
      }
      const parsed = createChargeSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }
      if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
        return sendProblem(reply, problems.conflict(`Invoice is ${invoice.status.toLowerCase()}.`, "invoice_not_payable"));
      }
      const outstanding = BigInt(invoice.amountMinor) - BigInt(invoice.paidAmountMinor);
      const amount = body.amountMinor !== undefined ? toMinorBigInt(body.amountMinor) : outstanding;
      if (amount <= 0n || amount > outstanding) {
        return sendProblem(
          reply,
          problems.unprocessable(`Amount must be between 1 and the outstanding balance (${toMinorNumber(outstanding)} kobo).`, "invalid_amount")
        );
      }

      const reference = `wp_${randomUUID().replace(/-/g, "")}`;
      let init;
      try {
        init = await initializeTransaction(env.PAYSTACK_SECRET_KEY, {
          email: body.email,
          amountMinor: toMinorNumber(amount),
          reference,
          callbackUrl: env.PAYSTACK_CALLBACK_URL,
          metadata: { invoiceId: invoice.id, tenantId },
        });
      } catch (err) {
        request.log.error({ err }, "Paystack initialize failed");
        const detail = err instanceof PaystackError ? err.message : "Could not reach Paystack.";
        return sendProblem(reply, { status: 502, title: "Bad Gateway", detail, code: "paystack_unavailable" });
      }

      const charge = await prisma.paystackCharge.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          reference,
          amountMinor: amount,
          email: body.email,
          authorizationUrl: init.authorizationUrl,
          createdBy: resolveActor(request.auth, null),
        },
      });
      return reply.code(201).header("Location", `/provider/paystack/charges/${charge.reference}`).send(serializeCharge(charge));
    }
  );

  app.get(
    "/provider/paystack/charges/:reference",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const { reference } = request.params as { reference: string };
      const charge = await prisma.paystackCharge.findFirst({ where: { reference, tenantId: request.auth!.tenantId } });
      if (!charge) return sendProblem(reply, problems.notFound());
      return reply.code(200).send(serializeCharge(charge));
    }
  );
};

export default paystackRoutes;
