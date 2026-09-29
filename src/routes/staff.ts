import type { FastifyPluginAsync } from "fastify";
import { createStaffSchema, listStaffQuerySchema, updateStaffStatusSchema } from "../schemas/staff.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/staff";

function serializeStaff(row: {
  id: string; name: string; email: string; role: string; branch: string | null;
  status: string; invitedAt: Date; deactivatedAt: Date | null;
}) {
  return {
    staffId: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    branch: row.branch ?? undefined,
    status: row.status,
    invitedAt: row.invitedAt.toISOString(),
    deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : undefined,
  };
}

const staffRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/staff",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createStaffSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.staff.create({
          data: { tenantId, name: body.name, email: body.email, role: body.role, branch: body.branch ?? null },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "staff.invited",
          resourceRef: row.id,
          data: { staffRef: row.id, name: row.name, role: row.role },
        });
        return row;
      });

      const responseBody = serializeStaff(created);
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/staff/${created.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/staff",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listStaffQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.staff.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeStaff);
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.patch(
    "/provider/staff/:id/status",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = updateStaffStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const existing = await prisma.staff.findFirst({ where: { id, tenantId } });
      if (!existing) {
        return sendProblem(reply, problems.notFound());
      }
      if (existing.status === body.status) {
        return sendProblem(reply, problems.conflict(`Staff member is already ${body.status.toLowerCase()}.`, "no_status_change"));
      }

      const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const row = await tx.staff.update({
          where: { id: existing.id },
          data: {
            status: body.status,
            deactivatedAt: body.status === "DEACTIVATED" ? new Date() : null,
          },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: body.status === "DEACTIVATED" ? "staff.deactivated" : "staff.reactivated",
          resourceRef: row.id,
          data: { staffRef: row.id, status: row.status },
        });
        return row;
      });

      return reply.code(200).send(serializeStaff(updated));
    }
  );
};

export default staffRoutes;
