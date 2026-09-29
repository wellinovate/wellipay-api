import type { FastifyPluginAsync } from "fastify";
import {
  createUnmatchedTransactionSchema,
  listUnmatchedTransactionsQuerySchema,
  matchUnmatchedTransactionSchema,
  flagUnmatchedTransactionExceptionSchema,
} from "../schemas/reconciliation.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/unmatched-transactions";

function serializeTransaction(txn: {
  id: string; source: string; reference: string | null; amountMinor: bigint; currency: string;
  receivedAt: Date; status: string; matchedPaymentId: string | null; note: string | null; createdAt: Date;
}) {
  return {
    transactionId: txn.id,
    source: txn.source,
    reference: txn.reference ?? undefined,
    amountMinor: toMinorNumber(txn.amountMinor),
    currency: txn.currency,
    receivedAt: txn.receivedAt.toISOString(),
    status: txn.status,
    matchedPaymentId: txn.matchedPaymentId ?? undefined,
    note: txn.note ?? undefined,
    createdAt: txn.createdAt.toISOString(),
  };
}

const reconciliationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/unmatched-transactions",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createUnmatchedTransactionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const txn = await tx.unmatchedTransaction.create({
          data: {
            tenantId,
            source: body.source,
            reference: body.reference ?? null,
            amountMinor: toMinorBigInt(body.amountMinor),
            currency: body.currency,
            receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "reconciliation.transaction_received",
          resourceRef: txn.id,
          data: { transactionRef: txn.id, source: txn.source, amountMinor: body.amountMinor },
        });
        return txn;
      });

      const responseBody = serializeTransaction(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/unmatched-transactions/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/unmatched-transactions",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listUnmatchedTransactionsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.unmatchedTransaction.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeTransaction);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.post(
    "/provider/unmatched-transactions/:id/match",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = matchUnmatchedTransactionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const txn = await prisma.unmatchedTransaction.findFirst({ where: { id, tenantId } });
      if (!txn) {
        return sendProblem(reply, problems.notFound());
      }
      if (txn.status !== "UNMATCHED") {
        return sendProblem(reply, problems.conflict(`Transaction is already ${txn.status.toLowerCase()}.`, "transaction_already_decided"));
      }

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const payment = await tx.payment.create({
          data: {
            tenantId,
            providerPaymentRef: `recon-${txn.id}`,
            invoiceId: invoice.id,
            patientRef: invoice.patientRef,
            facilityRef: invoice.facilityRef,
            channel: txn.source,
            reference: txn.reference,
            amountMinor: txn.amountMinor,
            currency: txn.currency,
            occurredAt: txn.receivedAt,
          },
        });

        const newPaidAmount = invoice.paidAmountMinor + txn.amountMinor;
        const newStatus = newPaidAmount >= invoice.amountMinor ? "PAID" : newPaidAmount > 0n ? "PARTIALLY_PAID" : invoice.status;
        const updatedInvoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmountMinor: newPaidAmount, status: newStatus },
        });

        const updatedTxn = await tx.unmatchedTransaction.update({
          where: { id: txn.id },
          data: { status: "MATCHED", matchedPaymentId: payment.id },
        });

        await queueEvent(tx, {
          tenantId,
          eventType: "payment.recorded",
          resourceRef: payment.id,
          data: { paymentRef: payment.id, invoiceId: invoice.id, amountMinor: toMinorNumber(txn.amountMinor), channel: txn.source },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "reconciliation.transaction_matched",
          resourceRef: updatedTxn.id,
          data: { transactionRef: updatedTxn.id, paymentRef: payment.id, invoiceId: invoice.id },
        });

        return { txn: updatedTxn, payment, invoice: updatedInvoice };
      });

      return reply.code(200).send({
        ...serializeTransaction(result.txn),
        payment: {
          paymentId: result.payment.id,
          providerPaymentRef: result.payment.providerPaymentRef,
        },
        invoice: {
          invoiceId: result.invoice.id,
          paidAmountMinor: toMinorNumber(result.invoice.paidAmountMinor),
          status: result.invoice.status,
        },
      });
    }
  );

  app.post(
    "/provider/unmatched-transactions/:id/exception",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = flagUnmatchedTransactionExceptionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const txn = await prisma.unmatchedTransaction.findFirst({ where: { id, tenantId } });
      if (!txn) {
        return sendProblem(reply, problems.notFound());
      }
      if (txn.status !== "UNMATCHED") {
        return sendProblem(reply, problems.conflict(`Transaction is already ${txn.status.toLowerCase()}.`, "transaction_already_decided"));
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updatedTxn = await tx.unmatchedTransaction.update({
          where: { id: txn.id },
          data: { status: "EXCEPTION", note: body.note ?? null },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "reconciliation.transaction_exception",
          resourceRef: updatedTxn.id,
          data: { transactionRef: updatedTxn.id, note: body.note },
        });
        return updatedTxn;
      });

      return reply.code(200).send(serializeTransaction(updated));
    }
  );
};

export default reconciliationRoutes;
