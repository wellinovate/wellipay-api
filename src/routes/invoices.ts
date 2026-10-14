import type { FastifyPluginAsync } from "fastify";
import { createInvoiceSchema, listInvoicesQuerySchema } from "../schemas/invoices.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import { Prisma } from "@prisma/client";
import { linesProblem } from "../lib/invoiceLines.js";

const ROUTE = "POST /provider/invoices";

interface LineRow {
  id: string; position: number; description: string; quantity: number; unitPriceMinor: number; serviceItemId: string | null;
}

function serializeInvoice(invoice: {
  id: string; providerInvoiceRef: string; facilityRef: string; patientRef: string; description: string;
  amountMinor: bigint; currency: string; paidAmountMinor: bigint; status: string; mobileDeliveryStatus: string;
  dueAt: Date | null; metadata: unknown; corporateAccountId?: string | null; createdAt: Date; updatedAt: Date;
  lines?: LineRow[] | undefined;
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
    corporateAccountId: invoice.corporateAccountId ?? undefined,
    lines: invoice.lines && invoice.lines.length > 0
      ? [...invoice.lines].sort((a, b) => a.position - b.position).map((l) => ({
          lineId: l.id,
          description: l.description,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          lineTotalMinor: l.quantity * l.unitPriceMinor,
          serviceItemId: l.serviceItemId ?? undefined,
        }))
      : undefined,
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

      if (body.corporateAccountId) {
        const account = await prisma.corporateAccount.findFirst({ where: { id: body.corporateAccountId, tenantId } });
        if (!account) {
          return sendProblem(reply, problems.unprocessable(`corporateAccountId "${body.corporateAccountId}" does not exist for this tenant.`, "unknown_corporate_account"));
        }
        if (!account.active) {
          return sendProblem(reply, problems.conflict(`"${account.name}" is switched off.`, "corporate_account_inactive"));
        }
      }

      if (body.lines) {
        const problem = linesProblem(body.lines, body.amountMinor);
        if (problem) return sendProblem(reply, problems.unprocessable(problem, "lines_total_mismatch"));
      }

      const invoice = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.invoice.create({
          data: {
            tenantId,
            corporateAccountId: body.corporateAccountId ?? null,
            providerInvoiceRef: body.providerInvoiceRef,
            facilityRef: body.facilityRef,
            patientRef: body.patientRef,
            description: body.description,
            amountMinor: toMinorBigInt(body.amountMinor),
            currency: body.currency,
            dueAt: body.dueAt ? new Date(body.dueAt) : null,
            metadata: body.metadata ?? Prisma.JsonNull,
          },
        });
        if (body.lines) {
          await tx.invoiceLine.createMany({
            data: body.lines.map((l, i) => ({
              tenantId,
              invoiceId: created.id,
              position: i,
              description: l.description,
              quantity: l.quantity,
              unitPriceMinor: l.unitPriceMinor,
              ...(l.serviceItemId !== undefined ? { serviceItemId: l.serviceItemId } : {}),
            })),
          });
        }
        await queueEvent(tx, {
          tenantId,
          eventType: "invoice.delivered",
          resourceRef: created.id,
          data: { invoiceRef: created.id, providerInvoiceRef: created.providerInvoiceRef },
        });
        return tx.invoice.findUniqueOrThrow({ where: { id: created.id }, include: { lines: true } });
      });

      const responseBody = serializeInvoice(invoice);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/invoices/${invoice.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/invoices",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listInvoicesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, patientRef, status, limit, cursor } = parsed.data;

      const rows = await prisma.invoice.findMany({
        where: {
          tenantId,
          ...(facilityRef ? { facilityRef } : {}),
          ...(patientRef ? { patientRef } : {}),
          ...(status ? { status } : {}),
        },
        include: { lines: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeInvoice);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.get(
    "/provider/invoices/:invoiceId",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const { invoiceId } = request.params as { invoiceId: string };
      const tenantId = request.auth!.tenantId;

      const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { lines: true } });
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
