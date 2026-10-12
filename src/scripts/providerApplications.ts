// Reviews provider applications from the Render shell (or locally with
// DATABASE_URL and PAYSTACK_SECRET_KEY set).
//
//   npm run provider:list
//   APPLICATION_ID=... ADMIN_PASSWORD='at least 8 chars' npm run provider:approve
//   APPLICATION_ID=... REASON='why' npm run provider:reject
//
// Approve creates, in order: the Paystack subaccount (so a Paystack failure
// leaves nothing behind), then the tenant and its first Admin sign-in. Before
// approving, check that the account name printed by `provider:list` matches
// the business or its owner. Paystack is not liable for a payout sent to the
// wrong account.
import argon2 from "argon2";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { createSubaccount } from "../lib/paystack.js";
import { passwordProblem } from "../lib/passwordPolicy.js";
import type { Prisma } from "@prisma/client";

const mask = (n: string) => `******${n.slice(-4)}`;

async function list() {
  const rows = await prisma.providerApplication.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" } });
  if (!rows.length) {
    console.log("No pending applications.");
    return;
  }
  for (const a of rows) {
    console.log(
      [
        `ID:        ${a.id}`,
        `Business:  ${a.businessName} (${a.providerType})`,
        `Contact:   ${a.contactName}, ${a.contactEmail}, ${a.contactPhone}`,
        `Licence:   ${a.licenseNumber ?? "not given"}`,
        `Bank:      ${a.bankName ?? a.bankCode} ${mask(a.accountNumber)}`,
        `Account name from bank: ${a.accountName}`,
        `Applied:   ${a.createdAt.toISOString()}`,
        "",
      ].join("\n")
    );
  }
}

async function approve() {
  const id = process.env["APPLICATION_ID"]?.trim();
  const password = process.env["ADMIN_PASSWORD"];
  if (!id || !password) throw new Error("Set APPLICATION_ID and ADMIN_PASSWORD.");
  if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set.");

  const app = await prisma.providerApplication.findUnique({ where: { id } });
  if (!app) throw new Error("No application with that ID.");
  if (app.status !== "PENDING") throw new Error(`Application is already ${app.status.toLowerCase()}.`);
  const weak = passwordProblem(password, app.contactEmail);
  if (weak) throw new Error(`ADMIN_PASSWORD rejected: ${weak}`);
  const taken = await prisma.staff.findFirst({ where: { email: { equals: app.contactEmail, mode: "insensitive" } } });
  if (taken) throw new Error("That email already signs in to a tenant.");

  const { subaccountCode } = await createSubaccount(env.PAYSTACK_SECRET_KEY, {
    businessName: app.businessName,
    bankCode: app.bankCode,
    accountNumber: app.accountNumber,
    platformPercent: env.PLATFORM_FEE_PERCENT,
  });
  const passwordHash = await argon2.hash(password);

  const tenant = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const t = await tx.tenant.create({
      data: {
        name: app.businessName,
        providerType: app.providerType,
        paystackSubaccountCode: subaccountCode,
        settlementBankCode: app.bankCode,
        settlementAccountNumber: app.accountNumber,
        settlementAccountName: app.accountName,
      },
    });
    await tx.staff.create({
      data: { tenantId: t.id, name: app.contactName, email: app.contactEmail, role: "Owner", accessLevel: "ADMIN", passwordHash },
    });
    await tx.providerApplication.update({ where: { id: app.id }, data: { status: "APPROVED", tenantId: t.id, reviewedAt: new Date() } });
    return t;
  });
  console.log(`Approved ${app.businessName}. Tenant ${tenant.id}, Paystack subaccount ${subaccountCode}.`);
  console.log(`Tell ${app.contactEmail} to sign in with the password you set, then change it.`);
}

async function reject() {
  const id = process.env["APPLICATION_ID"]?.trim();
  const reason = process.env["REASON"]?.trim();
  if (!id || !reason) throw new Error("Set APPLICATION_ID and REASON.");
  const app = await prisma.providerApplication.findUnique({ where: { id } });
  if (!app) throw new Error("No application with that ID.");
  if (app.status !== "PENDING") throw new Error(`Application is already ${app.status.toLowerCase()}.`);
  await prisma.providerApplication.update({ where: { id }, data: { status: "REJECTED", rejectionReason: reason, reviewedAt: new Date() } });
  console.log(`Rejected ${app.businessName}.`);
}

const commands: Record<string, () => Promise<void>> = { list, approve, reject };

const command = process.argv[2] ?? "";
(commands[command]?.() ?? Promise.reject(new Error("Use: list, approve or reject.")))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
