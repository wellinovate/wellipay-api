import type { FastifyPluginAsync } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { issueAccessToken } from "../lib/tokens.js";
import { sendProblem, problems } from "../lib/problem.js";

// OAuth2 client-credentials token endpoint (RFC 6749 §4.4), matching
// securitySchemes.oauth2 in the OpenAPI contract. See the note in
// src/lib/tokens.ts about replacing this with a real IdP later.

const tokenRequestSchema = z.object({
  grant_type: z.literal("client_credentials"),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  scope: z.string().optional(), // space-delimited, subset of the credential's granted scopes
});

const oauthRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/oauth/token",
    {
      config: {
        // This is the one endpoint where an attacker can try arbitrary
        // client_id/client_secret pairs — /public/frontend-token and
        // /staff/login both already have a tighter 20/min limit than the
        // app-wide 300/min default; this had none, which made it the
        // weakest of the three credential-checking routes despite being
        // the one meant for external API integrators, not just the
        // frontend.
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          errorResponseBuilder: (_request, context) => {
            const err = new Error(`Rate limit exceeded, retry in ${context.after}.`) as Error & { statusCode?: number };
            err.statusCode = context.statusCode;
            return err;
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = tokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest("Expected grant_type=client_credentials with client_id, client_secret, and optional scope.", "invalid_request"));
      }
      const { client_id, client_secret, scope } = parsed.data;

      const credential = await prisma.apiCredential.findUnique({ where: { clientId: client_id } });
      if (!credential || credential.revokedAt) {
        return sendProblem(reply, problems.unauthorized("Unknown or revoked client_id.", "invalid_client"));
      }

      const validSecret = await argon2.verify(credential.clientSecretHash, client_secret).catch(() => false);
      if (!validSecret) {
        return sendProblem(reply, problems.unauthorized("Invalid client_secret.", "invalid_client"));
      }

      const requestedScopes = scope ? scope.split(" ").filter(Boolean) : credential.scopes;
      const grantedScopes = requestedScopes.filter((s: string) => credential.scopes.includes(s));
      if (grantedScopes.length === 0) {
        return sendProblem(reply, problems.forbidden("Requested scope is not granted to this client.", "invalid_scope"));
      }

      const { token, expiresIn } = await issueAccessToken({ sub: credential.clientId, tenantId: credential.tenantId, scopes: grantedScopes });

      return reply.code(200).send({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: grantedScopes.join(" "),
      });
    }
  );
};

export default oauthRoutes;
