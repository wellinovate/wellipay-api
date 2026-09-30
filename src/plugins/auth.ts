import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "../lib/tokens.js";
import { sendProblem, problems } from "../lib/problem.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      clientId: string;
      tenantId: string;
      scopes: string[];
    };
    // Set only by requirePatientScope(), never by requireScope() — a route
    // that needs the authenticated patient's own tenantId/patientRef reads
    // this, never request.auth, so a staff/provider token can never
    // accidentally satisfy a patient route's data access by coincidence.
    patientAuth?: {
      patientAccountId: string;
      tenantId: string;
      patientRef: string;
      scopes: string[];
    };
  }
}

/**
 * Resolves tenant identity from the bearer token only. Per the contract's
 * "Trust and data rules": a caller-supplied tenant ID is never authoritative.
 * Every route handler must use request.auth.tenantId, never anything read
 * from the request body or path.
 */
const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("requireScope", function requireScope(scope: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return sendProblem(reply, problems.unauthorized("Missing bearer token."));
      }
      const token = header.slice("Bearer ".length);
      try {
        const claims = await verifyAccessToken(token);
        if (!claims.scopes.includes(scope)) {
          return sendProblem(reply, problems.forbidden(`Token is missing required scope: ${scope}`));
        }
        // A patient-scoped token (see requirePatientScope below) carries a
        // patientRef claim that a staff/provider token never has. Reject it
        // here even if it happens to carry the requested scope string —
        // /provider/* routes are staff/provider-only, full stop.
        if (claims.patientRef !== undefined) {
          return sendProblem(reply, problems.forbidden("A patient token cannot call this endpoint."));
        }
        request.auth = { clientId: claims.sub, tenantId: claims.tenantId, scopes: claims.scopes };
      } catch {
        return sendProblem(reply, problems.unauthorized("Token is invalid, expired, or malformed."));
      }
    };
  });

  // For /patient/* routes only. A patient-scoped token (issued by
  // POST /patient/token) must carry the requested scope AND a patientRef —
  // every /patient/* route handler then filters its Prisma query by
  // request.patientAuth.tenantId + .patientRef, never by anything the
  // request itself supplies, exactly like requireScope's tenant isolation.
  app.decorate("requirePatientScope", function requirePatientScope(scope: string) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return sendProblem(reply, problems.unauthorized("Missing bearer token."));
      }
      const token = header.slice("Bearer ".length);
      try {
        const claims = await verifyAccessToken(token);
        if (!claims.scopes.includes(scope)) {
          return sendProblem(reply, problems.forbidden(`Token is missing required scope: ${scope}`));
        }
        if (claims.patientRef === undefined) {
          return sendProblem(reply, problems.forbidden("This endpoint requires a patient token, not a staff/provider token."));
        }
        request.patientAuth = {
          patientAccountId: claims.sub,
          tenantId: claims.tenantId,
          patientRef: claims.patientRef,
          scopes: claims.scopes,
        };
      } catch {
        return sendProblem(reply, problems.unauthorized("Token is invalid, expired, or malformed."));
      }
    };
  });
};

declare module "fastify" {
  interface FastifyInstance {
    requireScope(scope: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
    requirePatientScope(scope: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
  }
}

export default fp(authPlugin, { name: "auth" });
