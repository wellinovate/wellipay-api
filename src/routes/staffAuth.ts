import type { FastifyPluginAsync } from "fastify";
import argon2 from "argon2";
import { staffLoginSchema } from "../schemas/staffAuth.js";
import { prisma } from "../lib/prisma.js";
import { issueAccessToken } from "../lib/tokens.js";
import { sendProblem, problems } from "../lib/problem.js";
import { env } from "../env.js";

// Per-staff login, replacing the single shared frontend token as the
// identity behind write actions. Every logged-in staff member still gets
// the same two scopes the old shared token had (mobile.integration.read/
// write) — there's no per-role permission enforcement yet, only per-person
// identity. That's a real gap: a Front-Desk Cashier and a Finance Manager
// can do exactly the same things today. Same safeguards as
// POST /public/frontend-token: rate limiting and (once CORS_ORIGIN is
// locked down) an origin check.
const staffAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/staff/login",
    {
      config: {
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
      const parsed = staffLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { email, password } = parsed.data;

      const allowedOrigins = env.CORS_ORIGIN === "*" ? null : env.CORS_ORIGIN.split(",").map((o) => o.trim());
      const origin = request.headers.origin;
      if (allowedOrigins && origin && !allowedOrigins.includes(origin)) {
        return sendProblem(reply, problems.forbidden("Request origin is not allowed to log in here.", "origin_not_allowed"));
      }

      const staff = await prisma.staff.findUnique({ where: { email } });
      // Same generic message whether the email doesn't exist, the account
      // is deactivated, no password was ever set, or the password is
      // wrong — never reveal which case it was.
      const genericFailure = () => sendProblem(reply, problems.unauthorized("Incorrect email or password.", "invalid_credentials"));

      if (!staff || staff.status !== "ACTIVE" || !staff.passwordHash) {
        return genericFailure();
      }
      const validPassword = await argon2.verify(staff.passwordHash, password).catch(() => false);
      if (!validPassword) {
        return genericFailure();
      }

      const { token, expiresIn } = await issueAccessToken({
        sub: staff.id,
        tenantId: staff.tenantId,
        scopes: ["mobile.integration.read", "mobile.integration.write"],
      });

      return reply.code(200).send({
        access_token: token,
        token_type: "Bearer",
        expires_in: expiresIn,
        staff: { staffId: staff.id, name: staff.name, email: staff.email, role: staff.role },
      });
    }
  );
};

export default staffAuthRoutes;
