import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import { listSettlements, listSettlementTransactions, PaystackError } from "../lib/paystack.js";
import { mapGatewaySettlementStatus, netMinor, settlementSummary } from "../lib/settlementStatus.js";

const listQuery = z.object({
  status: z.enum(["AWAITING", "PROCESSING", "SETTLED", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const syncBody = z.object({ days: z.number().int().min(1).max(90).default(30) }).default({ days: 30 });

const lastSync = new Map<string, number>();
const SYNC_COOLDOWN_MS = 30_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Where each online payment is on its way to the provider's bank.
const paymentSettlementRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/payments/settlement", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const tenantId = request.auth!.tenantId;
    const since = new Date(Date.now() - 90 * 86_400_000);

    const [charges, topUps] = await Promise.all([
      prisma.paystackCharge.findMany({ where: { tenantId, status: "SUCCESS", createdAt: { gte: since } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2000 }),
      prisma.walletTopUp.findMany({ where: { tenantId, status: "SUCCESS", createdAt: { gte: since } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2000 }),
    ]);
    const invoiceIds = [...new Set(charges.map((c: { invoiceId: string }) => c.invoiceId))];
    const invoices = invoiceIds.length
      ? await prisma.invoice.findMany({ where: { tenantId, id: { in: invoiceIds } }, select: { id: true, providerInvoiceRef: true, description: true } })
      : [];
    const invoiceById = new Map(invoices.map((i: { id: string; providerInvoiceRef: string; description: string }) => [i.id, i]));

    const rows = [
      ...charges.map((c: { id: string; reference: string; invoiceId: string; amountMinor: bigint; feesMinor: bigint | null; settlementStatus: string; gatewaySettlementId: string | null; settledAt: Date | null; createdAt: Date; source: string }) => {
        const inv = invoiceById.get(c.invoiceId) as { providerInvoiceRef: string; description: string } | undefined;
        return {
          kind: "INVOICE" as const,
          reference: c.reference,
          label: inv ? `${inv.providerInvoiceRef} · ${inv.description}` : c.invoiceId,
          source: c.source,
          amountMinor: c.amountMinor,
          feesMinor: c.feesMinor,
          settlementStatus: c.settlementStatus,
          gatewaySettlementId: c.gatewaySettlementId,
          settledAt: c.settledAt,
          paidAt: c.createdAt,
        };
      }),
      ...topUps.map((t: { reference: string; amountMinor: bigint; feesMinor: bigint | null; settlementStatus: string; gatewaySettlementId: string | null; settledAt: Date | null; createdAt: Date }) => ({
        kind: "TOPUP" as const,
        reference: t.reference,
        label: "Wallet top-up",
        source: "PATIENT",
        amountMinor: t.amountMinor,
        feesMinor: t.feesMinor,
        settlementStatus: t.settlementStatus,
        gatewaySettlementId: t.gatewaySettlementId,
        settledAt: t.settledAt,
        paidAt: t.createdAt,
      })),
    ].sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime());

    const summary = settlementSummary(rows);
    const shown = rows.filter((r) => !parsed.data.status || r.settlementStatus === parsed.data.status).slice(0, parsed.data.limit);
    return reply.code(200).send({
      summary,
      hasPayoutAccount: Boolean((await prisma.tenant.findUnique({ where: { id: tenantId }, select: { paystackSubaccountCode: true } }))?.paystackSubaccountCode),
      items: shown.map((r) => ({
        kind: r.kind,
        reference: r.reference,
        label: r.label,
        source: r.source,
        amountMinor: toMinorNumber(r.amountMinor),
        feesMinor: r.feesMinor === null ? undefined : toMinorNumber(r.feesMinor),
        netMinor: toMinorNumber(netMinor(r)),
        settlementStatus: r.settlementStatus,
        gatewaySettlementId: r.gatewaySettlementId ?? undefined,
        settledAt: r.settledAt?.toISOString(),
        paidAt: r.paidAt.toISOString(),
      })),
    });
  });

  // Asks Paystack which payments are in which payout and records it. Safe to repeat.
  app.post("/provider/payments/settlement/sync", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    if (!env.PAYSTACK_SECRET_KEY) return sendProblem(reply, problems.unprocessable("Online payment is not set up yet.", "paystack_not_configured"));
    const parsed = syncBody.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { paystackSubaccountCode: true } });
    if (!tenant?.paystackSubaccountCode) {
      return sendProblem(reply, problems.unprocessable("This provider has no payout account yet, so there is nothing to check.", "no_payout_account"));
    }
    const last = lastSync.get(tenantId) ?? 0;
    if (Date.now() - last < SYNC_COOLDOWN_MS) {
      return sendProblem(reply, problems.conflict("A check just ran. Wait a few seconds.", "sync_too_soon"));
    }
    lastSync.set(tenantId, Date.now());

    const now = new Date();
    let payouts;
    try {
      payouts = await listSettlements(env.PAYSTACK_SECRET_KEY, {
        from: isoDay(new Date(now.getTime() - parsed.data.days * 86_400_000)),
        to: isoDay(new Date(now.getTime() + 86_400_000)),
        subaccount: tenant.paystackSubaccountCode,
      });
    } catch (err) {
      if (err instanceof PaystackError) return sendProblem(reply, problems.badGateway(err.message, "paystack_unavailable"));
      throw err;
    }

    let updated = 0;
    for (const payout of payouts.slice(0, 60)) {
      const state = mapGatewaySettlementStatus(payout.status);
      const refs: string[] = [];
      try {
        for (let page = 1; page <= 10; page++) {
          const batch = await listSettlementTransactions(env.PAYSTACK_SECRET_KEY, payout.id, page);
          refs.push(...batch.items.map((t) => t.reference));
          if (!batch.hasMore) break;
        }
      } catch (err) {
        if (err instanceof PaystackError) return sendProblem(reply, problems.badGateway(err.message, "paystack_unavailable"));
        throw err;
      }
      if (refs.length === 0) continue;
      // Never move a payment backwards: settled beats failed beats processing.
      const from = state === "SETTLED" ? ["AWAITING", "PROCESSING", "FAILED"] : state === "FAILED" ? ["AWAITING", "PROCESSING"] : ["AWAITING"];
      const settledAt = state === "SETTLED" ? (payout.settlementDate ? new Date(payout.settlementDate) : now) : null;
      const data = { settlementStatus: state, gatewaySettlementId: payout.id, ...(settledAt && !Number.isNaN(settledAt.getTime()) ? { settledAt } : {}) };
      const [a, b] = await Promise.all([
        prisma.paystackCharge.updateMany({ where: { tenantId, status: "SUCCESS", reference: { in: refs }, settlementStatus: { in: from } }, data }),
        prisma.walletTopUp.updateMany({ where: { tenantId, status: "SUCCESS", reference: { in: refs }, settlementStatus: { in: from } }, data }),
      ]);
      updated += a.count + b.count;
    }
    return reply.code(200).send({ payoutsChecked: payouts.length, paymentsUpdated: updated });
  });

  // Prepaid credit patients hold with this provider. It is what the provider owes back.
  app.get("/provider/wallet-summary", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const agg = await prisma.walletAccount.aggregate({ where: { tenantId, balanceMinor: { gt: 0 } }, _sum: { balanceMinor: true }, _count: { _all: true } });
    return reply.code(200).send({ patientsWithCredit: agg._count._all, totalCreditMinor: toMinorNumber(agg._sum.balanceMinor ?? 0n) });
  });
};

export default paymentSettlementRoutes;
