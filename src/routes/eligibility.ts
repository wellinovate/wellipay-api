import type { FastifyPluginAsync } from "fastify";
import { eligibilityCheckRequestSchema, listEligibilityChecksQuerySchema } from "../schemas/eligibility.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

const ROUTE = "POST /provider/eligibility-checks";

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

      // NOTE: no payer connection is wired up yet — the contract's own open
      // decisions list ("Which HMO/insurance source can provide eligibility")
      // is still unresolved. This persists the request as PENDING and
      // returns 202, matching the OpenAPI response ("result may arrive
      // asynchronously"). Wiring a real payer adapter means: implement it
      // behind a resolveEligibility(payerRef, serviceCodes) interface, call
      // it here or from a worker, then update the row and emit an
      // "eligibility.completed" event via queueEvent() — nothing else in
      // this route needs to change.
      const created = await prisma.eligibilityCheck.create({
        data: {
          tenantId,
          providerRequestRef: body.providerRequestRef,
          facilityRef: body.facilityRef,
          patientRef: body.patientRef,
          payerRef: body.payerRef,
          serviceCodes: body.serviceCodes,
          requestedAt: new Date(body.requestedAt),
          amountMinor: body.amount ? toMinorBigInt(body.amount.amountMinor) : null,
          currency: body.amount?.currency ?? null,
          status: "PENDING",
          decision: "PENDING",
        },
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
