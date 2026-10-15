import { prisma } from "../lib/prisma.js";

// Records a provider's plan terms. Prints the change and stops unless CONFIRM=yes.
//   TENANT_ID=... PLAN_NAME="Standard" MONTHLY_FEE_NGN=25000 FEE_PERCENT=1 [STARTED_AT=2026-11-01] npm run provider:set-plan
async function main() {
  const tenantId = process.env.TENANT_ID;
  if (!tenantId) throw new Error("Set TENANT_ID.");
  const data: Record<string, unknown> = {};
  if (process.env.PLAN_NAME) data.planName = process.env.PLAN_NAME.trim();
  if (process.env.MONTHLY_FEE_NGN) {
    const ngn = Number(process.env.MONTHLY_FEE_NGN);
    if (!Number.isFinite(ngn) || ngn < 0) throw new Error("MONTHLY_FEE_NGN must be zero or more.");
    data.planMonthlyFeeMinor = BigInt(Math.round(ngn * 100));
  }
  if (process.env.FEE_PERCENT) {
    const pct = Number(process.env.FEE_PERCENT);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error("FEE_PERCENT must be 0 to 100.");
    data.platformFeePercent = pct;
  }
  if (process.env.STARTED_AT) {
    const d = new Date(process.env.STARTED_AT);
    if (Number.isNaN(d.getTime())) throw new Error("STARTED_AT is not a date.");
    data.planStartedAt = d;
  }
  if (Object.keys(data).length === 0) throw new Error("Nothing to set.");
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  if (!tenant) throw new Error("No such tenant.");
  console.log(`Tenant ${tenant.name}: would set`, JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  if (process.env.CONFIRM !== "yes") {
    console.log("Preview only. Run again with CONFIRM=yes to save.");
    return;
  }
  await prisma.tenant.update({ where: { id: tenantId }, data });
  console.log("Saved. This records the terms; it does not change the Paystack split (use provider:set-fee for that).");
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
