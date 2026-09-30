import type { FastifyPluginAsync } from "fastify";
import { listEventsQuerySchema } from "../schemas/events.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";

function serializeEvent(row: {
  id: string; eventType: string; resourceRef: string; occurredAt: Date; data: unknown;
}) {
  return {
    eventId: row.id,
    eventType: row.eventType,
    resourceRef: row.resourceRef,
    occurredAt: row.occurredAt.toISOString(),
    data: row.data,
  };
}

// Read-only feed of the OutboxEvent log (payments, refunds, claims,
// settlements, staff changes, etc.) — the same events that drive outbound
// webhooks, exposed here so the provider frontend can show a real
// notification stream instead of an invented one. No delivery-internal
// fields (status/attempts/lastError) are exposed — those describe webhook
// delivery mechanics, not the business event itself.
const eventsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/provider/events",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listEventsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { eventType, limit, cursor } = parsed.data;

      const rows = await prisma.outboxEvent.findMany({
        where: { tenantId, ...(eventType ? { eventType } : {}) },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeEvent(row));
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );
};

export default eventsRoutes;
