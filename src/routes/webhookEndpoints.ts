import type { FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { createWebhookEndpointSchema } from "../schemas/webhookEndpoints.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { sendProblem, problems } from "../lib/problem.js";

const ROUTE = "POST /provider/webhook-endpoints";

// Registering an endpoint is the missing link in the outbox pipeline:
// queueEvent()/deliverPendingEvents() (see src/lib/webhooks.ts and
// src/worker.ts) have always existed and the worker has always been
// running, but with no route to create a WebhookEndpoint row, every event
// ever queued had zero active endpoints to deliver to and just sat
// PENDING forever. This route is what lets a tenant actually subscribe.
const webhookEndpointRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/webhook-endpoints",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createWebhookEndpointSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      // 32 random bytes, hex-encoded — used as the HMAC-SHA256 signing key
      // in webhooks.ts's signPayload()/verifySignature(). Returned once,
      // here, at creation time; never re-exposed by GET.
      const secret = randomBytes(32).toString("hex");

      const created = await prisma.webhookEndpoint.create({
        data: { tenantId, url: body.url, secret },
      });

      const responseBody = {
        webhookEndpointId: created.id,
        url: created.url,
        secret: created.secret,
        active: created.active,
        createdAt: created.createdAt.toISOString(),
      };
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/webhook-endpoints/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/webhook-endpoints",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const tenantId = request.auth!.tenantId;
      const rows = await prisma.webhookEndpoint.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
      });
      // Secret is deliberately omitted here — it's shown once, at creation.
      const items = rows.map((row: { id: string; url: string; active: boolean; createdAt: Date }) => ({
        webhookEndpointId: row.id,
        url: row.url,
        active: row.active,
        createdAt: row.createdAt.toISOString(),
      }));
      return reply.code(200).send({ items });
    }
  );

  app.delete(
    "/provider/webhook-endpoints/:id",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const tenantId = request.auth!.tenantId;
      const { id } = request.params as { id: string };
      const existing = await prisma.webhookEndpoint.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound("No webhook endpoint with that id for this tenant."));
      }
      await prisma.webhookEndpoint.update({ where: { id }, data: { active: false } });
      return reply.code(204).send();
    }
  );
};

export default webhookEndpointRoutes;
