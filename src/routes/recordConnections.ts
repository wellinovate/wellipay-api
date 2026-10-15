import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import {
  CODE_TTL_MINUTES,
  GRANTS_NOTICE,
  MAX_CODE_ATTEMPTS,
  MAX_OPEN_CONNECTIONS,
  canRevoke,
  codeProblem,
  confirmCheck,
  integrationEnvName,
  isPartnerKind,
  nextStep,
  normalizeReference,
  scopeKey,
  type ConnectionKind,
} from "../lib/recordConnections.js";
import { PartnerError, confirmPartnerVerification, partnerReferenceMatches, startPartnerVerification } from "../lib/recordPartner.js";
import {
  confirmRecordConnectionSchema,
  createRecordConnectionSchema,
  providerConnectionsQuerySchema,
  providerRevokeSchema,
  recordConnectionDecisionSchema,
} from "../schemas/recordConnections.js";

const RATE_LIMIT = {
  max: 10,
  timeWindow: "1 minute",
  errorResponseBuilder: (_request: unknown, context: { after: string; statusCode: number }) => {
    const err = new Error(`Rate limit exceeded, retry in ${context.after}.`) as Error & { statusCode?: number };
    err.statusCode = context.statusCode;
    return err;
  },
};

interface ConnectionRow {
  id: string;
  patientAccountId: string;
  tenantId: string;
  kind: ConnectionKind;
  integrationKey: string | null;
  scopeKey: string;
  externalRef: string;
  status: string;
  requestId: string;
  codeAttempts: number;
  codeExpiresAt: Date | null;
  decisionNote: string | null;
  verifiedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

// Every response says what a connection does not do.
function serialize(row: ConnectionRow, integrationName?: string | null) {
  return {
    id: row.id,
    kind: row.kind,
    integrationKey: row.integrationKey ?? undefined,
    integrationName: integrationName ?? undefined,
    reference: row.externalRef,
    status: row.status,
    nextStep: nextStep(row.kind, row.status),
    codeExpiresAt: row.status === "PENDING_VERIFICATION" && row.codeExpiresAt ? row.codeExpiresAt.toISOString() : undefined,
    decisionNote: row.decisionNote ?? undefined,
    verifiedAt: row.verifiedAt?.toISOString(),
    revokedAt: row.revokedAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    grantsRecordAccess: false,
    notice: GRANTS_NOTICE,
  };
}

async function logEvent(
  db: Prisma.TransactionClient | typeof prisma,
  connectionId: string,
  event: string,
  actor: string,
  note?: string | null
) {
  await db.recordConnectionEvent.create({ data: { connectionId, event, actor, ...(note ? { note } : {}) } });
}

function partnerConfig(integration: { key: string; baseUrl: string }) {
  const apiKey = process.env[integrationEnvName(integration.key)];
  return apiKey ? { baseUrl: integration.baseUrl, apiKey } : null;
}

const isUniqueViolation = (err: unknown) => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

const recordConnectionRoutes: FastifyPluginAsync = async (app) => {
  // ---- Patient side ---------------------------------------------------------

  // Systems the patient can connect, plus the provider-number option.
  app.get("/patient/record-integrations", { preHandler: app.requirePatientScope("patient.self.read") }, async (_request, reply) => {
    const rows = await prisma.recordIntegration.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } });
    const items = rows.filter((r) => partnerConfig(r)).map((r) => ({ key: r.key, name: r.name, kind: r.kind }));
    return reply.send({ items, notice: GRANTS_NOTICE });
  });

  app.get("/patient/record-connections", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { patientAccountId } = request.patientAuth!;
    const rows = (await prisma.recordConnection.findMany({ where: { patientAccountId }, orderBy: { createdAt: "desc" }, take: 50 })) as ConnectionRow[];
    const keys = [...new Set(rows.map((r) => r.integrationKey).filter((k): k is string => !!k))];
    const names = new Map((await prisma.recordIntegration.findMany({ where: { key: { in: keys } }, select: { key: true, name: true } })).map((i) => [i.key, i.name]));
    return reply.send({ items: rows.map((r) => serialize(r, r.integrationKey ? names.get(r.integrationKey) : null)), notice: GRANTS_NOTICE });
  });

  app.post(
    "/patient/record-connections",
    { preHandler: app.requirePatientScope("patient.self.write"), config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const { patientAccountId, tenantId } = request.patientAuth!;
      const parsed = createRecordConnectionSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { kind } = parsed.data;
      const ref = normalizeReference(kind, parsed.data.reference);
      if (!ref.ok) return sendProblem(reply, problems.unprocessable(ref.message, "invalid_reference"));

      const open = await prisma.recordConnection.count({ where: { patientAccountId, status: { in: ["PENDING_VERIFICATION", "VERIFIED"] } } });
      if (open >= MAX_OPEN_CONNECTIONS) {
        return sendProblem(reply, problems.conflict(`You can have up to ${MAX_OPEN_CONNECTIONS} connections. Remove one first.`, "too_many_connections"));
      }

      let integrationKey: string | null = null;
      let integration: { key: string; name: string; baseUrl: string } | null = null;
      if (isPartnerKind(kind)) {
        integrationKey = parsed.data.integrationKey ?? (kind === "WELLIRECORD" ? "wellirecord" : null);
        if (!integrationKey) return sendProblem(reply, problems.badRequest("Choose which system to connect.", "integration_required"));
        const found = await prisma.recordIntegration.findUnique({ where: { key: integrationKey } });
        if (!found || found.status !== "ACTIVE" || found.kind !== kind || !partnerConfig(found)) {
          return sendProblem(reply, problems.unprocessable("That system is not available for connection.", "integration_unavailable"));
        }
        integration = found;
      }

      const scope = scopeKey(kind, integrationKey, tenantId);
      const duplicate = await prisma.recordConnection.findFirst({
        where: { patientAccountId, scopeKey: scope, externalRef: ref.value, status: { in: ["PENDING_VERIFICATION", "VERIFIED"] } },
      });
      if (duplicate) return sendProblem(reply, problems.conflict("You already have this connection.", "already_connected"));

      const requestId = randomUUID();
      const created = (await prisma.recordConnection.create({
        data: {
          patientAccountId,
          tenantId,
          kind,
          ...(integrationKey ? { integrationKey } : {}),
          scopeKey: scope,
          externalRef: ref.value,
          requestId,
          ...(isPartnerKind(kind) ? { codeExpiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000) } : {}),
        },
      })) as ConnectionRow;
      const actor = `patient:${patientAccountId}`;
      await logEvent(prisma, created.id, "requested", actor);

      if (integration) {
        try {
          // The partner sends the code to the contact it holds. The answer is the same whether or not the reference exists.
          await startPartnerVerification(partnerConfig(integration)!, { requestId, reference: ref.value });
        } catch (err) {
          await prisma.recordConnection.update({ where: { id: created.id }, data: { status: "EXPIRED" } });
          await logEvent(prisma, created.id, "start_failed", "system", err instanceof PartnerError ? err.message : "unknown");
          return sendProblem(reply, problems.badGateway(`${integration.name} could not be reached. Try again later.`, "partner_unreachable"));
        }
        await logEvent(prisma, created.id, "code_requested", "system");
      }
      return reply.code(201).send(serialize(created, integration?.name));
    }
  );

  app.post(
    "/patient/record-connections/:id/confirm",
    { preHandler: app.requirePatientScope("patient.self.write"), config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const { patientAccountId } = request.patientAuth!;
      const { id } = request.params as { id: string };
      const parsed = confirmRecordConnectionSchema.safeParse(request.body);
      if (!parsed.success) return sendProblem(reply, problems.badRequest("Enter the code.", "invalid_body"));
      const badCode = codeProblem(parsed.data.code);
      if (badCode) return sendProblem(reply, problems.unprocessable(badCode, "invalid_code"));

      const row = (await prisma.recordConnection.findFirst({ where: { id, patientAccountId } })) as ConnectionRow | null;
      if (!row) return sendProblem(reply, problems.notFound());
      if (!isPartnerKind(row.kind)) return sendProblem(reply, problems.conflict("This connection is reviewed by the provider. It has no code.", "not_pending"));

      const check = confirmCheck({ status: row.status, attempts: row.codeAttempts, expiresAt: row.codeExpiresAt, now: new Date() });
      if (!check.ok) {
        if (check.code === "expired" && row.status === "PENDING_VERIFICATION") {
          await prisma.recordConnection.updateMany({ where: { id, status: "PENDING_VERIFICATION" }, data: { status: "EXPIRED" } });
          await logEvent(prisma, id, "expired", "system");
        }
        return sendProblem(reply, problems.conflict(check.message, check.code));
      }

      const integration = row.integrationKey ? await prisma.recordIntegration.findUnique({ where: { key: row.integrationKey } }) : null;
      const cfg = integration && integration.status === "ACTIVE" ? partnerConfig(integration) : null;
      if (!integration || !cfg) return sendProblem(reply, problems.unprocessable("That system is not available for connection.", "integration_unavailable"));

      // Count the attempt before asking, so a slow partner cannot be used to test many codes.
      await prisma.recordConnection.update({ where: { id }, data: { codeAttempts: { increment: 1 } } });

      let result;
      try {
        result = await confirmPartnerVerification(cfg, { requestId: row.requestId, code: parsed.data.code });
      } catch {
        return sendProblem(reply, problems.badGateway(`${integration.name} could not be reached. Try again later.`, "partner_unreachable"));
      }
      if (!result.verified || !partnerReferenceMatches(row.externalRef, result.reference)) {
        await logEvent(prisma, id, "code_rejected", `patient:${patientAccountId}`);
        const left = Math.max(0, MAX_CODE_ATTEMPTS - (row.codeAttempts + 1));
        return sendProblem(reply, problems.unprocessable(left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code is not right. Start the connection again.", "code_not_verified"));
      }

      try {
        const claimed = await prisma.$transaction(async (tx) => {
          const res = await tx.recordConnection.updateMany({
            where: { id, patientAccountId, status: "PENDING_VERIFICATION" },
            data: { status: "VERIFIED", verifiedAt: new Date(), decidedBy: `partner:${integration.key}` },
          });
          if (res.count === 1) await logEvent(tx, id, "verified", `partner:${integration.key}`);
          return res.count === 1;
        });
        if (!claimed) return sendProblem(reply, problems.conflict("This connection is not waiting for a code.", "not_pending"));
      } catch (err) {
        if (isUniqueViolation(err)) {
          return sendProblem(reply, problems.conflict("This identifier is already linked to another WelliPay account. The owner must remove that link first.", "reference_already_linked"));
        }
        throw err;
      }
      const fresh = (await prisma.recordConnection.findUnique({ where: { id } })) as ConnectionRow;
      return reply.send(serialize(fresh, integration.name));
    }
  );

  app.post("/patient/record-connections/:id/revoke", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { patientAccountId } = request.patientAuth!;
    const { id } = request.params as { id: string };
    const row = (await prisma.recordConnection.findFirst({ where: { id, patientAccountId } })) as ConnectionRow | null;
    if (!row) return sendProblem(reply, problems.notFound());
    if (!canRevoke(row.status)) return sendProblem(reply, problems.conflict("This connection is already closed.", "not_revocable"));
    const updated = (await prisma.recordConnection.update({ where: { id }, data: { status: "REVOKED", revokedAt: new Date() } })) as ConnectionRow;
    await logEvent(prisma, id, "revoked", `patient:${patientAccountId}`);
    return reply.send(serialize(updated));
  });

  // ---- Provider side --------------------------------------------------------

  app.get("/provider/record-connections", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const parsed = providerConnectionsQuerySchema.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest("Invalid filter.", "invalid_query"));
    const rows = (await prisma.recordConnection.findMany({
      where: { tenantId, ...(parsed.data.status ? { status: parsed.data.status } : {}), ...(parsed.data.kind ? { kind: parsed.data.kind } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    })) as ConnectionRow[];
    const accounts = await prisma.patientAccount.findMany({ where: { id: { in: rows.map((r) => r.patientAccountId) } }, select: { id: true, patientRef: true } });
    const refById = new Map(accounts.map((a) => [a.id, a.patientRef]));
    const records = await prisma.patientRecord.findMany({
      where: { tenantId, patientRef: { in: [...refById.values()] } },
      select: { patientRef: true, fullName: true, phone: true },
    });
    const byRef = new Map(records.map((r) => [r.patientRef, r]));
    return reply.send({
      items: rows.map((r) => {
        const patientRef = refById.get(r.patientAccountId);
        const record = patientRef ? byRef.get(patientRef) : undefined;
        return { ...serialize(r), patientRef, patientName: record?.fullName, patientPhone: record?.phone ?? undefined };
      }),
      notice: GRANTS_NOTICE,
    });
  });

  // Approving says the patient number on this card belongs to this patient. The
  // reviewer compares the name and phone on the registry with the patient number
  // in the facility's own system.
  app.patch("/provider/record-connections/:id/decision", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const parsed = recordConnectionDecisionSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const row = (await prisma.recordConnection.findFirst({ where: { id, tenantId } })) as ConnectionRow | null;
    if (!row) return sendProblem(reply, problems.notFound());
    if (row.kind !== "PROVIDER_PATIENT_NUMBER") return sendProblem(reply, problems.conflict("Only patient-number connections are reviewed by the provider.", "not_reviewable"));
    if (row.status !== "PENDING_VERIFICATION") return sendProblem(reply, problems.conflict("This request has already been decided.", "already_decided"));
    const actor = resolveActor(request.auth, undefined) ?? "provider";
    const approve = parsed.data.decision === "APPROVE";
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const res = await tx.recordConnection.updateMany({
          where: { id, tenantId, status: "PENDING_VERIFICATION" },
          data: {
            status: approve ? "VERIFIED" : "REJECTED",
            decidedBy: actor,
            ...(parsed.data.note ? { decisionNote: parsed.data.note } : {}),
            ...(approve ? { verifiedAt: new Date() } : {}),
          },
        });
        if (res.count !== 1) return null;
        await logEvent(tx, id, approve ? "approved" : "rejected", actor, parsed.data.note);
        return tx.recordConnection.findUnique({ where: { id } });
      });
      if (!updated) return sendProblem(reply, problems.conflict("This request has already been decided.", "already_decided"));
      return reply.send(serialize(updated as ConnectionRow));
    } catch (err) {
      if (isUniqueViolation(err)) {
        return sendProblem(reply, problems.conflict("This patient number is already verified for another patient. Revoke that link first.", "reference_already_linked"));
      }
      throw err;
    }
  });

  app.post("/provider/record-connections/:id/revoke", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const parsed = providerRevokeSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, problems.badRequest("Invalid note.", "invalid_body"));
    const row = (await prisma.recordConnection.findFirst({ where: { id, tenantId } })) as ConnectionRow | null;
    if (!row) return sendProblem(reply, problems.notFound());
    if (!canRevoke(row.status)) return sendProblem(reply, problems.conflict("This connection is already closed.", "not_revocable"));
    const actor = resolveActor(request.auth, undefined) ?? "provider";
    const updated = (await prisma.recordConnection.update({
      where: { id },
      data: { status: "REVOKED", revokedAt: new Date(), ...(parsed.data.note ? { decisionNote: parsed.data.note } : {}) },
    })) as ConnectionRow;
    await logEvent(prisma, id, "revoked", actor, parsed.data.note);
    return reply.send(serialize(updated));
  });
};

export default recordConnectionRoutes;
