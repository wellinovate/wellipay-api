import type { FastifyPluginAsync } from "fastify";
import { createFinancingRecordSchema, listFinancingRecordsQuerySchema } from "../schemas/financing.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/financing-records";

function serializeFinancingRecord(row: {
  id: string; invoiceId: string; paymentId: string; lenderName: string;
  termMonths: number | null; amountMinor: bigint; createdAt: Date;
}) {
  return {
    financingRecordId: row.id,
    invoiceId: row.invoiceId,
    paymentId: row.paymentId,
    lenderName: row.lenderName,
    termMonths: row.termMonths ?? undefined,
    amountMinor: toMinorNumber(row.amountMinor),
    createdAt: row.createdAt.toISOString(),
  };
}

const financingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/financing-records",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createFinancingRecordSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }
      const remaining = (invoice.amountMinor - invoice.paidAmountMinor) as unknown as bigint;
      if (remaining <= 0n) {
        return sendProblem(reply, problems.conflict("Invoice has no remaining balance to finance.", "nothing_to_finance"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const payment = await tx.payment.create({
          data: {
            tenantId,
            providerPaymentRef: `financing-${invoice.id}-${Date.now()}`,
            invoiceId: invoice.id,
            patientRef: invoice.patientRef,
            facilityRef: invoice.facilityRef,
            channel: "financing",
            amountMinor: remaining,
          },
        });
        const newPaidAmount = invoice.paidAmountMinor + remaining;
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmountMinor: newPaidAmount, status: "PAID" },
        });
        const record = await tx.financingRecord.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            paymentId: payment.id,
            lenderName: body.lenderName,
            termMonths: body.termMonths ?? null,
            amountMinor: remaining,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "financing.recorded",
          resourceRef: record.id,
          data: { financingRecordId: record.id, invoiceId: invoice.id, lenderName: body.lenderName, amountMinor: toMinorNumber(remaining) },
        });
        return record;
      });

      const responseBody = serializeFinancingRecord(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/financing-records/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/financing-records",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listFinancingRecordsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { invoiceId, limit, cursor } = parsed.data;

      const rows = await prisma.financingRecord.findMany({
        where: { tenantId, ...(invoiceId ? { invoiceId } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeFinancingRecord(row));
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );
};

export default financingRoutes;
