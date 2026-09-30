import type { FastifyPluginAsync } from "fastify";
import { financialConsentRequestSchema, listFinancialConsentsQuerySchema } from "../schemas/consents.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const ROUTE = "POST /provider/financial-consents";

function serializeConsent(row: {
  id: string; facilityRef: string; patientRef: string; invoiceId: string; status: string; recordedAt: Date;
}) {
  return {
    consentId: row.id,
    facilityRef: row.facilityRef,
    patientRef: row.patientRef,
    invoiceId: row.invoiceId,
    status: row.status,
    recordedAt: row.recordedAt.toISOString(),
  };
}

const consentRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/financial-consents",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = financialConsentRequestSchema.safeParse(request.body);
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

      const splitTotal = body.payerSplit.reduce((sum, s) => sum + s.amountMinor, 0);
      if (BigInt(splitTotal) !== invoice.amountMinor) {
        return sendProblem(
          reply,
          problems.unprocessable(
            `payerSplit totals ${splitTotal} but the invoice amount is ${invoice.amountMinor}. The consented split must account for the full invoice.`,
            "split_does_not_match_invoice"
          )
        );
      }

      const existing = await prisma.financialConsent.findUnique({
        where: { tenantId_providerConsentRef: { tenantId, providerConsentRef: body.providerConsentRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`providerConsentRef "${body.providerConsentRef}" already exists for this tenant.`, "consent_ref_already_exists"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const consent = await tx.financialConsent.create({
          data: {
            tenantId,
            providerConsentRef: body.providerConsentRef,
            facilityRef: body.facilityRef,
            patientRef: body.patientRef,
            invoiceId: body.invoiceId,
            estimateRevision: body.estimateRevision,
            policyVersion: body.policyVersion,
            acceptedAt: new Date(body.acceptedAt),
            actorRef: body.actorRef ?? null,
            payerSplit: {
              create: body.payerSplit.map((s) => ({
                payerType: s.payerType,
                payerRef: s.payerRef ?? null,
                amountMinor: toMinorBigInt(s.amountMinor),
                currency: s.currency,
              })),
            },
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "consent.recorded",
          resourceRef: consent.id,
          data: { consentRef: consent.id, invoiceId: body.invoiceId },
        });
        return consent;
      });

      const responseBody = {
        consentId: created.id,
        providerConsentRef: created.providerConsentRef,
        status: created.status,
        recordedAt: created.recordedAt.toISOString(),
      };
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );

  app.get(
    "/provider/financial-consents",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listFinancialConsentsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, limit, cursor } = parsed.data;

      const rows = await prisma.financialConsent.findMany({
        where: { tenantId, ...(facilityRef ? { facilityRef } : {}) },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeConsent(row));
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );
};

export default consentRoutes;
