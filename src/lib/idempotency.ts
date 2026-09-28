import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { sendProblem, problems } from "./problem.js";

// Implements "Every write requires an Idempotency-Key. Reusing a key with a
// different request body returns 409 Conflict" from the contract doc.
//
// Usage in a route handler:
//   const idem = await checkIdempotency(prisma, request, reply, route);
//   if (idem.replayed) return; // response already sent from the stored record
//   ... do the write ...
//   await storeIdempotentResponse(prisma, idem, statusCode, body);

export interface IdempotencyContext {
  tenantId: string;
  key: string;
  route: string;
  requestHash: string;
  replayed: boolean;
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

export async function checkIdempotency(
  prisma: PrismaClient,
  request: FastifyRequest,
  reply: FastifyReply,
  route: string
): Promise<IdempotencyContext | undefined> {
  const key = request.headers["idempotency-key"];
  const tenantId = request.auth?.tenantId;
  if (!tenantId) {
    // auth plugin should always run first; this is a defensive check.
    sendProblem(reply, problems.unauthorized());
    return undefined;
  }
  if (typeof key !== "string" || key.length < 16 || key.length > 128) {
    sendProblem(reply, problems.badRequest("Idempotency-Key header is required and must be 16-128 characters.", "missing_idempotency_key"));
    return undefined;
  }

  const requestHash = hashBody(request.body);
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { tenantId_route_key: { tenantId, route, key } },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      sendProblem(reply, problems.conflict("Idempotency-Key was reused with a different request body.", "idempotency_key_reused"));
      return undefined;
    }
    // Exact replay: return the originally stored response verbatim.
    reply.code(existing.responseStatus).send(existing.responseBody);
    return { tenantId, key, route, requestHash, replayed: true };
  }

  return { tenantId, key, route, requestHash, replayed: false };
}

export async function storeIdempotentResponse(
  prisma: PrismaClient,
  ctx: IdempotencyContext,
  responseStatus: number,
  responseBody: unknown
): Promise<void> {
  await prisma.idempotencyRecord.create({
    data: {
      tenantId: ctx.tenantId,
      key: ctx.key,
      route: ctx.route,
      requestHash: ctx.requestHash,
      responseStatus,
      responseBody: responseBody as object,
    },
  });
}
