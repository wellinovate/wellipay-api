import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import authPlugin from "./plugins/auth.js";
import oauthRoutes from "./routes/oauth.js";
import publicTokenRoutes from "./routes/publicToken.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import patientRoutes from "./routes/patients.js";
import claimRoutes from "./routes/claims.js";
import familyFundingRoutes from "./routes/familyFunding.js";
import eligibilityRoutes from "./routes/eligibility.js";
import consentRoutes from "./routes/consents.js";
import webhookEndpointRoutes from "./routes/webhookEndpoints.js";
import refundRoutes from "./routes/refunds.js";
import reconciliationRoutes from "./routes/reconciliation.js";
import staffRoutes from "./routes/staff.js";
import paymentPlanRoutes from "./routes/paymentPlans.js";
import settlementRoutes from "./routes/settlements.js";
import eventRoutes from "./routes/events.js";
import financingRoutes from "./routes/financingRecords.js";
import partnerRoutes from "./routes/partners.js";
import staffAuthRoutes from "./routes/staffAuth.js";
import patientAuthRoutes from "./routes/patientAuth.js";
import { sendProblem, problems } from "./lib/problem.js";
import { env } from "./env.js";

export function buildApp() {
  const app = Fastify({
    logger:
      env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty" } }
        : { level: "info" },
    trustProxy: true, // Render terminates TLS in front of this service
  });

  app.register(sensible);
  // Browser clients (the WelliPayPro static frontend) call this API from a
  // different origin. CORS_ORIGIN defaults to "*" for the prototype; set it
  // to the frontend's actual Render URL (comma-separate for more than one)
  // once this is more than a demo.
  app.register(cors, {
    origin: env.CORS_ORIGIN === "*" ? true : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  });
  // A blanket safety net on every route — 300 requests/minute per IP by
  // default. Before this, only POST /public/frontend-token had any limit
  // (see its own tighter 20/min override below), which meant every
  // money-moving write route (payments, refunds, settlements, financing,
  // payment plans) had zero protection against being hammered. A route can
  // still set its own tighter `config.rateLimit` (as the token route does)
  // to override this default.
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => {
      // @fastify/rate-limit throws whatever this returns, and reads its own
      // statusCode off that value — a plain object without one falls
      // through to the app's generic error handler as a 500, so this has to
      // be a real Error with `.statusCode` set, not a problem+json-shaped
      // plain object.
      const err = new Error(`Rate limit exceeded, retry in ${context.after}.`) as Error & { statusCode?: number };
      err.statusCode = context.statusCode;
      return err;
    },
  });
  // POST /oauth/token is application/x-www-form-urlencoded per OAuth2 (RFC
  // 6749 §4.4.2) — Fastify only parses JSON out of the box, so without this
  // every token request fails with FST_ERR_CTP_INVALID_MEDIA_TYPE before it
  // reaches the route handler.
  app.register(formbody);
  app.register(authPlugin);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(oauthRoutes);
  app.register(publicTokenRoutes);
  app.register(invoiceRoutes);
  app.register(paymentRoutes);
  app.register(patientRoutes);
  app.register(claimRoutes);
  app.register(familyFundingRoutes);
  app.register(eligibilityRoutes);
  app.register(consentRoutes);
  app.register(webhookEndpointRoutes);
  app.register(refundRoutes);
  app.register(reconciliationRoutes);
  app.register(staffRoutes);
  app.register(paymentPlanRoutes);
  app.register(settlementRoutes);
  app.register(eventRoutes);
  app.register(financingRoutes);
  app.register(partnerRoutes);
  app.register(staffAuthRoutes);
  app.register(patientAuthRoutes);

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, problems.notFound("No route matches this path and method."));
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log.error(error);
    // Trust a status code Fastify (or a plugin) already attached to the
    // error — e.g. FST_ERR_CTP_INVALID_MEDIA_TYPE is a 415, a body-parse
    // failure is a 400. Only default to 500 when nothing set one, so a
    // client mistake isn't reported back as "Internal Server Error."
    const status = error.statusCode ?? (reply.statusCode >= 400 ? reply.statusCode : 500);
    reply.code(status);
    sendProblem(reply, {
      status,
      title: status >= 500 ? "Internal Server Error" : "Request Error",
      detail: status >= 500 && env.NODE_ENV === "production" ? undefined : error.message,
    });
  });

  return app;
}
