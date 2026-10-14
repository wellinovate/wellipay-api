import type { FastifyPluginAsync } from "fastify";
import {
  listCatalogueQuerySchema,
  offerTestsSchema,
  createCheckupPackageSchema,
  updateCheckupPackageSchema,
} from "../schemas/catalogue.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { CATALOGUE_CATEGORIES, DIAGNOSTIC_CATALOGUE, categoryName, findCatalogueTest } from "../data/diagnosticCatalogue.js";
import { checkupProblem } from "../lib/checkups.js";
import { serialize as serializeItem } from "./serviceItems.js";

interface PackageRow {
  id: string;
  name: string;
  tier: string;
  audience: string;
  priceMinor: number;
  includedIds: string[];
  exclusions: string | null;
  available: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function serializePackage(row: PackageRow) {
  return {
    checkupPackageId: row.id,
    name: row.name,
    tier: row.tier,
    audience: row.audience,
    priceMinor: row.priceMinor,
    includedIds: row.includedIds,
    exclusions: row.exclusions ?? undefined,
    available: row.available,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const catalogueRoutes: FastifyPluginAsync = async (app) => {
  // The master list, with the provider's own offer joined to each test.
  app.get("/provider/catalogue/diagnostic-tests", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listCatalogueQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const { q, category } = parsed.data;
    const offered = await prisma.serviceItem.findMany({
      where: { tenantId: request.auth!.tenantId, masterCode: { not: null } },
    });
    const byCode = new Map(offered.map((o) => [o.masterCode as string, o]));
    const needle = q?.toLowerCase();
    const tests = DIAGNOSTIC_CATALOGUE.filter(
      (t) => (!category || t.categoryCode === category.toUpperCase()) && (!needle || t.name.toLowerCase().includes(needle) || t.code.toLowerCase().includes(needle)),
    ).map((t) => {
      const item = byCode.get(t.code);
      return {
        code: t.code,
        name: t.name,
        categoryCode: t.categoryCode,
        category: categoryName(t.categoryCode),
        sampleType: t.sampleType,
        checkups: t.checkups,
        offer: item ? serializeItem(item) : undefined,
      };
    });
    return reply.code(200).send({ categories: CATALOGUE_CATEGORIES, tests });
  });

  // Add master tests to the provider's price list. Tests already offered, or
  // whose name is already used by another item, are skipped and reported.
  app.post("/provider/catalogue/diagnostic-tests/offers", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = offerTestsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const createdBy = resolveActor(request.auth, undefined) ?? null;
    const seen = new Set<string>();
    for (const t of parsed.data.tests) {
      if (!findCatalogueTest(t.code)) return sendProblem(reply, problems.unprocessable(`"${t.code}" is not in the master catalogue.`, "unknown_test"));
      if (seen.has(t.code)) return sendProblem(reply, problems.unprocessable(`"${t.code}" is listed twice.`, "duplicate_test"));
      seen.add(t.code);
    }
    const existing = await prisma.serviceItem.findMany({ where: { tenantId }, select: { name: true, masterCode: true } });
    const usedNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const usedCodes = new Set(existing.map((e) => e.masterCode).filter((c): c is string => !!c));
    const created: ReturnType<typeof serializeItem>[] = [];
    const skipped: { code: string; reason: string }[] = [];
    for (const t of parsed.data.tests) {
      const master = findCatalogueTest(t.code)!;
      if (usedCodes.has(master.code)) {
        skipped.push({ code: master.code, reason: "already_offered" });
        continue;
      }
      if (usedNames.has(master.name.toLowerCase())) {
        skipped.push({ code: master.code, reason: "name_in_use" });
        continue;
      }
      const row = await prisma.serviceItem.create({
        data: {
          tenantId,
          name: master.name,
          category: categoryName(master.categoryCode),
          unitPriceMinor: t.unitPriceMinor,
          masterCode: master.code,
          sampleType: master.sampleType,
          ...(t.turnaround !== undefined ? { turnaround: t.turnaround } : {}),
          ...(t.preparation !== undefined ? { preparation: t.preparation } : {}),
          ...(t.homeCollection !== undefined ? { homeCollection: t.homeCollection } : {}),
          ...(t.digitalResults !== undefined ? { digitalResults: t.digitalResults } : {}),
          createdBy,
        },
      });
      created.push(serializeItem(row));
    }
    return reply.code(201).send({ created, skipped });
  });

  app.get("/provider/checkup-packages", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const rows = await prisma.checkupPackage.findMany({
      where: { tenantId: request.auth!.tenantId },
      orderBy: [{ tier: "asc" }, { name: "asc" }],
      take: 200,
    });
    return reply.code(200).send({ items: rows.map(serializePackage) });
  });

  app.post("/provider/checkup-packages", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createCheckupPackageSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const clash = await prisma.checkupPackage.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already a check-up package.`, "checkup_package_exists"));
    const items = await prisma.serviceItem.findMany({ where: { tenantId }, select: { id: true, active: true, componentIds: true } });
    const problem = checkupProblem(body.includedIds, items);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_checkup_package"));
    const created = await prisma.checkupPackage.create({
      data: {
        tenantId,
        name: body.name,
        tier: body.tier,
        priceMinor: body.priceMinor,
        includedIds: body.includedIds,
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(body.exclusions !== undefined ? { exclusions: body.exclusions } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
        createdBy: resolveActor(request.auth, undefined) ?? null,
      },
    });
    return reply.code(201).send(serializePackage(created));
  });

  app.patch("/provider/checkup-packages/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateCheckupPackageSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.checkupPackage.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Check-up package not found."));
    const body = parsed.data;
    if (body.name && body.name !== existing.name) {
      const clash = await prisma.checkupPackage.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
      if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already a check-up package.`, "checkup_package_exists"));
    }
    if (body.includedIds) {
      const items = await prisma.serviceItem.findMany({ where: { tenantId }, select: { id: true, active: true, componentIds: true } });
      const problem = checkupProblem(body.includedIds, items);
      if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_checkup_package"));
    }
    const updated = await prisma.checkupPackage.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.tier !== undefined ? { tier: body.tier } : {}),
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(body.priceMinor !== undefined ? { priceMinor: body.priceMinor } : {}),
        ...(body.includedIds !== undefined ? { includedIds: body.includedIds } : {}),
        ...(body.exclusions !== undefined ? { exclusions: body.exclusions } : {}),
        ...(body.available !== undefined ? { available: body.available } : {}),
      },
    });
    return reply.code(200).send(serializePackage(updated));
  });
};

export default catalogueRoutes;
