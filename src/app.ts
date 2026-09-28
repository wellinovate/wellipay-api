import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import authPlugin from "./plugins/auth.js";
import oauthRoutes from "./routes/oauth.js";
import publicTokenRoutes from "./routes/publicToken.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import patientRoutes from "./routes/patients.js";
import familyFundingRoutes from "./routes/familyFunding.js";
import eligibilityRoutes from "./routes/eligibility.js";
import consentRoutes from "./routes/consents.js";
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
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
  app.register(familyFundingRoutes);
  app.register(eligibilityRoutes);
  app.register(consentRoutes);

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
