import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  patientCreateHmoPolicySchema,
  providerCreateHmoPolicySchema,
  listHmoPoliciesQuerySchema,
  patientListHmoPoliciesQuerySchema,
  updateHmoPolicySchema,
} from "../schemas/hmoPolicies.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

function serializeHmoPolicy(row: {
  id: string; patientRef: string; provider: string; policyNo: string; enrolleeName: string;
  planTier: string; coPayPercent: number; annualLimitMinor: bigint; usedAmountMinor: bigint;
  currency: string; status: string; expiryDate: Date | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    hmoPolicyId: row.id,
    patientRef: row.patientRef,
    provider: row.provider,
    policyNo: row.policyNo,
    enrolleeName: row.enrolleeName,
    planTier: row.planTier,
    coPayPercent: row.coPayPercent,
    annualLimit: { amountMinor: toMinorNumber(row.annualLimitMinor), currency: row.currency },
    usedAmount: { amountMinor: toMinorNumber(row.usedAmountMinor), currency: row.currency },
    status: row.status,
    expiryDate: row.expiryDate ? row.expiryDate.toISOString() : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const hmoPolicyRoutes: FastifyPluginAsync = async (app) => {
  // Provider staff record a patient's HMO card (at the desk, from a
  // photographed card, during registration).
  const PROVIDER_CREATE_ROUTE = "POST /provider/hmo-policies";
  app.post(
    "/provider/hmo-policies",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = providerCreateHmoPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, PROVIDER_CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const existing = await prisma.hmoPolicy.findUnique({
        where: { tenantId_patientRef_policyNo: { tenantId, patientRef: body.patientRef, policyNo: body.policyNo } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`A policy with policyNo "${body.policyNo}" already exists for this patient.`, "policy_already_exists"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.hmoPolicy.create({
          data: {
            tenantId,
            patientRef: body.patientRef,
            provider: body.provider,
            policyNo: body.policyNo,
            enrolleeName: body.enrolleeName,
            planTier: body.planTier,
            coPayPercent: body.coPayPercent,
            annualLimitMinor: toMinorBigInt(body.annualLimitMinor),
            currency: body.currency,
            expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "hmo_policy.created",
          resourceRef: row.id,
          data: { hmoPolicyId: row.id, patientRef: row.patientRef },
        });
        return row;
      });

      const responseBody = serializeHmoPolicy(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );

  app.get(
    "/provider/hmo-policies",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listHmoPoliciesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { patientRef, status, limit, cursor } = parsed.data;

      const rows = await prisma.hmoPolicy.findMany({
        where: { tenantId, ...(patientRef ? { patientRef } : {}), ...(status ? { status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeHmoPolicy);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  // Staff-only adjustments: deactivate/expire, correct co-pay or limit, or
  // move usedAmountMinor when a claim settles against this policy.
  app.patch(
    "/provider/hmo-policies/:id",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateHmoPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const existing = await prisma.hmoPolicy.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound());
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.hmoPolicy.update({
          where: { id: existing.id },
          data: {
            ...(body.status !== undefined ? { status: body.status } : {}),
            ...(body.coPayPercent !== undefined ? { coPayPercent: body.coPayPercent } : {}),
            ...(body.annualLimitMinor !== undefined ? { annualLimitMinor: toMinorBigInt(body.annualLimitMinor) } : {}),
            ...(body.usedAmountMinor !== undefined ? { usedAmountMinor: toMinorBigInt(body.usedAmountMinor) } : {}),
            ...(body.expiryDate !== undefined ? { expiryDate: new Date(body.expiryDate) } : {}),
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "hmo_policy.updated",
          resourceRef: row.id,
          data: { hmoPolicyId: row.id, patientRef: row.patientRef },
        });
        return row;
      });

      return reply.code(200).send(serializeHmoPolicy(updated));
    }
  );

  // Patient self-service: the "+ Add HMO Card" flow in the app
  // (AddHmoScreen). patientRef is taken from the caller's token, never the
  // body — same rule as POST /patient/financial-consents.
  const PATIENT_CREATE_ROUTE = "POST /patient/hmo-policies";
  app.post(
    "/patient/hmo-policies",
    { preHandler: app.requirePatientScope("patient.self.write") },
    async (request, reply) => {
      const parsed = patientCreateHmoPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, PATIENT_CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const existing = await prisma.hmoPolicy.findUnique({
        where: { tenantId_patientRef_policyNo: { tenantId, patientRef, policyNo: body.policyNo } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`A policy with policyNo "${body.policyNo}" already exists for your account.`, "policy_already_exists"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.hmoPolicy.create({
          data: {
            tenantId,
            patientRef,
            provider: body.provider,
            policyNo: body.policyNo,
            enrolleeName: body.enrolleeName,
            planTier: body.planTier,
            coPayPercent: body.coPayPercent,
            annualLimitMinor: toMinorBigInt(body.annualLimitMinor),
            currency: body.currency,
            expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "hmo_policy.created",
          resourceRef: row.id,
          data: { hmoPolicyId: row.id, patientRef: row.patientRef },
        });
        return row;
      });

      const responseBody = serializeHmoPolicy(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );

  app.get(
    "/patient/hmo-policies",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListHmoPoliciesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.hmoPolicy.findMany({
        where: { tenantId, patientRef, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeHmoPolicy);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );
};

export default hmoPolicyRoutes;
