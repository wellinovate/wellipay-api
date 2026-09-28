import Fastify from "fastify";
import sensible from "@fastify/sensible";
import authPlugin from "./plugins/auth.js";
import oauthRoutes from "./routes/oauth.js";
import invoiceRoutes from "./routes/invoices.js";
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
  app.register(authPlugin);

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(oauthRoutes);
  app.register(invoiceRoutes);
  app.register(familyFundingRoutes);
  app.register(eligibilityRoutes);
  app.register(consentRoutes);

  app.setNotFoundHandler((request, reply) => {
    sendProblem(reply, problems.notFound("No route matches this path and method."));
  });

  app.setErrorHandler((error: Error, request, reply) => {
    request.log.error(error);
    if (reply.statusCode < 400) reply.code(500);
    sendProblem(reply, {
      status: reply.statusCode,
      title: reply.statusCode >= 500 ? "Internal Server Error" : "Request Error",
      detail: env.NODE_ENV === "production" ? undefined : error.message,
    });
  });

  return app;
}
