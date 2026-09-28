import type { FastifyPluginAsync } from "fastify";
import { createPaymentSchema, listPaymentsQuerySchema } from "../schemas/payments.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const ROUTE = "POST /provider/payments";

function serializePayment(payment: {
  id: string; providerPaymentRef: string; invoiceId: string; patientRef: string; facilityRef: string;
  channel: string; reference: string | null; amountMinor: bigint; currency: string; status: string;
  occurredAt: Date; createdAt: Date;
}) {
  return {
    paymentId: payment.id,
    providerPaymentRef: payment.providerPaymentRef,
    invoiceId: payment.invoiceId,
    patientRef: payment.patientRef,
    facilityRef: payment.facilityRef,
    channel: payment.channel,
    reference: payment.reference ?? undefined,
    amountMinor: toMinorNumber(payment.amountMinor),
    currency: payment.currency,
    status: payment.status,
    occurredAt: payment.occurredAt.toISOString(),
    createdAt: payment.createdAt.toISOString(),
  };
}

const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/payments",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createPaymentSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }

      const existing = await prisma.payment.findUnique({
        where: { tenantId_providerPaymentRef: { tenantId, providerPaymentRef: body.providerPaymentRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(
          `providerPaymentRef "${body.providerPaymentRef}" already exists for this tenant.`,
          "payment_ref_already_exists"
        ));
      }

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const amountMinor = toMinorBigInt(body.amountMinor);
        const payment = await tx.payment.create({
          data: {
            tenantId,
            providerPaymentRef: body.providerPaymentRef,
            invoiceId: invoice.id,
            patientRef: invoice.patientRef,
            facilityRef: invoice.facilityRef,
            channel: body.channel,
            reference: body.reference ?? null,
            amountMinor,
            currency: body.currency,
            occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
          },
        });

        const newPaidAmount = invoice.paidAmountMinor + amountMinor;
        const newStatus = newPaidAmount >= invoice.amountMinor ? "PAID" : newPaidAmount > 0n ? "PARTIALLY_PAID" : invoice.status;
        const updatedInvoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmountMinor: newPaidAmount, status: newStatus },
        });

        await queueEvent(tx, {
          tenantId,
          eventType: "payment.recorded",
          resourceRef: payment.id,
          data: { paymentRef: payment.id, invoiceId: invoice.id, amountMinor: body.amountMinor, channel: body.channel },
        });

        return { payment, invoice: updatedInvoice };
      });

      const responseBody = {
        ...serializePayment(result.payment),
        invoice: {
          invoiceId: result.invoice.id,
          paidAmountMinor: toMinorNumber(result.invoice.paidAmountMinor),
          status: result.invoice.status,
        },
      };
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/payments/${result.payment.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/payments",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listPaymentsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, patientRef, invoiceId, status, limit, cursor } = parsed.data;

      const rows = await prisma.payment.findMany({
        where: {
          tenantId,
          ...(facilityRef ? { facilityRef } : {}),
          ...(patientRef ? { patientRef } : {}),
          ...(invoiceId ? { invoiceId } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializePayment);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );
};

export default paymentRoutes;
