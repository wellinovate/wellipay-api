import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { describeAction, resourceIdFrom, shouldAudit } from "../lib/auditTrail.js";
import { recordAudit } from "../lib/auditWriter.js";

// Records every successful write under /provider/* after the response is sent,
// so a slow database never delays the caller. Bodies are not stored.
const auditTrailPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onResponse", async (request, reply) => {
    const pattern = request.routeOptions.url ?? "";
    if (!request.auth || !shouldAudit(request.method, pattern, reply.statusCode)) return;
    const staff = request.auth.staff;
    await recordAudit(
      {
        tenantId: request.auth.tenantId,
        actorType: staff ? "STAFF" : "CLIENT",
        actorId: staff ? staff.id : request.auth.clientId,
        actorName: staff ? staff.name : `Integration ${request.auth.clientId}`,
        action: describeAction(request.method, pattern),
        method: request.method,
        route: pattern,
        resourceId: resourceIdFrom(request.params),
        statusCode: reply.statusCode,
        ipAddress: request.ip,
      },
      request.log
    );
  });
};

export default fp(auditTrailPlugin, { name: "audit-trail", dependencies: [] });
