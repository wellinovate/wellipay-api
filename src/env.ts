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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
