import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { courierSchema, updateCourierSchema } from "../schemas/pharmacyOrders.js";
import { newCourierSecret, templateProblem } from "../lib/courier.js";

interface CourierRow {
  id: string;
  name: string;
  kind: string;
  phone: string | null;
  trackingUrlTemplate: string | null;
  webhookSecret: string | null;
  active: boolean;
  createdAt: Date;
}

// The secret is shown once, when it is made. After that only whether one exists.
function serialize(c: CourierRow, secret?: string) {
  return {
    courierId: c.id,
    name: c.name,
    kind: c.kind,
    phone: c.phone ?? undefined,
    trackingUrlTemplate: c.trackingUrlTemplate ?? undefined,
    hasWebhookSecret: !!c.webhookSecret,
    ...(secret ? { webhookSecret: secret } : {}),
    active: c.active,
    createdAt: c.createdAt.toISOString(),
  };
}

const pharmacyCourierRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/pharmacy/couriers", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const rows = await prisma.courier.findMany({ where: { tenantId: request.auth!.tenantId }, orderBy: [{ active: "desc" }, { name: "asc" }] });
    return reply.code(200).send({ items: rows.map((r: CourierRow) => serialize(r)) });
  });

  app.post("/provider/pharmacy/couriers", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = courierSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const b = parsed.data;
    const bad = templateProblem(b.trackingUrlTemplate || undefined);
    if (bad) return sendProblem(reply, problems.unprocessable(bad, "invalid_tracking_link"));
    // Only a partner that reports through a webhook needs a secret.
    const secret = b.kind === "PARTNER" ? newCourierSecret() : undefined;
    const row = await prisma.courier.create({
      data: {
        tenantId: request.auth!.tenantId,
        name: b.name,
        kind: b.kind,
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.trackingUrlTemplate ? { trackingUrlTemplate: b.trackingUrlTemplate } : {}),
        ...(secret ? { webhookSecret: secret } : {}),
      },
    });
    return reply.code(201).send(serialize(row, secret));
  });

  app.patch("/provider/pharmacy/couriers/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateCourierSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const b = parsed.data;
    const bad = templateProblem(b.trackingUrlTemplate || undefined);
    if (bad) return sendProblem(reply, problems.unprocessable(bad, "invalid_tracking_link"));
    const existing = await prisma.courier.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Courier not found."));
    const row = await prisma.courier.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.trackingUrlTemplate !== undefined ? { trackingUrlTemplate: b.trackingUrlTemplate || null } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    return reply.code(200).send(serialize(row));
  });

  // A new secret replaces the old one at once. The partner must be given the new one.
  app.post("/provider/pharmacy/couriers/:id/rotate-secret", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.courier.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Courier not found."));
    if (existing.kind !== "PARTNER") return sendProblem(reply, problems.conflict("Only a delivery partner reports through a webhook.", "not_a_partner"));
    const secret = newCourierSecret();
    const row = await prisma.courier.update({ where: { id }, data: { webhookSecret: secret } });
    return reply.code(200).send(serialize(row, secret));
  });
};

export default pharmacyCourierRoutes;
