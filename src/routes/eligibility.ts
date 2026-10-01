import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { eligibilityCheckRequestSchema, listEligibilityChecksQuerySchema } from "../schemas/eligibility.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

const ROUTE = "POST /provider/eligibility-checks";

// No real payer/HMO adapter exists yet (no partner integration is wired
// up — see the TODO this replaces, below). Rather than leave every check
// stuck on PENDING/PENDING forever with nothing for a client to render,
// this resolves it immediately with a deterministic, rule-based stand-in:
// 80% covered by the payer, 20% patient responsibility, valid 30 days.
// Swap this out for a real resolveEligibility(payerRef, serviceCodes)
// call (sync here, or async from a worker that updates the row and fires
// "eligibility.completed" the same way) once an actual payer integration
// exists — nothing else about this route needs to change.
function simulateEligibilityDecision(amountMinor: bigint | null): {
  decision: "ELIGIBLE" | "PARTIALLY_ELIGIBLE";
  coveredAmountMinor: bigint | null;
  patientResponsibilityMinor: bigint | null;
} {
  if (amountMinor == null) {
    return { decision: "ELIGIBLE", coveredAmountMinor: null, patientResponsibilityMinor: null };
  }
  const coveredAmountMinor = (amountMinor * 80n) / 100n;
  const patientResponsibilityMinor = amountMinor - coveredAmountMinor;
  return { decision: "PARTIALLY_ELIGIBLE", coveredAmountMinor, patientResponsibilityMinor };
}

function serializeEligibilityCheck(row: {
  id: string; facilityRef: string; patientRef: string; payerRef: string; status: string;
  decision: string; requestedAt: Date; checkedAt: Date | null; createdAt: Date;
}) {
  return {
    eligibilityId: row.id,
    facilityRef: row.facilityRef,
    patientRef: row.patientRef,
    payerRef: row.payerRef,
    status: row.status,
    decision: row.decision,
    requestedAt: row.requestedAt.toISOString(),
    checkedAt: (row.checkedAt ?? row.createdAt).toISOString(),
  };
}

const eligibilityRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/eligibility-checks",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = eligibilityCheckRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const existing = await prisma.eligibilityCheck.findUnique({
        where: { tenantId_providerRequestRef: { tenantId, providerRequestRef: body.providerRequestRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`providerRequestRef "${body.providerRequestRef}" already exists for this tenant.`, "request_ref_already_exists"));
      }

      const amountMinor = body.amount ? toMinorBigInt(body.amount.amountMinor) : null;
      const resolved = simulateEligibilityDecision(amountMinor);

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.eligibilityCheck.create({
          data: {
            tenantId,
            providerRequestRef: body.providerRequestRef,
            facilityRef: body.facilityRef,
            patientRef: body.patientRef,
            payerRef: body.payerRef,
            serviceCodes: body.serviceCodes,
            requestedAt: new Date(body.requestedAt),
            amountMinor,
            currency: body.amount?.currency ?? null,
            status: "COMPLETE",
            decision: resolved.decision,
            coveredAmountMinor: resolved.coveredAmountMinor,
            patientResponsibilityMinor: resolved.patientResponsibilityMinor,
            validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            checkedAt: new Date(),
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "eligibility.completed",
          resourceRef: row.id,
          data: { eligibilityId: row.id, decision: row.decision },
        });
        return row;
      });

      const responseBody = {
        eligibilityId: created.id,
        status: created.status,
        decision: created.decision,
        reasonCode: created.reasonCode ?? undefined,
        coveredAmount: created.coveredAmountMinor != null ? { amountMinor: toMinorNumber(created.coveredAmountMinor), currency: created.currency ?? "NGN" } : undefined,
        patientResponsibility: created.patientResponsibilityMinor != null ? { amountMinor: toMinorNumber(created.patientResponsibilityMinor), currency: created.currency ?? "NGN" } : undefined,
        validUntil: created.validUntil?.toISOString(),
        checkedAt: (created.checkedAt ?? created.createdAt).toISOString(),
        isPreAuthorization: false,
      };
      await storeIdempotentResponse(prisma, idem, 202, responseBody);
      return reply.code(202).send(responseBody);
    }
  );

  app.get(
    "/provider/eligibility-checks",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listEligibilityChecksQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, limit, cursor } = parsed.data;

      const rows = await prisma.eligibilityCheck.findMany({
        where: { tenantId, ...(facilityRef ? { facilityRef } : {}) },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeEligibilityCheck(row));
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );
};

export default eligibilityRoutes;
