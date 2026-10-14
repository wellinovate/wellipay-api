import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canSeeCost } from "../lib/costAccess.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { createProductSchema, updateProductSchema, listProductsQuery, serviceOffersSchema } from "../schemas/pharmacy.js";
import { CATEGORY_LABEL, newSku, productDisplayName, productProblem } from "../lib/pharmacyProducts.js";
import { daysToExpiry, expiryState, onHand, stockLevel, type BatchLike } from "../lib/pharmacyStock.js";
import { PHARMACY_SERVICES, findPharmacyService } from "../data/pharmacyServices.js";
import { serialize as serializeItem } from "./serviceItems.js";

interface ProductRow {
  id: string;
  category: string;
  genericName: string;
  brandName: string | null;
  strength: string | null;
  dosageForm: string | null;
  packSize: string | null;
  unit: string;
  sku: string;
  barcode: string | null;
  nafdacNumber: string | null;
  manufacturer: string | null;
  priceMinor: number;
  dispensingClass: string;
  reorderLevel: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface BatchRow extends BatchLike {
  batchNo: string;
  quantityReceived: number;
  costMinor: number | null;
  supplierId: string | null;
  quarantineReason: string | null;
}

export function serializeBatch(b: BatchRow, today: Date = new Date(), showCost = false) {
  return {
    batchId: b.id,
    batchNo: b.batchNo,
    expiryDate: b.expiryDate ? b.expiryDate.toISOString().slice(0, 10) : undefined,
    expiryState: expiryState(b.expiryDate, today),
    daysToExpiry: daysToExpiry(b.expiryDate, today) ?? undefined,
    quantityReceived: b.quantityReceived,
    quantityOnHand: b.quantityOnHand,
    costMinor: showCost ? (b.costMinor ?? undefined) : undefined,
    supplierId: b.supplierId ?? undefined,
    status: b.status,
    quarantineReason: b.quarantineReason ?? undefined,
    receivedAt: b.receivedAt.toISOString(),
  };
}

export function serializeProduct(p: ProductRow, batches: BatchRow[], today: Date = new Date()) {
  const available = onHand(batches, today);
  const dated = batches.filter((b) => b.quantityOnHand > 0 && b.expiryDate && b.status === "ACTIVE" && expiryState(b.expiryDate, today) !== "EXPIRED");
  const nearest = dated.map((b) => b.expiryDate as Date).sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    productId: p.id,
    category: p.category,
    genericName: p.genericName,
    brandName: p.brandName ?? undefined,
    strength: p.strength ?? undefined,
    dosageForm: p.dosageForm ?? undefined,
    packSize: p.packSize ?? undefined,
    unit: p.unit,
    sku: p.sku,
    barcode: p.barcode ?? undefined,
    nafdacNumber: p.nafdacNumber ?? undefined,
    manufacturer: p.manufacturer ?? undefined,
    priceMinor: p.priceMinor,
    dispensingClass: p.dispensingClass,
    requiresPrescription: p.dispensingClass !== "OTC",
    reorderLevel: p.reorderLevel,
    active: p.active,
    displayName: productDisplayName(p),
    available,
    stockLevel: stockLevel(available, p.reorderLevel),
    expiredOnHand: batches.filter((b) => b.quantityOnHand > 0 && expiryState(b.expiryDate, today) === "EXPIRED").reduce((s, b) => s + b.quantityOnHand, 0),
    nearestExpiry: nearest ? nearest.toISOString().slice(0, 10) : undefined,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const pharmacyProductRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/pharmacy/products", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listProductsQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const tenantId = request.auth!.tenantId;
    const { q, category, dispensingClass, stock, includeInactive } = parsed.data;
    const rows = await prisma.pharmacyProduct.findMany({
      where: {
        tenantId,
        ...(includeInactive ? {} : { active: true }),
        ...(category ? { category } : {}),
        ...(dispensingClass ? { dispensingClass } : {}),
        ...(q
          ? {
              OR: [
                { genericName: { contains: q, mode: "insensitive" as const } },
                { brandName: { contains: q, mode: "insensitive" as const } },
                { sku: { contains: q, mode: "insensitive" as const } },
                { barcode: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ category: "asc" }, { genericName: "asc" }],
      take: 500,
      include: { batches: true },
    });
    const today = new Date();
    let items = rows.map((r: ProductRow & { batches: BatchRow[] }) => serializeProduct(r, r.batches, today));
    if (stock === "low") items = items.filter((i) => i.stockLevel === "LOW");
    if (stock === "out") items = items.filter((i) => i.stockLevel === "OUT");
    return reply.code(200).send({ items, categories: CATEGORY_LABEL });
  });

  app.get("/provider/pharmacy/products/:id", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await prisma.pharmacyProduct.findFirst({ where: { id, tenantId: request.auth!.tenantId }, include: { batches: { orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }] } } });
    if (!row) return sendProblem(reply, problems.notFound("Product not found."));
    const today = new Date();
    return reply.code(200).send({ ...serializeProduct(row, row.batches, today), batches: row.batches.map((b: BatchRow) => serializeBatch(b, today, canSeeCost(request.auth))) });
  });

  // A product also gets a price-list entry, so it can go on an invoice like any item.
  app.post("/provider/pharmacy/products", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createProductSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const problem = productProblem(body);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_product"));
    const sku = body.sku ?? newSku(body.category);
    if (await prisma.pharmacyProduct.findUnique({ where: { tenantId_sku: { tenantId, sku } } })) {
      return sendProblem(reply, problems.conflict(`SKU "${sku}" is already used.`, "sku_exists"));
    }
    const createdBy = resolveActor(request.auth, undefined) ?? null;
    const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const product = await tx.pharmacyProduct.create({
        data: {
          tenantId,
          category: body.category,
          genericName: body.genericName,
          unit: body.unit,
          sku,
          priceMinor: body.priceMinor,
          dispensingClass: body.dispensingClass,
          reorderLevel: body.reorderLevel,
          createdBy,
          ...(body.brandName !== undefined ? { brandName: body.brandName } : {}),
          ...(body.strength !== undefined ? { strength: body.strength } : {}),
          ...(body.dosageForm !== undefined ? { dosageForm: body.dosageForm } : {}),
          ...(body.packSize !== undefined ? { packSize: body.packSize } : {}),
          ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
          ...(body.nafdacNumber !== undefined ? { nafdacNumber: body.nafdacNumber } : {}),
          ...(body.manufacturer !== undefined ? { manufacturer: body.manufacturer } : {}),
        },
      });
      const display = productDisplayName(product);
      const clash = await tx.serviceItem.findUnique({ where: { tenantId_name: { tenantId, name: display } } });
      await tx.serviceItem.create({
        data: {
          tenantId,
          name: clash ? `${display} [${sku}]`.slice(0, 120) : display,
          category: CATEGORY_LABEL[body.category] ?? "Pharmacy",
          unitPriceMinor: body.priceMinor,
          serviceCode: sku,
          productId: product.id,
          createdBy,
        },
      });
      return product;
    });
    return reply.code(201).send(serializeProduct(created, []));
  });

  app.patch("/provider/pharmacy/products/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateProductSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.pharmacyProduct.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Product not found."));
    const b = parsed.data;
    const merged = {
      category: existing.category,
      genericName: b.genericName ?? existing.genericName,
      brandName: b.brandName === undefined ? existing.brandName : b.brandName,
      strength: b.strength === undefined ? existing.strength : b.strength,
      dosageForm: b.dosageForm === undefined ? existing.dosageForm : b.dosageForm,
      packSize: b.packSize === undefined ? existing.packSize : b.packSize,
      dispensingClass: b.dispensingClass ?? existing.dispensingClass,
    };
    const problem = productProblem(merged);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_product"));
    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.pharmacyProduct.update({
        where: { id },
        data: {
          ...(b.genericName !== undefined ? { genericName: b.genericName } : {}),
          ...(b.brandName !== undefined ? { brandName: b.brandName } : {}),
          ...(b.strength !== undefined ? { strength: b.strength } : {}),
          ...(b.dosageForm !== undefined ? { dosageForm: b.dosageForm } : {}),
          ...(b.packSize !== undefined ? { packSize: b.packSize } : {}),
          ...(b.unit !== undefined ? { unit: b.unit } : {}),
          ...(b.barcode !== undefined ? { barcode: b.barcode } : {}),
          ...(b.nafdacNumber !== undefined ? { nafdacNumber: b.nafdacNumber } : {}),
          ...(b.manufacturer !== undefined ? { manufacturer: b.manufacturer } : {}),
          ...(b.priceMinor !== undefined ? { priceMinor: b.priceMinor } : {}),
          ...(b.dispensingClass !== undefined ? { dispensingClass: b.dispensingClass } : {}),
          ...(b.reorderLevel !== undefined ? { reorderLevel: b.reorderLevel } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
        },
      });
      // Keep the price-list entry in step. Old invoices keep the name and price they were made with.
      const display = productDisplayName(row);
      const clash = await tx.serviceItem.findFirst({ where: { tenantId, name: display, NOT: { productId: id } } });
      await tx.serviceItem.updateMany({
        where: { productId: id, tenantId },
        data: {
          ...(b.priceMinor !== undefined ? { unitPriceMinor: b.priceMinor } : {}),
          ...(b.active !== undefined ? { active: b.active } : {}),
          ...(clash ? {} : { name: display }),
        },
      });
      return row;
    });
    const batches = await prisma.stockBatch.findMany({ where: { productId: id } });
    return reply.code(200).send(serializeProduct(updated, batches));
  });

  // Pharmacy services a pharmacy can switch on, with the provider's own offer joined to each.
  app.get("/provider/pharmacy/services", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const offered = await prisma.serviceItem.findMany({ where: { tenantId: request.auth!.tenantId, masterCode: { startsWith: "PHS-" } } });
    const byCode = new Map(offered.map((o: { masterCode: string | null }) => [o.masterCode as string, o]));
    return reply.code(200).send({
      services: PHARMACY_SERVICES.map((s) => {
        const item = byCode.get(s.code);
        return { ...s, offer: item ? serializeItem(item as Parameters<typeof serializeItem>[0]) : undefined };
      }),
    });
  });

  app.post("/provider/pharmacy/services/offers", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = serviceOffersSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const createdBy = resolveActor(request.auth, undefined) ?? null;
    const seen = new Set<string>();
    for (const s of parsed.data.services) {
      if (!findPharmacyService(s.code)) return sendProblem(reply, problems.unprocessable(`"${s.code}" is not a pharmacy service.`, "unknown_service"));
      if (seen.has(s.code)) return sendProblem(reply, problems.unprocessable(`"${s.code}" is listed twice.`, "duplicate_service"));
      seen.add(s.code);
    }
    const existing = await prisma.serviceItem.findMany({ where: { tenantId }, select: { name: true, masterCode: true } });
    const usedNames = new Set(existing.map((e: { name: string }) => e.name.toLowerCase()));
    const usedCodes = new Set(existing.map((e: { masterCode: string | null }) => e.masterCode).filter((c: string | null): c is string => !!c));
    const created: ReturnType<typeof serializeItem>[] = [];
    const skipped: { code: string; reason: string }[] = [];
    for (const s of parsed.data.services) {
      const t = findPharmacyService(s.code)!;
      if (usedCodes.has(t.code)) { skipped.push({ code: t.code, reason: "already_offered" }); continue; }
      if (usedNames.has(t.name.toLowerCase())) { skipped.push({ code: t.code, reason: "name_in_use" }); continue; }
      const row = await prisma.serviceItem.create({
        data: { tenantId, name: t.name, category: t.category, unitPriceMinor: s.unitPriceMinor, masterCode: t.code, turnaround: t.turnaround, createdBy },
      });
      created.push(serializeItem(row));
    }
    return reply.code(201).send({ created, skipped });
  });
};

export default pharmacyProductRoutes;
