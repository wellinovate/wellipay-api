import type { FastifyPluginAsync } from "fastify";
import {
  createPartnerSchema,
  listPartnersQuerySchema,
  createReferralSchema,
  listReferralsQuerySchema,
  updateReferralStatusSchema,
} from "../schemas/partners.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import type { Prisma } from "@prisma/client";

const CREATE_PARTNER_ROUTE = "POST /provider/partners";
const CREATE_REFERRAL_ROUTE = "POST /provider/referrals";

function serializePartner(row: { id: string; name: string; type: string; status: string; createdAt: Date }) {
  return { partnerId: row.id, name: row.name, type: row.type, status: row.status, createdAt: row.createdAt.toISOString() };
}

function serializeReferral(row: {
  id: string; partnerId: string; facilityRef: string; patientRef: string; description: string;
  status: string; createdAt: Date; completedAt: Date | null;
}) {
  return {
    referralId: row.id,
    partnerId: row.partnerId,
    facilityRef: row.facilityRef,
    patientRef: row.patientRef,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
  };
}

// Directory of outside labs/pharmacies/diagnostic centres a facility refers
// patients to, plus a log of the referrals sent. No routing or billing logic
// — see the Partner/Referral model comments.
const partnerRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/partners",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createPartnerSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_PARTNER_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const created = await prisma.partner.create({ data: { tenantId, name: body.name, type: body.type } });
      const responseBody = serializePartner(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/partners/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/partners",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listPartnersQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.partner.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializePartner(row));
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.post(
    "/provider/referrals",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createReferralSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_REFERRAL_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const partner = await prisma.partner.findFirst({ where: { id: body.partnerId, tenantId } });
      if (!partner) {
        return sendProblem(reply, problems.unprocessable(`partnerId "${body.partnerId}" does not exist for this tenant.`, "unknown_partner"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const referral = await tx.referral.create({
          data: {
            tenantId,
            partnerId: partner.id,
            facilityRef: body.facilityRef,
            patientRef: body.patientRef,
            description: body.description,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "referral.sent",
          resourceRef: referral.id,
          data: { referralId: referral.id, partnerId: partner.id, partnerName: partner.name },
        });
        return referral;
      });

      const responseBody = serializeReferral(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/referrals/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/referrals",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listReferralsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, partnerId, limit, cursor } = parsed.data;

      const rows = await prisma.referral.findMany({
        where: { tenantId, ...(status ? { status } : {}), ...(partnerId ? { partnerId } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeReferral(row));
      return reply.code(200).send({ items, nextCursor: hasMore ? rows[limit - 1]!.id : undefined });
    }
  );

  app.patch(
    "/provider/referrals/:id/status",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = updateReferralStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const { id } = request.params as { id: string };
      const tenantId = request.auth!.tenantId;

      const existing = await prisma.referral.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound());
      }
      if (existing.status === "COMPLETED") {
        return sendProblem(reply, problems.conflict("Referral is already completed.", "already_completed"));
      }

      const updated = await prisma.referral.update({
        where: { id: existing.id },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      return reply.code(200).send(serializeReferral(updated));
    }
  );
};

export default partnerRoutes;
