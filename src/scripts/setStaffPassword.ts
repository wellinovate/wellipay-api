// Sets (or creates) a staff login without going through the API, so the
// first manager can sign in once the shared frontend token is turned off.
//
// Run from the Render shell (or locally with DATABASE_URL set):
//   STAFF_EMAIL=a@b.ng STAFF_PASSWORD='at least 8 chars' npm run staff:set-password
// To create the staff member if the email does not exist yet, also set
// STAFF_NAME and optionally STAFF_ROLE (default "Finance Manager").
// The password is read from the environment so it never lands in shell
// history as a command-line argument.
import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";

async function main() {
  const email = process.env["STAFF_EMAIL"]?.trim().toLowerCase();
  const password = process.env["STAFF_PASSWORD"];
  if (!email || !password) {
    throw new Error("Set STAFF_EMAIL and STAFF_PASSWORD.");
  }
  if (password.length < 8 || password.length > 200) {
    throw new Error("STAFF_PASSWORD must be 8 to 200 characters.");
  }

  const passwordHash = await argon2.hash(password);
  const existing = await prisma.staff.findUnique({ where: { email } });

  if (existing) {
    await prisma.staff.update({ where: { id: existing.id }, data: { passwordHash, status: "ACTIVE", deactivatedAt: null } });
    console.log(`Password set for ${email} (${existing.name}).`);
    return;
  }

  const name = process.env["STAFF_NAME"]?.trim();
  if (!name) {
    throw new Error(`No staff member with email ${email}. Set STAFF_NAME to create one.`);
  }
  const credential = await prisma.apiCredential.findUnique({ where: { clientId: env.FRONTEND_CLIENT_ID } });
  if (!credential) {
    throw new Error("Could not find the tenant: FRONTEND_CLIENT_ID does not match an API credential.");
  }
  const created = await prisma.staff.create({
    data: { tenantId: credential.tenantId, name, email, role: process.env["STAFF_ROLE"]?.trim() || "Finance Manager", passwordHash },
  });
  console.log(`Created staff ${created.email} (${created.name}).`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
