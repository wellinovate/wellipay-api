// Sets the platform's share on providers that are already approved.
//
//   npm run provider:set-fee               shows what would change
//   CONFIRM=yes npm run provider:set-fee   changes it at Paystack
//
// The share comes from PLATFORM_FEE_PERCENT (default 1). New providers get it
// when they are approved. This command brings earlier providers in line. It
// changes the Paystack subaccount only; settlement bank details are untouched.
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { updateSubaccountPercentage } from "../lib/paystack.js";

async function main() {
  if (!env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set.");
  const tenants = await prisma.tenant.findMany({ where: { paystackSubaccountCode: { not: null } }, select: { name: true, paystackSubaccountCode: true } });
  if (!tenants.length) return console.log("No providers with a Paystack subaccount.");
  const confirm = process.env.CONFIRM === "yes";
  console.log(`${confirm ? "Setting" : "Would set"} the platform share to ${env.PLATFORM_FEE_PERCENT}% on ${tenants.length} provider(s):`);
  let failed = 0;
  for (const t of tenants) {
    if (!confirm) {
      console.log(`  ${t.name} (${t.paystackSubaccountCode})`);
      continue;
    }
    try {
      await updateSubaccountPercentage(env.PAYSTACK_SECRET_KEY, t.paystackSubaccountCode!, env.PLATFORM_FEE_PERCENT);
      console.log(`  done    ${t.name} (${t.paystackSubaccountCode})`);
    } catch (err) {
      failed++;
      console.error(`  FAILED  ${t.name} (${t.paystackSubaccountCode}): ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!confirm) console.log("Nothing changed. Run again with CONFIRM=yes to apply.");
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
