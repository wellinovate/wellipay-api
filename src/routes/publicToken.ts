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
// This is still a demo-grade proxy — it hands out a token to any caller,
// scoped to whatever the seeded frontend credential is granted. Before
// real patient data is involved, this should add its own caller-side
// safeguard (e.g. rate limiting, or requiring the request to originate
// from the known frontend origin) rather than being wide open.
const publicTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post("/public/frontend-token", async (_request, reply) => {
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
  });
};

export default publicTokenRoutes;
