import type { FastifyPluginAsync } from "fastify";
import { patientListReconciliationQuerySchema, listReconciliationQuerySchema } from "../schemas/claimReconciliation.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";

// Read-only: compares what an HMO approved on a claim (Claim.
// approvedAmountMinor) against what has actually been remitted for that
// claim's invoice (the sum of its "hmo_direct" Payment rows — see the
// schema comment on Claim: "an APPROVED or PARTIALLY_APPROVED claim is
// what a payment (channel 'hmo_direct') later settles against"). No new
// model or write path: this is derived entirely from Claim + Payment,
// which already carry everything needed.
//
// DRAFT/SUBMITTED/REJECTED claims have nothing approved yet, so they're
// excluded — there's no "expected remittance" to reconcile against.
const RECONCILABLE_STATUSES = ["APPROVED", "PARTIALLY_APPROVED"] as const;

interface ReconciliationClaim {
  id: string; providerClaimRef: string; invoiceId: string; patientRef: string; facilityRef: string;
  payerRef: string; approvedAmountMinor: bigint | null; currency: string; status: string; decidedAt: Date | null;
}

async function buildReconciliationItems(tenantId: string, claims: ReconciliationClaim[]) {
  const invoiceIds = [...new Set(claims.map((c) => c.invoiceId))];

  const [invoices, remittances] = await Promise.all([
    prisma.invoice.findMany({
      where: { tenantId, id: { in: invoiceIds } },
      select: { id: true, providerInvoiceRef: true, description: true },
    }),
    prisma.payment.groupBy({
      by: ["invoiceId"],
      where: { tenantId, invoiceId: { in: invoiceIds }, channel: "hmo_direct", status: "SUCCESS" },
      _sum: { amountMinor: true },
    }),
  ]);

  const invoiceById = new Map(invoices.map((inv) => [inv.id, inv]));
  const receivedByInvoice = new Map(remittances.map((r) => [r.invoiceId, r._sum.amountMinor ?? 0n]));

  return claims.map((claim) => {
    const invoice = invoiceById.get(claim.invoiceId);
    const expectedMinor = claim.approvedAmountMinor ?? 0n;
    const receivedMinor = receivedByInvoice.get(claim.invoiceId) ?? 0n;
    const varianceMinor = expectedMinor - receivedMinor;

    return {
      claimId: claim.id,
      providerClaimRef: claim.providerClaimRef,
      invoiceId: claim.invoiceId,
      providerInvoiceRef: invoice?.providerInvoiceRef,
      description: invoice?.description,
      patientRef: claim.patientRef,
      facilityRef: claim.facilityRef,
      payerRef: claim.payerRef,
      claimStatus: claim.status,
      expectedAmount: { amountMinor: toMinorNumber(expectedMinor), currency: claim.currency },
      receivedAmount: { amountMinor: toMinorNumber(receivedMinor), currency: claim.currency },
      variance: { amountMinor: toMinorNumber(varianceMinor), currency: claim.currency },
      // UNDERPAID: received less than approved. OVERPAID: received more
      // (a remittance correction, a duplicate transfer, etc). RECONCILED:
      // matches exactly.
      reconciliationStatus: varianceMinor > 0n ? "UNDERPAID" : varianceMinor < 0n ? "OVERPAID" : "RECONCILED",
      decidedAt: claim.decidedAt?.toISOString(),
    };
  });
}

function sumTotals(items: Awaited<ReturnType<typeof buildReconciliationItems>>) {
  return items.reduce(
    (acc, item) => ({
      totalExpectedMinor: acc.totalExpectedMinor + item.expectedAmount.amountMinor,
      totalReceivedMinor: acc.totalReceivedMinor + item.receivedAmount.amountMinor,
      totalVarianceMinor: acc.totalVarianceMinor + item.variance.amountMinor,
    }),
    { totalExpectedMinor: 0, totalReceivedMinor: 0, totalVarianceMinor: 0 }
  );
}

const claimReconciliationRoutes: FastifyPluginAsync = async (app) => {
  // Patient's own view: "has my HMO actually paid what they approved for
  // my bill?" — scoped to the caller's patientRef only.
  app.get(
    "/patient/claims/reconciliation",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListReconciliationQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { limit, cursor } = parsed.data;

      const rows = await prisma.claim.findMany({
        where: { tenantId, patientRef, status: { in: [...RECONCILABLE_STATUSES] } },
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      // Totals cover every reconcilable claim for this patient, not just
      // this page, so the summary cards stay accurate under pagination.
      const allRows = await prisma.claim.findMany({
        where: { tenantId, patientRef, status: { in: [...RECONCILABLE_STATUSES] } },
      });

      const [items, allItems] = await Promise.all([
        buildReconciliationItems(tenantId, pageRows),
        buildReconciliationItems(tenantId, allRows),
      ]);

      return reply.code(200).send({
        items,
        nextCursor: hasMore ? pageRows[limit - 1]!.id : undefined,
        totals: sumTotals(allItems),
      });
    }
  );

  // Staff/billing view: every claim at the tenant (optionally one
  // facility or patient) — the provider settlement audit ("WelliPay
  // Reconcile™").
  app.get(
    "/provider/claims/reconciliation",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listReconciliationQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, patientRef, limit, cursor } = parsed.data;
      const where = {
        tenantId,
        status: { in: [...RECONCILABLE_STATUSES] },
        ...(facilityRef ? { facilityRef } : {}),
        ...(patientRef ? { patientRef } : {}),
      };

      const rows = await prisma.claim.findMany({
        where,
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const allRows = await prisma.claim.findMany({ where });

      const [items, allItems] = await Promise.all([
        buildReconciliationItems(tenantId, pageRows),
        buildReconciliationItems(tenantId, allRows),
      ]);

      return reply.code(200).send({
        items,
        nextCursor: hasMore ? pageRows[limit - 1]!.id : undefined,
        totals: sumTotals(allItems),
      });
    }
  );
};

export default claimReconciliationRoutes;
