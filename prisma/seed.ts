import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Creates one tenant + one API credential so you can call the API right
// after a fresh deploy without hand-writing SQL. Run with:
//   npm run prisma:seed
// The client secret is printed ONCE — store it (e.g. in the calling
// provider backend's own secrets manager); it is never recoverable after this.

async function main() {
  const tenantName = process.env.SEED_TENANT_NAME ?? "ABC Healthcare";
  const clientId = process.env.SEED_CLIENT_ID ?? "client_abc_healthcare";
  const clientSecret = process.env.SEED_CLIENT_SECRET ?? randomBytes(24).toString("base64url");

  const tenant = await prisma.tenant.upsert({
    where: { id: "seed-tenant" },
    update: {},
    create: { id: "seed-tenant", name: tenantName },
  });

  const clientSecretHash = await argon2.hash(clientSecret);

  await prisma.apiCredential.upsert({
    where: { clientId },
    update: { clientSecretHash, scopes: ["mobile.integration.read", "mobile.integration.write"] },
    create: {
      tenantId: tenant.id,
      clientId,
      clientSecretHash,
      scopes: ["mobile.integration.read", "mobile.integration.write"],
    },
  });

  console.log("Seeded tenant:", tenant.name, tenant.id);
  console.log("client_id:", clientId);
  console.log("client_secret:", clientSecret, "(save this now — it will not be shown again)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
