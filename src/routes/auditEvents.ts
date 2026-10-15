import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { clampLimit, makeCursor, parseCursor } from "../lib/auditTrail.js";

const auditEventRoutes: FastifyPluginAsync = async (app) => {
  // The saved audit trail, newest first. Admin and Finance only.
  app.get("/provider/audit-events", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const q = request.query as Record<string, unknown>;
    const limit = clampLimit(q.limit);
    const cursor = parseCursor(q.cursor);
    const actor = typeof q.actor === "string" ? q.actor.trim().slice(0, 80) : "";
    const text = typeof q.q === "string" ? q.q.trim().slice(0, 80) : "";

    const rows = await prisma.auditEvent.findMany({
      where: {
        tenantId,
        ...(actor ? { actorName: { contains: actor, mode: "insensitive" as const } } : {}),
        ...(text ? { action: { contains: text, mode: "insensitive" as const } } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }] } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return reply.send({
      items: page.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        actorType: r.actorType,
        actorId: r.actorId ?? undefined,
        actorName: r.actorName ?? undefined,
        action: r.action,
        method: r.method,
        route: r.route,
        resourceId: r.resourceId ?? undefined,
        statusCode: r.statusCode,
      })),
      nextCursor: rows.length > limit ? makeCursor(page[page.length - 1]!) : undefined,
    });
  });
};

export default auditEventRoutes;
