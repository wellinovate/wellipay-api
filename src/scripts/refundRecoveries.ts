// Tracks refunds the platform paid out of its own Paystack balance for payments
// that settled to a provider's subaccount. Run from the Render shell.
//
//   npm run recovery:list
//   REFUND_ID=... NOTE='how it was recovered' npm run recovery:settle
//   REFUND_ID=... NOTE='why' npm run recovery:waive
//
// "settle" means the provider has paid the amount back (for example by bank
// transfer). Nothing here moves money.
import { prisma } from "../lib/prisma.js";
import { toMinorNumber } from "../lib/money.js";

const naira = (minor: number) => `NGN ${(minor / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;

async function list() {
  const rows = await prisma.refund.findMany({
    where: { recoveryStatus: "OWED" },
    orderBy: { createdAt: "asc" },
    include: { tenant: { select: { name: true } } },
  });
  if (!rows.length) {
    console.log("No refunds owed by providers.");
    return;
  }
  const totals = new Map<string, number>();
  for (const r of rows) {
    const amount = toMinorNumber(r.amountMinor);
    totals.set(r.tenant.name, (totals.get(r.tenant.name) ?? 0) + amount);
    console.log(`Refund ${r.id}  ${r.tenant.name}  ${naira(amount)}  approved ${r.decidedAt?.toISOString() ?? "?"}  ref ${r.providerRefundRef}`);
  }
  console.log("");
  for (const [name, total] of totals) console.log(`${name} owes ${naira(total)}`);
}

async function close(status: "RECOVERED" | "WAIVED") {
  const id = process.env["REFUND_ID"]?.trim();
  const note = process.env["NOTE"]?.trim();
  if (!id || !note) throw new Error("Set REFUND_ID and NOTE.");
  const refund = await prisma.refund.findUnique({ where: { id } });
  if (!refund) throw new Error("No refund with that ID.");
  if (refund.recoveryStatus !== "OWED") throw new Error("That refund is not marked as owed.");
  await prisma.refund.update({ where: { id }, data: { recoveryStatus: status, recoveredAt: new Date(), recoveryNote: note } });
  console.log(`Refund ${id} marked ${status.toLowerCase()}.`);
}

const command = process.argv[2];
const run = command === "list" ? list : command === "settle" ? () => close("RECOVERED") : command === "waive" ? () => close("WAIVED") : null;
if (!run) {
  console.error("Usage: refundRecoveries.js list | settle | waive");
  process.exit(1);
}
run()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
