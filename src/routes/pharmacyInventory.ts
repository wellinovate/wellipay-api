import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canSeeCost } from "../lib/costAccess.js";
import { appendRegisterEntry, isControlledClass } from "../lib/controlledRegister.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import {
  createSupplierSchema,
  updateSupplierSchema,
  receiptSchema,
  adjustmentSchema,
  writeOffSchema,
  quarantineSchema,
  movementsQuery,
} from "../schemas/pharmacy.js";
import { adjustmentProblem, daysToExpiry, expiryState, onHand, receiptProblem, stockLevel, NEAR_EXPIRY_DAYS, type BatchLike } from "../lib/pharmacyStock.js";
import { productDisplayName } from "../lib/pharmacyProducts.js";

function serializeSupplier(s: { id: string; name: string; contactName: string | null; phone: string | null; email: string | null; address: string | null; active: boolean; createdAt: Date }) {
  return {
    supplierId: s.id,
    name: s.name,
    contactName: s.contactName ?? undefined,
    phone: s.phone ?? undefined,
    email: s.email ?? undefined,
    address: s.address ?? undefined,
    active: s.active,
    createdAt: s.createdAt.toISOString(),
  };
}

function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// The pharmacy's stock workspace: suppliers, receipts, adjustments, write-offs,
// recalls, the movement ledger and alerts. Dispensing lives in pharmacyOrders.
const pharmacyInventoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/pharmacy/suppliers", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const rows = await prisma.supplier.findMany({ where: { tenantId: request.auth!.tenantId }, orderBy: { name: "asc" }, take: 300 });
    return reply.code(200).send({ items: rows.map(serializeSupplier) });
  });

  app.post("/provider/pharmacy/suppliers", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createSupplierSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    if (await prisma.supplier.findUnique({ where: { tenantId_name: { tenantId, name: b.name } } })) {
      return sendProblem(reply, problems.conflict(`"${b.name}" is already a supplier.`, "supplier_exists"));
    }
    const row = await prisma.supplier.create({
      data: {
        tenantId,
        name: b.name,
        ...(b.contactName !== undefined ? { contactName: b.contactName } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(b.address !== undefined ? { address: b.address } : {}),
      },
    });
    return reply.code(201).send(serializeSupplier(row));
  });

  app.patch("/provider/pharmacy/suppliers/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateSupplierSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.supplier.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Supplier not found."));
    const b = parsed.data;
    if (b.name && b.name !== existing.name && (await prisma.supplier.findUnique({ where: { tenantId_name: { tenantId, name: b.name } } }))) {
      return sendProblem(reply, problems.conflict(`"${b.name}" is already a supplier.`, "supplier_exists"));
    }
    const row = await prisma.supplier.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.contactName !== undefined ? { contactName: b.contactName } : {}),
        ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(b.address !== undefined ? { address: b.address } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
    });
    return reply.code(200).send(serializeSupplier(row));
  });

  // Receive stock. The same product, batch number and expiry date adds to one batch.
  app.post("/provider/pharmacy/stock/receipts", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = receiptSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    const product = await prisma.pharmacyProduct.findFirst({ where: { id: b.productId, tenantId } });
    if (!product) return sendProblem(reply, problems.notFound("Product not found."));
    if (!product.active) return sendProblem(reply, problems.conflict("This product is switched off.", "product_inactive"));
    if (b.supplierId && !(await prisma.supplier.findFirst({ where: { id: b.supplierId, tenantId } }))) {
      return sendProblem(reply, problems.unprocessable("Supplier not found.", "unknown_supplier"));
    }
    const expiry = b.expiryDate ? dayStart(b.expiryDate) : null;
    const problem = receiptProblem(product.category, expiry, b.quantity);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_receipt"));
    const actor = resolveActor(request.auth, undefined);

    const batch = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.stockBatch.findFirst({ where: { productId: product.id, batchNo: b.batchNo, expiryDate: expiry } });
      let row;
      if (existing) {
        row = await tx.stockBatch.update({
          where: { id: existing.id },
          data: { quantityOnHand: { increment: b.quantity }, quantityReceived: { increment: b.quantity }, ...(b.costMinor !== undefined ? { costMinor: b.costMinor } : {}) },
        });
      } else {
        row = await tx.stockBatch.create({
          data: {
            tenantId,
            productId: product.id,
            batchNo: b.batchNo,
            expiryDate: expiry,
            quantityReceived: b.quantity,
            quantityOnHand: b.quantity,
            ...(b.supplierId !== undefined ? { supplierId: b.supplierId } : {}),
            ...(b.costMinor !== undefined ? { costMinor: b.costMinor } : {}),
            ...(actor ? { receivedBy: actor } : {}),
          },
        });
      }
      await tx.stockMovement.create({
        data: { tenantId, productId: product.id, batchId: row.id, kind: "RECEIPT", quantity: b.quantity, ...(b.note !== undefined ? { note: b.note } : {}), ...(actor ? { actor } : {}) },
      });
      if (isControlledClass(product.dispensingClass)) {
        const supplier = b.supplierId ? await tx.supplier.findFirst({ where: { id: b.supplierId, tenantId }, select: { name: true } }) : null;
        await appendRegisterEntry(tx, { tenantId, productId: product.id, productName: productDisplayName(product), batchNo: row.batchNo, kind: "RECEIPT", quantity: b.quantity, actor: actor ?? "system", supplierName: supplier?.name ?? null, note: b.note ?? null });
      }
      return row;
    });
    return reply.code(201).send({
      batchId: batch.id,
      productId: batch.productId,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate ? batch.expiryDate.toISOString().slice(0, 10) : undefined,
      quantityOnHand: batch.quantityOnHand,
    });
  });

  app.post("/provider/pharmacy/stock/adjustments", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = adjustmentSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    const batch = await prisma.stockBatch.findFirst({ where: { id: b.batchId, tenantId } });
    if (!batch) return sendProblem(reply, problems.notFound("Batch not found."));
    const problem = adjustmentProblem(batch.quantityOnHand, b.delta, b.reason, b.note);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_adjustment"));
    const product = await prisma.pharmacyProduct.findFirst({ where: { id: batch.productId, tenantId } });
    const controlled = !!product && isControlledClass(product.dispensingClass);
    if (controlled && !(b.note && b.note.trim().length >= 5)) return sendProblem(reply, problems.unprocessable("Explain a controlled-stock change in the note (at least 5 characters).", "note_required"));
    const actor = resolveActor(request.auth, undefined);
    // The guard in the update makes a second adjustment at the same moment fail instead of going below zero.
    const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const changed = await tx.stockBatch.updateMany({
        where: { id: batch.id, quantityOnHand: { gte: b.delta < 0 ? -b.delta : 0 } },
        data: { quantityOnHand: { increment: b.delta } },
      });
      if (changed.count === 0) return null;
      await tx.stockMovement.create({
        data: { tenantId, productId: batch.productId, batchId: batch.id, kind: "ADJUSTMENT", quantity: b.delta, reason: b.reason, ...(b.note !== undefined ? { note: b.note } : {}), ...(actor ? { actor } : {}) },
      });
      if (controlled && product) await appendRegisterEntry(tx, { tenantId, productId: product.id, productName: productDisplayName(product), batchNo: batch.batchNo, kind: "ADJUSTMENT", quantity: b.delta, actor: actor ?? "system", reason: b.reason, note: b.note ?? null });
      return tx.stockBatch.findUnique({ where: { id: batch.id } });
    });
    if (!result) return sendProblem(reply, problems.conflict("The stock changed while you were adjusting it. Try again.", "stock_changed"));
    return reply.code(200).send({ batchId: result.id, quantityOnHand: result.quantityOnHand });
  });

  // Take a whole batch out of stock: expired, damaged or recalled.
  app.post("/provider/pharmacy/stock/write-offs", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = writeOffSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    const batch = await prisma.stockBatch.findFirst({ where: { id: b.batchId, tenantId } });
    if (!batch) return sendProblem(reply, problems.notFound("Batch not found."));
    if (batch.quantityOnHand <= 0) return sendProblem(reply, problems.conflict("This batch has nothing left.", "batch_empty"));
    if (b.reason === "EXPIRED" && expiryState(batch.expiryDate) !== "EXPIRED") {
      return sendProblem(reply, problems.unprocessable("This batch has not expired.", "not_expired"));
    }
    const product = await prisma.pharmacyProduct.findFirst({ where: { id: batch.productId, tenantId } });
    const controlled = !!product && isControlledClass(product.dispensingClass);
    if (controlled && !(b.note && b.note.trim().length >= 5)) return sendProblem(reply, problems.unprocessable("Explain a controlled-stock write-off in the note (at least 5 characters).", "note_required"));
    const actor = resolveActor(request.auth, undefined);
    const qty = batch.quantityOnHand;
    const done = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const changed = await tx.stockBatch.updateMany({ where: { id: batch.id, quantityOnHand: qty }, data: { quantityOnHand: 0 } });
      if (changed.count === 0) return false;
      await tx.stockMovement.create({
        data: { tenantId, productId: batch.productId, batchId: batch.id, kind: "WRITE_OFF", quantity: -qty, reason: b.reason, ...(b.note !== undefined ? { note: b.note } : {}), ...(actor ? { actor } : {}) },
      });
      if (controlled && product) await appendRegisterEntry(tx, { tenantId, productId: product.id, productName: productDisplayName(product), batchNo: batch.batchNo, kind: "WRITE_OFF", quantity: -qty, actor: actor ?? "system", reason: b.reason, note: b.note ?? null });
      return true;
    });
    if (!done) return sendProblem(reply, problems.conflict("The stock changed. Try again.", "stock_changed"));
    return reply.code(200).send({ batchId: batch.id, writtenOff: qty });
  });

  // A recalled or doubtful batch cannot be dispensed while it is quarantined.
  app.post("/provider/pharmacy/batches/:id/quarantine", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = quarantineSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const b = parsed.data;
    if (b.quarantined && !b.reason) return sendProblem(reply, problems.unprocessable("Say why the batch is held.", "reason_required"));
    const batch = await prisma.stockBatch.findFirst({ where: { id, tenantId } });
    if (!batch) return sendProblem(reply, problems.notFound("Batch not found."));
    const row = await prisma.stockBatch.update({
      where: { id },
      data: b.quarantined ? { status: "QUARANTINED", quarantineReason: b.reason ?? null } : { status: "ACTIVE", quarantineReason: null },
    });
    return reply.code(200).send({ batchId: row.id, status: row.status });
  });

  app.get("/provider/pharmacy/stock/movements", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = movementsQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const tenantId = request.auth!.tenantId;
    const rows = await prisma.stockMovement.findMany({
      where: { tenantId, ...(parsed.data.productId ? { productId: parsed.data.productId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.data.limit,
      include: { product: { select: { genericName: true, brandName: true, strength: true, dosageForm: true, packSize: true } }, batch: { select: { batchNo: true } } },
    });
    return reply.code(200).send({
      items: rows.map((m: { id: string; productId: string; kind: string; quantity: number; reason: string | null; note: string | null; reference: string | null; actor: string | null; createdAt: Date; product: { genericName: string; brandName: string | null; strength: string | null; dosageForm: string | null; packSize: string | null }; batch: { batchNo: string } }) => ({
        movementId: m.id,
        productId: m.productId,
        productName: productDisplayName({ category: "", dispensingClass: "", ...m.product }),
        batchNo: m.batch.batchNo,
        kind: m.kind,
        quantity: m.quantity,
        reason: m.reason ?? undefined,
        note: m.note ?? undefined,
        reference: m.reference ?? undefined,
        actor: m.actor ?? undefined,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  });

  // What needs attention today: low and empty stock, expired stock still on the shelf, and stock about to expire.
  app.get("/provider/pharmacy/inventory/alerts", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const today = new Date();
    const products = await prisma.pharmacyProduct.findMany({ where: { tenantId, active: true }, include: { batches: true }, take: 2000 });
    const lowStock: unknown[] = [];
    const outOfStock: unknown[] = [];
    const expired: unknown[] = [];
    const expiringSoon: unknown[] = [];
    let stockValueMinor = 0;
    for (const p of products as { id: string; genericName: string; brandName: string | null; strength: string | null; dosageForm: string | null; packSize: string | null; reorderLevel: number; unit: string; batches: (BatchLike & { batchNo: string; costMinor: number | null })[] }[]) {
      const name = productDisplayName({ category: "", dispensingClass: "", ...p });
      const available = onHand(p.batches, today);
      const level = stockLevel(available, p.reorderLevel);
      if (level === "LOW") lowStock.push({ productId: p.id, name, available, reorderLevel: p.reorderLevel, unit: p.unit });
      if (level === "OUT" && p.reorderLevel > 0) outOfStock.push({ productId: p.id, name, available, reorderLevel: p.reorderLevel, unit: p.unit });
      for (const b of p.batches) {
        if (b.quantityOnHand <= 0) continue;
        stockValueMinor += b.quantityOnHand * (b.costMinor ?? 0);
        const state = expiryState(b.expiryDate, today);
        const row = { productId: p.id, name, batchId: b.id, batchNo: b.batchNo, quantityOnHand: b.quantityOnHand, expiryDate: b.expiryDate ? b.expiryDate.toISOString().slice(0, 10) : undefined, daysToExpiry: daysToExpiry(b.expiryDate, today) ?? undefined, status: b.status };
        if (state === "EXPIRED") expired.push(row);
        else if (state === "NEAR") expiringSoon.push(row);
      }
    }
    const byDays = (a: unknown, b: unknown) => ((a as { daysToExpiry?: number }).daysToExpiry ?? 0) - ((b as { daysToExpiry?: number }).daysToExpiry ?? 0);
    expired.sort(byDays);
    expiringSoon.sort(byDays);
    return reply.code(200).send({
      nearExpiryDays: NEAR_EXPIRY_DAYS,
      summary: { lowStock: lowStock.length, outOfStock: outOfStock.length, expired: expired.length, expiringSoon: expiringSoon.length, ...(canSeeCost(request.auth) ? { stockValueMinor } : {}) },
      lowStock,
      outOfStock,
      expired,
      expiringSoon,
    });
  });
};

export default pharmacyInventoryRoutes;
