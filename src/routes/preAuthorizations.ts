import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  patientCreatePreAuthSchema,
  patientListPreAuthQuerySchema,
  listPreAuthQuerySchema,
  updatePreAuthSchema,
} from "../schemas/preAuthorizations.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

// See the schema comment on PreAuthorization: no real payer integration
// exists yet, so every request is resolved instantly by splitting the
// estimate against the policy's own coPayPercent. Mirrors
// eligibility.ts's simulateEligibilityDecision.
function resolvePreAuth(estimatedCostMinor: bigint, coPayPercent: number) {
  const patientPortionMinor = (estimatedCostMinor * BigInt(coPayPercent)) / 100n;
  const coveredAmountMinor = estimatedCostMinor - patientPortionMinor;
  const approvalCode = `AUTH-${Math.floor(1000 + Math.random() * 9000)}`;
  return { patientPortionMinor, coveredAmountMinor, approvalCode };
}

function serializePreAuth(row: {
  id: string; patientRef: string; hmoPolicyId: string; facilityRef: string; procedure: string;
  estimatedCostMinor: bigint; coveredAmountMinor: bigint; patientPortionMinor: bigint; currency: string;
  status: string; approvalCode: string | null; notes: string | null; requestedAt: Date; createdAt: Date;
}) {
  return {
    preAuthId: row.id,
    patientRef: row.patientRef,
    hmoPolicyId: row.hmoPolicyId,
    facilityRef: row.facilityRef,
    procedure: row.procedure,
    estimatedCost: { amountMinor: toMinorNumber(row.estimatedCostMinor), currency: row.currency },
    coveredAmount: { amountMinor: toMinorNumber(row.coveredAmountMinor), currency: row.currency },
    patientPortion: { amountMinor: toMinorNumber(row.patientPortionMinor), currency: row.currency },
    status: row.status,
    approvalCode: row.approvalCode ?? undefined,
    notes: row.notes ?? undefined,
    requestedAt: row.requestedAt.toISOString(),
  };
}

const preAuthorizationRoutes: FastifyPluginAsync = async (app) => {
  // Patient requests a pre-auth for a planned procedure (PreAuthScreen's
  // "Request Instant Approval"). hmoPolicyId must be one of the caller's
  // own policies — never trust patientRef from the body.
  const PATIENT_CREATE_ROUTE = "POST /patient/pre-authorizations";
  app.post(
    "/patient/pre-authorizations",
    { preHandler: app.requirePatientScope("patient.self.write") },
    async (request, reply) => {
      const parsed = patientCreatePreAuthSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, PATIENT_CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const policy = await prisma.hmoPolicy.findFirst({ where: { id: body.hmoPolicyId, tenantId, patientRef } });
      if (!policy) {
        return sendProblem(reply, problems.unprocessable(`hmoPolicyId "${body.hmoPolicyId}" does not exist on your account.`, "unknown_hmo_policy"));
      }

      const estimatedCostMinor = toMinorBigInt(body.estimatedCostMinor);
      const resolved = resolvePreAuth(estimatedCostMinor, policy.coPayPercent);

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.preAuthorization.create({
          data: {
            tenantId,
            patientRef,
            hmoPolicyId: policy.id,
            facilityRef: body.facilityRef,
            procedure: body.procedure,
            estimatedCostMinor,
            coveredAmountMinor: resolved.coveredAmountMinor,
            patientPortionMinor: resolved.patientPortionMinor,
            currency: policy.currency,
            approvalCode: resolved.approvalCode,
            notes: `Pre-authorization approved by ${policy.provider}. Valid for 14 days.`,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "pre_authorization.created",
          resourceRef: row.id,
          data: { preAuthId: row.id, patientRef: row.patientRef, status: row.status },
        });
        return row;
      });

      const responseBody = serializePreAuth(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );

  app.get(
    "/patient/pre-authorizations",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListPreAuthQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.preAuthorization.findMany({
        where: { tenantId, patientRef, ...(status ? { status } : {}) },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializePreAuth);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.get(
    "/provider/pre-authorizations",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listPreAuthQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { patientRef, hmoPolicyId, status, limit, cursor } = parsed.data;

      const rows = await prisma.preAuthorization.findMany({
        where: {
          tenantId,
          ...(patientRef ? { patientRef } : {}),
          ...(hmoPolicyId ? { hmoPolicyId } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializePreAuth);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  // Staff-only override — see the schema comment on updatePreAuthSchema.
  app.patch(
    "/provider/pre-authorizations/:id",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updatePreAuthSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const existing = await prisma.preAuthorization.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound());
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.preAuthorization.update({
          where: { id: existing.id },
          data: {
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.notes !== undefined ? { notes: body.notes } : {}),
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "pre_authorization.updated",
          resourceRef: row.id,
          data: { preAuthId: row.id, patientRef: row.patientRef, status: row.status },
        });
        return row;
      });

      return reply.code(200).send(serializePreAuth(updated));
    }
  );
};

export default preAuthorizationRoutes;
