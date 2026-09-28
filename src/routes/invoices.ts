import type { FastifyPluginAsync } from "fastify";
import { createInvoiceSchema } from "../schemas/invoices.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const ROUTE = "POST /provider/invoices";

function serializeInvoice(invoice: {
  id: string; providerInvoiceRef: string; facilityRef: string; patientRef: string; description: string;
  amountMinor: bigint; currency: string; paidAmountMinor: bigint; status: string; mobileDeliveryStatus: string;
  dueAt: Date | null; metadata: unknown; createdAt: Date; updatedAt: Date;
}) {
  return {
    invoiceId: invoice.id,
    providerInvoiceRef: invoice.providerInvoiceRef,
    facilityRef: invoice.facilityRef,
    patientRef: invoice.patientRef,
    description: invoice.description,
    amountMinor: toMinorNumber(invoice.amountMinor),
    currency: invoice.currency,
    paidAmountMinor: toMinorNumber(invoice.paidAmountMinor),
    status: invoice.status,
    mobileDeliveryStatus: invoice.mobileDeliveryStatus,
    dueAt: invoice.dueAt?.toISOString(),
    metadata: invoice.metadata ?? undefined,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}

const invoiceRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/invoices",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createInvoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;

      const idem = await checkIdempotency(prisma, request, reply, ROUTE);
      if (!idem) return; // problem already sent
      if (idem.replayed) return; // stored response already sent

      const body = parsed.data;

      // Belt-and-suspenders uniqueness independent of the Idempotency-Key:
      // the same (tenant, providerInvoiceRef) must always resolve to one invoice.
      const existing = await prisma.invoice.findUnique({
        where: { tenantId_providerInvoiceRef: { tenantId, providerInvoiceRef: body.providerInvoiceRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(
          `providerInvoiceRef "${body.providerInvoiceRef}" already exists for this tenant. Fetch it via GET /provider/invoices/${existing.id} instead of re-creating it.`,
          "invoice_ref_already_exists"
        ));
      }

      const invoice = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.invoice.create({
          data: {
            tenantId,
            providerInvoiceRef: body.providerInvoiceRef,
            facilityRef: body.facilityRef,
            patientRef: body.patientRef,
            description: body.description,
            amountMinor: toMinorBigInt(body.amountMinor),
            currency: body.currency,
            dueAt: body.dueAt ? new Date(body.dueAt) : null,
            metadata: body.metadata ?? null,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "invoice.delivered",
          resourceRef: created.id,
          data: { invoiceRef: created.id, providerInvoiceRef: created.providerInvoiceRef },
        });
        return created;
      });

      const responseBody = serializeInvoice(invoice);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/invoices/${invoice.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/invoices/:invoiceId",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const { invoiceId } = request.params as { invoiceId: string };
      const tenantId = request.auth!.tenantId;

      const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId } });
      if (!invoice) {
        // Same 404 whether the invoice doesn't exist or belongs to another
        // tenant — per the contract, resource existence is never confirmed
        // outside the credential's own tenant.
        return sendProblem(reply, problems.notFound());
      }
      return reply.code(200).send(serializeInvoice(invoice));
    }
  );
};

export default invoiceRoutes;
