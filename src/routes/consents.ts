import type { FastifyPluginAsync } from "fastify";
import { financialConsentRequestSchema } from "../schemas/consents.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const ROUTE = "POST /provider/financial-consents";

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
            actorRef: body.actorRef,
            payerSplit: {
              create: body.payerSplit.map((s) => ({
                payerType: s.payerType,
                payerRef: s.payerRef,
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
};

export default consentRoutes;
