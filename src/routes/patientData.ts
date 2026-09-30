import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import {
  patientListQuerySchema,
  patientListInvoicesQuerySchema,
  patientAcceptConsentSchema,
} from "../schemas/patientData.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

// Every route here is read-only except POST /patient/financial-consents
// (see schemas/patientData.ts for why that one write is allowed). Every
// query filters by request.patientAuth.tenantId + .patientRef — set only
// by requirePatientScope() from a verified patient token — never by
// anything the request itself supplies, exactly like the /provider/*
// routes filter by request.auth.tenantId.

function serializeInvoice(invoice: {
  id: string; providerInvoiceRef: string; facilityRef: string; patientRef: string; description: string;
  amountMinor: bigint; currency: string; paidAmountMinor: bigint; status: string; mobileDeliveryStatus: string;
  dueAt: Date | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    invoiceId: invoice.id,
    providerInvoiceRef: invoice.providerInvoiceRef,
    facilityRef: invoice.facilityRef,
    description: invoice.description,
    amountMinor: toMinorNumber(invoice.amountMinor),
    currency: invoice.currency,
    paidAmountMinor: toMinorNumber(invoice.paidAmountMinor),
    status: invoice.status,
    mobileDeliveryStatus: invoice.mobileDeliveryStatus,
    dueAt: invoice.dueAt?.toISOString(),
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
}

function serializeFundingRequest(row: {
  id: string; providerRequestRef: string; invoiceId: string; status: string;
  fundedAmountMinor: bigint; currency: string; expiresAt: Date | null; createdAt: Date;
  contributions: { id: string; sponsorRef: string; amountMinor: bigint; status: string }[];
}) {
  return {
    requestId: row.id,
    providerRequestRef: row.providerRequestRef,
    invoiceId: row.invoiceId,
    status: row.status,
    fundedAmountMinor: toMinorNumber(row.fundedAmountMinor),
    currency: row.currency,
    expiresAt: row.expiresAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    contributions: row.contributions.map((c) => ({
      contributionId: c.id,
      sponsorRef: c.sponsorRef,
      amountMinor: toMinorNumber(c.amountMinor),
      status: c.status,
    })),
  };
}

function serializeEligibilityCheck(row: {
  id: string; facilityRef: string; payerRef: string; status: string; decision: string;
  reasonCode: string | null; coveredAmountMinor: bigint | null; patientResponsibilityMinor: bigint | null;
  currency: string | null; validUntil: Date | null; requestedAt: Date; checkedAt: Date | null; createdAt: Date;
}) {
  return {
    eligibilityId: row.id,
    facilityRef: row.facilityRef,
    payerRef: row.payerRef,
    status: row.status,
    decision: row.decision,
    reasonCode: row.reasonCode ?? undefined,
    coveredAmount: row.coveredAmountMinor != null ? { amountMinor: toMinorNumber(row.coveredAmountMinor), currency: row.currency ?? "NGN" } : undefined,
    patientResponsibility: row.patientResponsibilityMinor != null ? { amountMinor: toMinorNumber(row.patientResponsibilityMinor), currency: row.currency ?? "NGN" } : undefined,
    validUntil: row.validUntil?.toISOString(),
    requestedAt: row.requestedAt.toISOString(),
    checkedAt: (row.checkedAt ?? row.createdAt).toISOString(),
  };
}

function serializeConsent(row: {
  id: string; facilityRef: string; invoiceId: string; status: string; recordedAt: Date;
}) {
  return {
    consentId: row.id,
    facilityRef: row.facilityRef,
    invoiceId: row.invoiceId,
    status: row.status,
    recordedAt: row.recordedAt.toISOString(),
  };
}

const patientDataRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/patient/invoices",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListInvoicesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.invoice.findMany({
        where: { tenantId, patientRef, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeInvoice);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.get(
    "/patient/invoices/:invoiceId",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const { invoiceId } = request.params as { invoiceId: string };
      const { tenantId, patientRef } = request.patientAuth!;

      // Same 404 whether the invoice doesn't exist, belongs to another
      // tenant, or belongs to another patient at this tenant — resource
      // existence is never confirmed outside the credential's own scope.
      const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId, patientRef } });
      if (!invoice) {
        return sendProblem(reply, problems.notFound());
      }
      return reply.code(200).send(serializeInvoice(invoice));
    }
  );

  app.get(
    "/patient/family-funding-requests",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { limit, cursor } = parsed.data;

      const rows = await prisma.familyFundingRequest.findMany({
        where: { tenantId, patientRef },
        include: { contributions: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeFundingRequest);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.get(
    "/patient/eligibility-checks",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { limit, cursor } = parsed.data;

      const rows = await prisma.eligibilityCheck.findMany({
        where: { tenantId, patientRef },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeEligibilityCheck);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.get(
    "/patient/financial-consents",
    { preHandler: app.requirePatientScope("patient.self.read") },
    async (request, reply) => {
      const parsed = patientListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const { limit, cursor } = parsed.data;

      const rows = await prisma.financialConsent.findMany({
        where: { tenantId, patientRef },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeConsent);
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  const ACCEPT_CONSENT_ROUTE = "POST /patient/financial-consents";
  app.post(
    "/patient/financial-consents",
    { preHandler: app.requirePatientScope("patient.self.write") },
    async (request, reply) => {
      const parsed = patientAcceptConsentSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { tenantId, patientRef } = request.patientAuth!;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, ACCEPT_CONSENT_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      // The invoice must be this patient's own, at this tenant — never
      // trust facilityRef/patientRef from the request body (there is none;
      // both are derived below, from the invoice and the token).
      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId, patientRef } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this account.`, "unknown_invoice"));
      }

      const splitTotal = body.payerSplit.reduce((sum, s) => sum + s.amountMinor, 0);
      if (BigInt(splitTotal) !== invoice.amountMinor) {
        return sendProblem(
          reply,
          problems.unprocessable(
            `payerSplit totals ${splitTotal} but the invoice amount is ${invoice.amountMinor}. The accepted split must account for the full invoice.`,
            "split_does_not_match_invoice"
          )
        );
      }

      const existing = await prisma.financialConsent.findUnique({
        where: { tenantId_providerConsentRef: { tenantId, providerConsentRef: body.providerConsentRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(`providerConsentRef "${body.providerConsentRef}" already exists for this tenant.`, "consent_ref_already_exists"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const consent = await tx.financialConsent.create({
          data: {
            tenantId,
            providerConsentRef: body.providerConsentRef,
            facilityRef: invoice.facilityRef,
            patientRef,
            invoiceId: body.invoiceId,
            estimateRevision: body.estimateRevision,
            policyVersion: body.policyVersion,
            acceptedAt: new Date(),
            // Distinguishes a patient's own acceptance from one recorded by
            // provider staff (POST /provider/financial-consents leaves this
            // null unless staff pass their own actorRef).
            actorRef: `patient:${patientRef}`,
            payerSplit: {
              create: body.payerSplit.map((s) => ({
                payerType: s.payerType,
                payerRef: s.payerRef ?? null,
                amountMinor: toMinorBigInt(s.amountMinor),
                currency: s.currency,
              })),
            },
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "consent.recorded",
          resourceRef: consent.id,
          data: { consentRef: consent.id, invoiceId: body.invoiceId },
        });
        return consent;
      });

      const responseBody = serializeConsent(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).send(responseBody);
    }
  );
};

export default patientDataRoutes;
