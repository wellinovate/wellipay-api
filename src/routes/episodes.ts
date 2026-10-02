import type { FastifyPluginAsync } from "fastify";
import { patientListEpisodesQuerySchema, listEpisodesQuerySchema } from "../schemas/episodes.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";

// Read-only, derived entirely from existing data: an "episode" is a group of
// a patient's own invoices that share the same metadata.episodeRef tag (see
// the comment on episodes.ts's query schemas). No new model or write path —
// Invoice.metadata is already a free-form string map, already settable via
// the existing POST /provider/invoices, so a provider groups invoices into
// an episode simply by tagging them with the same episodeRef (and an
// optional per-invoice category) when creating them.
//
// Invoices with no episodeRef tag are left out of every episode entirely —
// they're untagged, standalone bills, not a backend bug.

const RECONCILABLE_CLAIM_STATUSES = ["APPROVED", "PARTIALLY_APPROVED"] as const;
const ACTIVE_INVOICE_STATUSES = ["OPEN", "PARTIALLY_PAID"] as const;

interface EpisodeInvoice {
  id: string; providerInvoiceRef: string; facilityRef: string; patientRef: string; description: string;
  amountMinor: bigint; currency: string; paidAmountMinor: bigint; status: string;
  metadata: unknown; createdAt: Date; updatedAt: Date;
}

function readEpisodeTag(metadata: unknown): { episodeRef: string | undefined; category: string | undefined } {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { episodeRef: undefined, category: undefined };
  }
  const m = metadata as Record<string, unknown>;
  return {
    episodeRef: typeof m.episodeRef === "string" ? m.episodeRef : undefined,
    category: typeof m.category === "string" ? m.category : undefined,
  };
}

function itemStatus(invoice: EpisodeInvoice): "cleared" | "partly_paid" | "unpaid" {
  if (invoice.status === "PAID") return "cleared";
  if (invoice.status === "PARTIALLY_PAID") return "partly_paid";
  return invoice.paidAmountMinor > 0n ? "partly_paid" : "unpaid";
}

async function buildEpisodes(tenantId: string, invoices: EpisodeInvoice[]) {
  const tagged = invoices
    .map((inv) => ({ inv, tag: readEpisodeTag(inv.metadata) }))
    .filter((x) => !!x.tag.episodeRef) as { inv: EpisodeInvoice; tag: { episodeRef: string; category: string | undefined } }[];

  if (tagged.length === 0) return [];

  const invoiceIds = tagged.map((t) => t.inv.id);

  const [claims, remittances] = await Promise.all([
    prisma.claim.groupBy({
      by: ["invoiceId"],
      where: { tenantId, invoiceId: { in: invoiceIds }, status: { in: [...RECONCILABLE_CLAIM_STATUSES] } },
      _sum: { approvedAmountMinor: true },
    }),
    prisma.payment.groupBy({
      by: ["invoiceId"],
      where: { tenantId, invoiceId: { in: invoiceIds }, channel: "hmo_direct", status: "SUCCESS" },
      _sum: { amountMinor: true },
    }),
  ]);

  const approvedByInvoice = new Map(claims.map((c) => [c.invoiceId, c._sum.approvedAmountMinor ?? 0n]));
  const receivedByInvoice = new Map(remittances.map((r) => [r.invoiceId, r._sum.amountMinor ?? 0n]));

  const groups = new Map<string, { inv: EpisodeInvoice; category: string | undefined }[]>();
  for (const { inv, tag } of tagged) {
    const list = groups.get(tag.episodeRef) ?? [];
    list.push({ inv, category: tag.category });
    groups.set(tag.episodeRef, list);
  }

  return [...groups.entries()].map(([episodeRef, entries]) => {
    const currency = entries[0]!.inv.currency;

    const items = entries.map(({ inv, category }) => {
      const hmoContributionMinor = approvedByInvoice.get(inv.id) ?? 0n;
      const patientSelfPayMinor = inv.amountMinor - hmoContributionMinor > 0n ? inv.amountMinor - hmoContributionMinor : 0n;
      return {
        invoiceId: inv.id,
        providerInvoiceRef: inv.providerInvoiceRef,
        category: category ?? "Consultation",
        description: inv.description,
        date: inv.createdAt.toISOString(),
        totalCost: { amountMinor: toMinorNumber(inv.amountMinor), currency: inv.currency },
        hmoContribution: { amountMinor: toMinorNumber(hmoContributionMinor), currency: inv.currency },
        patientSelfPay: { amountMinor: toMinorNumber(patientSelfPayMinor), currency: inv.currency },
        paid: { amountMinor: toMinorNumber(inv.paidAmountMinor), currency: inv.currency },
        status: itemStatus(inv),
      };
    });

    const sortedByDate = [...entries].sort((a, b) => a.inv.createdAt.getTime() - b.inv.createdAt.getTime());
    const isActive = entries.some((e) => (ACTIVE_INVOICE_STATUSES as readonly string[]).includes(e.inv.status));

    const totalCostMinor = entries.reduce((sum, e) => sum + e.inv.amountMinor, 0n);
    const hmoCoverMinor = entries.reduce((sum, e) => sum + (approvedByInvoice.get(e.inv.id) ?? 0n), 0n);
    const patientSelfPayMinor = totalCostMinor - hmoCoverMinor > 0n ? totalCostMinor - hmoCoverMinor : 0n;
    const patientPaidMinor = entries.reduce((sum, e) => sum + e.inv.paidAmountMinor, 0n);
    const patientDueMinor = patientSelfPayMinor - patientPaidMinor > 0n ? patientSelfPayMinor - patientPaidMinor : 0n;

    const expectedMinor = entries.reduce((sum, e) => sum + (approvedByInvoice.get(e.inv.id) ?? 0n), 0n);
    const receivedMinor = entries.reduce((sum, e) => sum + (receivedByInvoice.get(e.inv.id) ?? 0n), 0n);
    const varianceMinor = expectedMinor - receivedMinor;

    // No deposit concept exists in this backend yet (nothing to derive it
    // from) — reported honestly as zero rather than invented.
    const depositPaidMinor = 0n;

    return {
      episodeRef,
      facilityRef: sortedByDate[0]!.inv.facilityRef,
      patientRef: sortedByDate[0]!.inv.patientRef,
      startDate: sortedByDate[0]!.inv.createdAt.toISOString(),
      endDate: isActive ? undefined : sortedByDate[sortedByDate.length - 1]!.inv.updatedAt.toISOString(),
      status: isActive ? "active" : "completed",
      items,
      totalCost: { amountMinor: toMinorNumber(totalCostMinor), currency },
      hmoCover: { amountMinor: toMinorNumber(hmoCoverMinor), currency },
      patientSelfPay: { amountMinor: toMinorNumber(patientSelfPayMinor), currency },
      patientPaid: { amountMinor: toMinorNumber(patientPaidMinor), currency },
      patientDue: { amountMinor: toMinorNumber(patientDueMinor), currency },
      depositPaid: { amountMinor: toMinorNumber(depositPaidMinor), currency },
      hmoReceivable: {
        expected: { amountMinor: toMinorNumber(expectedMinor), currency },
        received: { amountMinor: toMinorNumber(receivedMinor), currency },
        variance: { amountMinor: toMinorNumber(varianceMinor), currency },
        status: varianceMinor > 0n ? "UNDERPAID" : varianceMinor < 0n ? "OVERPAID" : "RECONCILED",
      },
    };
  }).sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
}

const episodeRoutes: FastifyPluginAsync = async (app) => {
  // Patient's own view: every episode grouping their own invoices.
  app.get(
    "/patient/episodes",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListEpisodesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;

      // No pagination (see the schema comment) — an episode-tagged invoice
      // set per patient is always small, so one unpaginated fetch is fine.
      const invoices = await prisma.invoice.findMany({ where: { tenantId, patientRef } });
      const episodes = await buildEpisodes(tenantId, invoices);
      return reply.code(200).send({ items: episodes });
    }
  );

  // Staff/billing view: every episode at the tenant, optionally narrowed to
  // one facility or patient.
  app.get(
    "/provider/episodes",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listEpisodesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, patientRef } = parsed.data;

      const invoices = await prisma.invoice.findMany({
        where: {
          tenantId,
          ...(facilityRef ? { facilityRef } : {}),
          ...(patientRef ? { patientRef } : {}),
        },
      });
      const episodes = await buildEpisodes(tenantId, invoices);
      return reply.code(200).send({ items: episodes });
    }
  );
};

export default episodeRoutes;
