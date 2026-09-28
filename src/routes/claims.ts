import type { FastifyPluginAsync } from "fastify";
import { createClaimSchema, listClaimsQuerySchema, updateClaimStatusSchema } from "../schemas/claims.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/claims";

function serializeClaim(claim: {
  id: string; providerClaimRef: string; invoiceId: string; patientRef: string; facilityRef: string;
  payerRef: string; amountMinor: bigint; approvedAmountMinor: bigint | null; currency: string;
  status: string; reason: string | null; submittedAt: Date | null; decidedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    claimId: claim.id,
    providerClaimRef: claim.providerClaimRef,
    invoiceId: claim.invoiceId,
    patientRef: claim.patientRef,
    facilityRef: claim.facilityRef,
    payerRef: claim.payerRef,
    amountMinor: toMinorNumber(claim.amountMinor),
    approvedAmountMinor: claim.approvedAmountMinor != null ? toMinorNumber(claim.approvedAmountMinor) : undefined,
    currency: claim.currency,
    status: claim.status,
    reason: claim.reason ?? undefined,
    submittedAt: claim.submittedAt?.toISOString(),
    decidedAt: claim.decidedAt?.toISOString(),
    createdAt: claim.createdAt.toISOString(),
    updatedAt: claim.updatedAt.toISOString(),
  };
}

// Legal claim-status transitions, keyed by the claim's current status. A
// request to move to any status not listed for the claim's current status
// is a 409 — mirrors the lifecycle the WelliPayPro frontend already drives
// (submit / simulate-approve / simulate-reject / resubmit).
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"],
  APPROVED: [],
  PARTIALLY_APPROVED: [],
  REJECTED: ["SUBMITTED"],
};

const claimRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/claims",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createClaimSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }

      const existing = await prisma.claim.findUnique({
        where: { tenantId_providerClaimRef: { tenantId, providerClaimRef: body.providerClaimRef } },
      });
      if (existing) {
        return sendProblem(reply, problems.conflict(
          `providerClaimRef "${body.providerClaimRef}" already exists for this tenant.`,
          "claim_ref_already_exists"
        ));
      }

      const claim = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const created = await tx.claim.create({
          data: {
            tenantId,
            providerClaimRef: body.providerClaimRef,
            invoiceId: invoice.id,
            patientRef: invoice.patientRef,
            facilityRef: invoice.facilityRef,
            payerRef: body.payerRef,
            amountMinor: toMinorBigInt(body.amountMinor),
            currency: body.currency,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "claim.created",
          resourceRef: created.id,
          data: { claimRef: created.id, invoiceId: invoice.id, payerRef: body.payerRef },
        });
        return created;
      });

      const responseBody = serializeClaim(claim);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/claims/${claim.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/claims",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listClaimsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, patientRef, invoiceId, payerRef, status, limit, cursor } = parsed.data;

      const rows = await prisma.claim.findMany({
        where: {
          tenantId,
          ...(facilityRef ? { facilityRef } : {}),
          ...(patientRef ? { patientRef } : {}),
          ...(invoiceId ? { invoiceId } : {}),
          ...(payerRef ? { payerRef } : {}),
          ...(status ? { status } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeClaim);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.patch(
    "/provider/claims/:claimId/status",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { claimId } = request.params as { claimId: string };
      const parsed = updateClaimStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const claim = await prisma.claim.findFirst({ where: { id: claimId, tenantId } });
      if (!claim) {
        return sendProblem(reply, problems.notFound());
      }

      const allowed = ALLOWED_TRANSITIONS[claim.status] ?? [];
      if (!allowed.includes(body.status)) {
        return sendProblem(reply, problems.conflict(
          `Claim is ${claim.status}; cannot transition to ${body.status}.`,
          "invalid_claim_transition"
        ));
      }
      if (body.status === "REJECTED" && !body.reason) {
        return sendProblem(reply, problems.badRequest("reason is required when rejecting a claim.", "invalid_body"));
      }
      if (body.status === "PARTIALLY_APPROVED" && body.approvedAmountMinor === undefined) {
        return sendProblem(reply, problems.badRequest("approvedAmountMinor is required for a partial approval.", "invalid_body"));
      }

      const now = new Date();
      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const result = await tx.claim.update({
          where: { id: claim.id },
          data: {
            status: body.status,
            reason: body.status === "REJECTED" ? (body.reason ?? null) : null,
            submittedAt: body.status === "SUBMITTED" ? now : claim.submittedAt,
            decidedAt: ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"].includes(body.status) ? now : null,
            approvedAmountMinor:
              body.status === "APPROVED"
                ? toMinorBigInt(body.approvedAmountMinor ?? toMinorNumber(claim.amountMinor))
                : body.status === "PARTIALLY_APPROVED"
                  ? toMinorBigInt(body.approvedAmountMinor!)
                  : null,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "claim.status_changed",
          resourceRef: result.id,
          data: { claimRef: result.id, status: result.status },
        });
        return result;
      });

      return reply.code(200).send(serializeClaim(updated));
    }
  );
};

export default claimRoutes;
