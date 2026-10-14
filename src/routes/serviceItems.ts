import type { FastifyPluginAsync } from "fastify";
import { createServiceItemSchema, updateServiceItemSchema, listServiceItemsQuerySchema } from "../schemas/serviceItems.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { packageProblem } from "../lib/packages.js";

export interface ServiceItemRow {
  id: string;
  name: string;
  category: string | null;
  unitPriceMinor: number;
  active: boolean;
  componentIds: string[];
  serviceCode: string | null;
  masterCode: string | null;
  sampleType: string | null;
  turnaround: string | null;
  preparation: string | null;
  homeCollection: boolean;
  digitalResults: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function serialize(row: ServiceItemRow) {
  return {
    serviceItemId: row.id,
    name: row.name,
    category: row.category ?? undefined,
    unitPriceMinor: row.unitPriceMinor,
    active: row.active,
    isPackage: row.componentIds.length > 0,
    componentIds: row.componentIds,
    serviceCode: row.serviceCode ?? undefined,
    masterCode: row.masterCode ?? undefined,
    sampleType: row.sampleType ?? undefined,
    turnaround: row.turnaround ?? undefined,
    preparation: row.preparation ?? undefined,
    homeCollection: row.homeCollection,
    digitalResults: row.digitalResults,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const serviceItemRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/service-items", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listServiceItemsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const { q, includeInactive } = parsed.data;
    const rows = await prisma.serviceItem.findMany({
      where: {
        tenantId: request.auth!.tenantId,
        ...(includeInactive ? {} : { active: true }),
        ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      take: 500,
    });
    return reply.code(200).send({ items: rows.map(serialize) });
  });

  app.post("/provider/service-items", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createServiceItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const clash = await prisma.serviceItem.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already on the price list.`, "service_item_exists"));
    const componentIds = body.componentIds ?? [];
    if (componentIds.length > 0) {
      const items = await prisma.serviceItem.findMany({ where: { tenantId }, select: { id: true, active: true, componentIds: true } });
      const problem = packageProblem(componentIds, items);
      if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_package"));
    }
    const created = await prisma.serviceItem.create({
      data: {
        tenantId,
        componentIds,
        name: body.name,
        category: body.category ?? null,
        unitPriceMinor: body.unitPriceMinor,
        ...(body.serviceCode !== undefined ? { serviceCode: body.serviceCode } : {}),
        ...(body.sampleType !== undefined ? { sampleType: body.sampleType } : {}),
        ...(body.turnaround !== undefined ? { turnaround: body.turnaround } : {}),
        ...(body.preparation !== undefined ? { preparation: body.preparation } : {}),
        ...(body.homeCollection !== undefined ? { homeCollection: body.homeCollection } : {}),
        ...(body.digitalResults !== undefined ? { digitalResults: body.digitalResults } : {}),
        createdBy: resolveActor(request.auth, undefined) ?? null,
      },
    });
    return reply.code(201).send(serialize(created));
  });

  app.patch("/provider/service-items/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateServiceItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.serviceItem.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Price list item not found."));
    const body = parsed.data;
    if (body.name && body.name !== existing.name) {
      const clash = await prisma.serviceItem.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
      if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already on the price list.`, "service_item_exists"));
    }
    if (body.componentIds && body.componentIds.length > 0) {
      const items = await prisma.serviceItem.findMany({ where: { tenantId }, select: { id: true, active: true, componentIds: true } });
      const problem = packageProblem(body.componentIds, items, id);
      if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_package"));
      const insideOther = await prisma.serviceItem.findFirst({ where: { tenantId, componentIds: { has: id } } });
      if (insideOther) return sendProblem(reply, problems.unprocessable(`"${existing.name}" is part of "${insideOther.name}", so it cannot become a package.`, "invalid_package"));
    }
    const updated = await prisma.serviceItem.update({
      where: { id },
      data: {
        ...(body.componentIds !== undefined ? { componentIds: body.componentIds } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.unitPriceMinor !== undefined ? { unitPriceMinor: body.unitPriceMinor } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        ...(body.serviceCode !== undefined ? { serviceCode: body.serviceCode } : {}),
        ...(body.sampleType !== undefined ? { sampleType: body.sampleType } : {}),
        ...(body.turnaround !== undefined ? { turnaround: body.turnaround } : {}),
        ...(body.preparation !== undefined ? { preparation: body.preparation } : {}),
        ...(body.homeCollection !== undefined ? { homeCollection: body.homeCollection } : {}),
        ...(body.digitalResults !== undefined ? { digitalResults: body.digitalResults } : {}),
      },
    });
    return reply.code(200).send(serialize(updated));
  });
};

export default serviceItemRoutes;
