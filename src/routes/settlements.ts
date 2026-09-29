import type { FastifyPluginAsync } from "fastify";
import { createSettlementSchema, listSettlementsQuerySchema } from "../schemas/settlements.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/settlements";

function serializeSettlement(row: {
  id: string; facilityRef: string; amountMinor: bigint; status: string;
  createdAt: Date; settledAt: Date | null; _count?: { payments: number };
}) {
  return {
    settlementId: row.id,
    facilityRef: row.facilityRef,
    amountMinor: toMinorNumber(row.amountMinor),
    status: row.status,
    paymentCount: row._count ? row._count.payments : undefined,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : undefined,
  };
}

const settlementRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/settlements",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createSettlementSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const eligible = await prisma.payment.findMany({
        where: { tenantId, facilityRef: body.facilityRef, status: "SUCCESS", settlementId: null },
        select: { id: true, amountMinor: true },
      });
      if (eligible.length === 0) {
        return sendProblem(reply, problems.conflict("No unsettled successful payments for this facility.", "nothing_to_settle"));
      }
      const totalMinor = eligible.reduce((sum: bigint, p: { amountMinor: bigint }) => sum + p.amountMinor, 0n);

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const settlement = await tx.settlement.create({
          data: { tenantId, facilityRef: body.facilityRef, amountMinor: totalMinor },
        });
        await tx.payment.updateMany({
          where: { id: { in: eligible.map((p: { id: string }) => p.id) } },
          data: { settlementId: settlement.id },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "settlement.created",
          resourceRef: settlement.id,
          data: { settlementRef: settlement.id, facilityRef: body.facilityRef, amountMinor: toMinorNumber(totalMinor), paymentCount: eligible.length },
        });
        return settlement;
      });

      const responseBody = serializeSettlement({ ...created, _count: { payments: eligible.length } });
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/settlements/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/settlements",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listSettlementsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, facilityRef, limit, cursor } = parsed.data;

      const rows = await prisma.settlement.findMany({
        where: { tenantId, ...(status ? { status } : {}), ...(facilityRef ? { facilityRef } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { _count: { select: { payments: true } } },
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializeSettlement(row));
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.patch(
    "/provider/settlements/:id/confirm",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const tenantId = request.auth!.tenantId;

      const existing = await prisma.settlement.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound());
      }
      if (existing.status !== "PENDING") {
        return sendProblem(reply, problems.conflict("Settlement is already settled.", "already_settled"));
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.settlement.update({
          where: { id: existing.id },
          data: { status: "SETTLED", settledAt: new Date() },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "settlement.confirmed",
          resourceRef: row.id,
          data: { settlementRef: row.id, amountMinor: toMinorNumber(row.amountMinor) },
        });
        return row;
      });

      return reply.code(200).send(serializeSettlement(updated));
    }
  );
};

export default settlementRoutes;
