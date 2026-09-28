import type { FastifyPluginAsync } from "fastify";
import { createFamilyFundingRequestSchema } from "../schemas/familyFunding.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const ROUTE = "POST /provider/family-funding-requests";

const familyFundingRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/family-funding-requests",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createFamilyFundingRequestSchema.safeParse(request.body);
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

      const requestedTotal = body.contributions.reduce((sum, c) => sum + c.amountMinor, 0);
      if (requestedTotal > toMinorNumber(invoice.amountMinor) - toMinorNumber(invoice.paidAmountMinor)) {
        return sendProblem(
          reply,
          problems.unprocessable("Requested contributions exceed the invoice's remaining balance.", "contributions_exceed_balance")
        );
      }

      const existing = await prisma.familyFundingRequest.findUnique({
        where: { tenantId_providerRequestRef: { tenantId, providerRequestRef: body.providerRequestRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`providerRequestRef "${body.providerRequestRef}" already exists for this tenant.`, "request_ref_already_exists"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const fundingRequest = await tx.familyFundingRequest.create({
          data: {
            tenantId,
            providerRequestRef: body.providerRequestRef,
            invoiceId: body.invoiceId,
            patientRef: body.patientRef,
            facilityRef: body.facilityRef,
            currency: body.currency,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
            contributions: {
              create: body.contributions.map((c) => ({ sponsorRef: c.sponsorRef, amountMinor: toMinorBigInt(c.amountMinor) })),
            },
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "family.contribution.updated",
          resourceRef: fundingRequest.id,
          data: { requestRef: fundingRequest.id, status: fundingRequest.status },
        });
        return fundingRequest;
      });

      const responseBody = {
        requestId: created.id,
        providerRequestRef: created.providerRequestRef,
        invoiceId: created.invoiceId,
        status: created.status,
        fundedAmountMinor: toMinorNumber(created.fundedAmountMinor),
        createdAt: created.createdAt.toISOString(),
      };
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );
};

export default familyFundingRoutes;
