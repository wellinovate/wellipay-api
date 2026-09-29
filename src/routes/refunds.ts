import type { FastifyPluginAsync } from "fastify";
import { createRefundSchema, listRefundsQuerySchema, decideRefundSchema } from "../schemas/refunds.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/refunds";

function serializeRefund(refund: {
  id: string; providerRefundRef: string; paymentId: string; invoiceId: string; amountMinor: bigint;
  currency: string; reason: string; requestedBy: string; status: string; decidedBy: string | null;
  decidedAt: Date | null; createdAt: Date;
}) {
  return {
    refundId: refund.id,
    providerRefundRef: refund.providerRefundRef,
    paymentId: refund.paymentId,
    invoiceId: refund.invoiceId,
    amountMinor: toMinorNumber(refund.amountMinor),
    currency: refund.currency,
    reason: refund.reason,
    requestedBy: refund.requestedBy,
    status: refund.status,
    decidedBy: refund.decidedBy ?? undefined,
    decidedAt: refund.decidedAt?.toISOString(),
    createdAt: refund.createdAt.toISOString(),
  };
}

const refundRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/refunds",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createRefundSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const payment = await prisma.payment.findFirst({ where: { id: body.paymentId, tenantId } });
      if (!payment) {
        return sendProblem(reply, problems.unprocessable(`paymentId "${body.paymentId}" does not exist for this tenant.`, "unknown_payment"));
      }
      if (payment.status !== "SUCCESS") {
        return sendProblem(reply, problems.unprocessable(`Payment is ${payment.status}; only a SUCCESS payment can be refunded.`, "payment_not_refundable"));
      }

      const existing = await prisma.refund.findUnique({
        where: { tenantId_providerRefundRef: { tenantId, providerRefundRef: body.providerRefundRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`providerRefundRef "${body.providerRefundRef}" already exists for this tenant.`, "refund_ref_already_exists"));
      }

      // A payment can have more than one refund request against it (partial
      // refunds) — cap the sum of PENDING + APPROVED requests at the
      // payment's own amount so it can never be over-refunded.
      const siblings = await prisma.refund.findMany({
        where: { paymentId: payment.id, status: { in: ["PENDING", "APPROVED"] } },
      });
      const alreadyRequested = siblings.reduce((sum: bigint, r: { amountMinor: bigint }) => sum + r.amountMinor, 0n);
      const requestedMinor = toMinorBigInt(body.amountMinor);
      if (alreadyRequested + requestedMinor > payment.amountMinor) {
        return sendProblem(
          reply,
          problems.unprocessable(
            `Refund amount (${body.amountMinor}) plus already-requested refunds (${toMinorNumber(alreadyRequested)}) exceeds the payment amount (${toMinorNumber(payment.amountMinor)}).`,
            "amount_exceeds_payment"
          )
        );
      }

      const refund = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.refund.create({
          data: {
            tenantId,
            providerRefundRef: body.providerRefundRef,
            paymentId: payment.id,
            invoiceId: payment.invoiceId,
            amountMinor: requestedMinor,
            currency: payment.currency,
            reason: body.reason,
            requestedBy: body.requestedBy,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "refund.requested",
          resourceRef: created.id,
          data: { refundRef: created.id, paymentId: payment.id, invoiceId: payment.invoiceId, amountMinor: body.amountMinor },
        });
        return created;
      });

      const responseBody = serializeRefund(refund);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/refunds/${refund.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/refunds",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listRefundsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { paymentId, invoiceId, status, limit, cursor } = parsed.data;

      const rows = await prisma.refund.findMany({
        where: {
          tenantId,
          ...(paymentId ? { paymentId } : {}),
          ...(invoiceId ? { invoiceId } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeRefund);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.patch(
    "/provider/refunds/:refundId/decision",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { refundId } = request.params as { refundId: string };
      const parsed = decideRefundSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const refund = await prisma.refund.findFirst({ where: { id: refundId, tenantId } });
      if (!refund) {
        return sendProblem(reply, problems.notFound());
      }
      if (refund.status !== "PENDING") {
        return sendProblem(reply, problems.conflict(`Refund is already ${refund.status.toLowerCase()}.`, "refund_already_decided"));
      }

      const now = new Date();
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updated = await tx.refund.update({
          where: { id: refund.id },
          data: { status: body.decision, decidedBy: body.actor, decidedAt: now },
        });

        let invoiceSnapshot: { invoiceId: string; paidAmountMinor: bigint; status: string } | null = null;
        if (body.decision === "APPROVED") {
          const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: refund.invoiceId } });
          const newPaid = invoice.paidAmountMinor - refund.amountMinor < 0n ? 0n : invoice.paidAmountMinor - refund.amountMinor;
          // Only OPEN/PARTIALLY_PAID/PAID recompute off the new balance — a
          // CANCELLED invoice's status is left alone; refunding a payment
          // against it doesn't reopen it for new invoicing.
          const newStatus =
            invoice.status === "CANCELLED"
              ? invoice.status
              : newPaid <= 0n
                ? "OPEN"
                : newPaid >= invoice.amountMinor
                  ? "PAID"
                  : "PARTIALLY_PAID";
          const updatedInvoice = await tx.invoice.update({
            where: { id: invoice.id },
            data: { paidAmountMinor: newPaid, status: newStatus },
          });
          invoiceSnapshot = { invoiceId: updatedInvoice.id, paidAmountMinor: updatedInvoice.paidAmountMinor, status: updatedInvoice.status };
        }

        await queueEvent(tx, {
          tenantId,
          eventType: "refund.decided",
          resourceRef: updated.id,
          data: { refundRef: updated.id, status: updated.status, decidedBy: body.actor },
        });

        return { refund: updated, invoiceSnapshot };
      });

      const responseBody = {
        ...serializeRefund(result.refund),
        invoice: result.invoiceSnapshot
          ? { invoiceId: result.invoiceSnapshot.invoiceId, paidAmountMinor: toMinorNumber(result.invoiceSnapshot.paidAmountMinor), status: result.invoiceSnapshot.status }
          : undefined,
      };
      return reply.code(200).send(responseBody);
    }
  );
};

export default refundRoutes;
