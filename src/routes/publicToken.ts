import type { FastifyPluginAsync } from "fastify";
import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { issueAccessToken } from "../lib/tokens.js";
import { sendProblem, problems } from "../lib/problem.js";
import { env } from "../env.js";

// Token proxy for the WelliPayPro browser frontend.
//
// POST /oauth/token (the real OAuth2 client-credentials endpoint) requires
// a client_secret, which a browser cannot hold safely — anyone can
// view-source a static site. This route does the same credential lookup
// and token issuance, but reads the client_id/client_secret from this
// server's own environment (FRONTEND_CLIENT_ID / FRONTEND_CLIENT_SECRET)
// instead of the request body, so the frontend never needs the secret at
// all: it just POSTs here with no body and gets a short-lived token back.
//
// This is a caller-facing proxy that hands out a token to any caller
// scoped to whatever the seeded frontend credential is granted, so it
// carries two safeguards against being hammered or called from somewhere
// unexpected:
//   - Rate limiting (20 requests/minute per IP) — see the route config
//     below and the app.register(rateLimit, ...) call in app.ts.
//   - An origin check: when CORS_ORIGIN is locked down to specific
//     origin(s) (i.e. not the "*" prototype default), a request carrying
//     an Origin header that isn't in that list is rejected. This only
//     catches browser callers (a non-browser client can omit or fake the
//     header), so it's a best-effort layer on top of rate limiting, not a
//     replacement for it.
const publicTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/public/frontend-token",
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: "1 minute",
          errorResponseBuilder: (_request, context) => ({
            type: "about:blank",
            title: "Too Many Requests",
            status: 429,
            detail: `Rate limit exceeded, retry in ${context.after}.`,
            code: "rate_limited",
          }),
        },
      },
    },
    async (request, reply) => {
      const allowedOrigins = env.CORS_ORIGIN === "*" ? null : env.CORS_ORIGIN.split(",").map((o) => o.trim());
      const origin = request.headers.origin;
      if (allowedOrigins && origin && !allowedOrigins.includes(origin)) {
        return sendProblem(reply, problems.forbidden("Request origin is not allowed to use the frontend token proxy.", "origin_not_allowed"));
      }

      const credential = await prisma.apiCredential.findUnique({ where: { clientId: env.FRONTEND_CLIENT_ID } });
      if (!credential || credential.revokedAt) {
        return sendProblem(reply, problems.unauthorized("Frontend token proxy is misconfigured (unknown or revoked client_id).", "invalid_client"));
      }

      const validSecret = await argon2.verify(credential.clientSecretHash, env.FRONTEND_CLIENT_SECRET).catch(() => false);
      if (!validSecret) {
        return sendProblem(reply, problems.unauthorized("Frontend token proxy is misconfigured (invalid client_secret).", "invalid_client"));
      }

      const { token, expiresIn } = await issueAccessToken({
        sub: credential.clientId,
        tenantId: credential.tenantId,
        scopes: credential.scopes,
      });

      return reply.code(200).send({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: credential.scopes.join(" "),
      });
    }
  );
};

export default publicTokenRoutes;
