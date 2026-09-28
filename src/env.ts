import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required — set it to wellipaypro-db's connection string"),
  TOKEN_SIGNING_SECRET: z.string().min(32, "TOKEN_SIGNING_SECRET must be at least 32 characters"),
  TOKEN_ISSUER: z.string().default("https://api.wellipay.internal"),
  TOKEN_AUDIENCE: z.string().default("wellipay-integration-service"),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  // Comma-separated list of allowed browser origins for CORS (e.g. the
  // WelliPayPro static site's Render URL). "*" allows any origin — fine for
  // a prototype, but this ships a real bearer-token-issuing API, so lock it
  // down to the actual frontend origin(s) before this goes further than a demo.
  CORS_ORIGIN: z.string().default("*"),
  // Credentials for the WelliPayPro frontend's own token proxy
  // (POST /public/frontend-token). Held server-side only — the browser
  // never sees a client_secret. Must match a seeded ApiCredential's
  // clientId/secret (see prisma/seed.ts).
  FRONTEND_CLIENT_ID: z.string().min(1, "FRONTEND_CLIENT_ID is required — set it to the seeded demo tenant's client_id"),
  FRONTEND_CLIENT_SECRET: z.string().min(1, "FRONTEND_CLIENT_SECRET is required — set it to the seeded demo tenant's client_secret"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
