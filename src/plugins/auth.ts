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
        request.auth = { clientId: claims.sub, tenantId: claims.tenantId, scopes: claims.scopes };
      } catch {
        return sendProblem(reply, problems.unauthorized("Token is invalid, expired, or malformed."));
      }
    };
  });
};

declare module "fastify" {
  interface FastifyInstance {
    requireScope(scope: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void | FastifyReply>;
  }
}

export default fp(authPlugin, { name: "auth" });
