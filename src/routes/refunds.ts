import type { FastifyPluginAsync } from "fastify";
import { createRefundSchema, listRefundsQuerySchema, decideRefundSchema } from "../schemas/refunds.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import { resolveActor } from "../lib/actor.js";
import { env } from "../env.js";
import { createRefund, listRefundsForTransaction, findGatewayRefund, PaystackError } from "../lib/paystack.js";
import { refundIsRecoverable } from "../lib/recovery.js";
import { approvalStep } from "../lib/refundApproval.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/refunds";

function serializeRefund(refund: {
  id: string; providerRefundRef: string; paymentId: string; invoiceId: string; amountMinor: bigint;
  currency: string; reason: string; requestedBy: string; status: string; decidedBy: string | null;
  decidedAt: Date | null; createdAt: Date; gatewayRefundRef?: string | null; gatewayStatus?: string | null;
  recoveryStatus?: string | null; recoveredAt?: Date | null; firstApprovedBy?: string | null; firstApprovedAt?: Date | null;
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
    gatewayRefundRef: refund.gatewayRefundRef ?? undefined,
    gatewayStatus: refund.gatewayStatus ?? undefined,
    recoveryStatus: refund.recoveryStatus ?? undefined,
    recoveredAt: refund.recoveredAt?.toISOString(),
    firstApprovedBy: refund.firstApprovedBy ?? undefined,
    firstApprovedAt: refund.firstApprovedAt?.toISOString(),
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
      const requestedBy = resolveActor(request.auth, body.requestedBy);
      if (!requestedBy) {
        return sendProblem(reply, problems.badRequest("requestedBy is required for this token.", "actor_required"));
      }

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
            requestedBy: requestedBy,
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

  // Asks Paystack where a refund stands (pending, processing, processed,
  // needs-attention, failed) and saves the answer. Read-only on Paystack's side.
  app.post(
    "/provider/refunds/:refundId/gateway-status",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const { refundId } = request.params as { refundId: string };
      const tenantId = request.auth!.tenantId;
      const refund = await prisma.refund.findFirst({ where: { id: refundId, tenantId } });
      if (!refund) return sendProblem(reply, problems.notFound());
      if (!refund.gatewayRefundRef) {
        return sendProblem(reply, problems.unprocessable("This refund was not paid through Paystack.", "not_a_gateway_refund"));
      }
      if (!env.PAYSTACK_SECRET_KEY) {
        return sendProblem(reply, { status: 503, title: "Service Unavailable", detail: "Paystack is not configured on this service.", code: "paystack_not_configured" });
      }
      const payment = await prisma.payment.findFirst({ where: { id: refund.paymentId, tenantId } });
      const charge = payment ? await prisma.paystackCharge.findFirst({ where: { tenantId, paymentId: payment.id } }) : null;
      const transaction = charge?.reference ?? payment?.providerPaymentRef.replace(/^paystack_/, "");
      if (!transaction) return reply.code(200).send(serializeRefund(refund));

      try {
        const items = await listRefundsForTransaction(env.PAYSTACK_SECRET_KEY, transaction);
        const found = findGatewayRefund(items, refund.gatewayRefundRef);
        if (found && found.status !== refund.gatewayStatus) {
          const updated = await prisma.refund.update({ where: { id: refund.id }, data: { gatewayStatus: found.status } });
          return reply.code(200).send(serializeRefund(updated));
        }
      } catch (err) {
        request.log.error({ err, refundId: refund.id }, "Paystack refund status lookup failed");
        return sendProblem(reply, { status: 502, title: "Bad Gateway", detail: "Could not reach Paystack for the refund status.", code: "paystack_unavailable" });
      }
      return reply.code(200).send(serializeRefund(refund));
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
      const actor = resolveActor(request.auth, body.actor);
      if (!actor) {
        return sendProblem(reply, problems.badRequest("actor is required for this token.", "actor_required"));
      }

      const refund = await prisma.refund.findFirst({ where: { id: refundId, tenantId } });
      if (!refund) {
        return sendProblem(reply, problems.notFound());
      }
      if (refund.status !== "PENDING") {
        return sendProblem(reply, problems.conflict(`Refund is already ${refund.status.toLowerCase()}.`, "refund_already_decided"));
      }

      // A refund above the tenant's limit needs two different approvers. The
      // first approval is recorded here and the refund stays PENDING.
      const limit = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { refundApprovalLimitMinor: true } });
      const step = approvalStep({
        limitMinor: limit?.refundApprovalLimitMinor ?? null,
        amountMinor: refund.amountMinor,
        firstApprovedBy: refund.firstApprovedBy,
        actor,
        decision: body.decision,
      });
      if (step.kind === "BLOCKED") {
        return sendProblem(reply, problems.conflict(step.message, step.code));
      }
      if (step.kind === "FIRST") {
        const first = await prisma.refund.update({
          where: { id: refund.id },
          data: { firstApprovedBy: actor, firstApprovedAt: new Date() },
        });
        return reply.code(200).send({ ...serializeRefund(first), awaitingSecondApproval: true });
      }

      // A payment made through Paystack is refunded through Paystack. Call it
      // before recording the approval: if Paystack refuses, the refund stays
      // PENDING and nothing on the invoice changes.
      let gateway: { refundId: string; status: string } | null = null;
      let recoverable = false;
      if (body.decision === "APPROVED") {
        const payment = await prisma.payment.findFirst({ where: { id: refund.paymentId, tenantId } });
        if (payment?.providerPaymentRef.startsWith("paystack_")) {
          if (!env.PAYSTACK_SECRET_KEY) {
            return sendProblem(reply, { status: 503, title: "Service Unavailable", detail: "Paystack is not configured on this service.", code: "paystack_not_configured" });
          }
          const charge = await prisma.paystackCharge.findFirst({ where: { tenantId, paymentId: payment.id } });
          const transaction = charge?.reference ?? payment.providerPaymentRef.slice("paystack_".length);
          try {
            gateway = await createRefund(env.PAYSTACK_SECRET_KEY, { transaction, amountMinor: toMinorNumber(refund.amountMinor) });
          } catch (err) {
            request.log.error({ err, refundId: refund.id }, "Paystack refund failed");
            const detail = err instanceof PaystackError ? err.message : "Could not reach Paystack.";
            return sendProblem(reply, { status: 502, title: "Bad Gateway", detail: `Paystack did not accept the refund: ${detail} The refund is still pending.`, code: "paystack_refund_failed" });
          }
          const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { paystackSubaccountCode: true } });
          recoverable = refundIsRecoverable(payment.providerPaymentRef, tenant?.paystackSubaccountCode);
        }
      }

      const now = new Date();
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updated = await tx.refund.update({
          where: { id: refund.id },
          data: {
            status: body.decision,
            decidedBy: actor,
            decidedAt: now,
            ...(gateway ? { gatewayRefundRef: gateway.refundId, gatewayStatus: gateway.status } : {}),
            ...(recoverable ? { recoveryStatus: "OWED" as const } : {}),
          },
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
          data: { refundRef: updated.id, status: updated.status, decidedBy: actor },
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
