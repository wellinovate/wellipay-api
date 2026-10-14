import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { registerQuery } from "../schemas/pharmacyOrders.js";
import { registerCsv, type RegisterRow } from "../lib/controlledRegister.js";

interface Entry extends RegisterRow {
  id: string;
  productId: string;
  prescriptionId: string | null;
  orderId: string | null;
  note: string | null;
}

function serialize(e: Entry) {
  return {
    entryId: e.id,
    productId: e.productId,
    productName: e.productName,
    batchNo: e.batchNo,
    kind: e.kind,
    quantity: e.quantity,
    balanceAfter: e.balanceAfter,
    patientRef: e.patientRef ?? undefined,
    patientName: e.patientName ?? undefined,
    prescriptionId: e.prescriptionId ?? undefined,
    prescriberName: e.prescriberName ?? undefined,
    prescriberLicenceNo: e.prescriberLicenceNo ?? undefined,
    recipientName: e.recipientName ?? undefined,
    recipientId: e.recipientId ?? undefined,
    supplierName: e.supplierName ?? undefined,
    orderId: e.orderId ?? undefined,
    reason: e.reason ?? undefined,
    note: e.note ?? undefined,
    actor: e.actor,
    createdAt: e.createdAt.toISOString(),
  };
}

// Read-only. There is deliberately no route that creates, edits or deletes an
// entry directly. Entries are written when stock is received, dispensed,
// adjusted or written off, and the database refuses to change them afterwards.
const pharmacyRegisterRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/pharmacy/controlled-register", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = registerQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const tenantId = request.auth!.tenantId;
    const q = parsed.data;
    const createdAt: { gte?: Date; lt?: Date } = {};
    if (q.from) createdAt.gte = new Date(`${q.from}T00:00:00.000Z`);
    if (q.to) createdAt.lt = new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000);
    const rows = (await prisma.controlledRegisterEntry.findMany({
      where: { tenantId, ...(q.productId ? { productId: q.productId } : {}), ...(q.from || q.to ? { createdAt } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit,
    })) as Entry[];
    if (q.format === "csv") {
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="controlled-drug-register.csv"').header("cache-control", "private, no-store");
      return reply.code(200).send(registerCsv([...rows].reverse()));
    }
    return reply.code(200).send({ items: rows.map(serialize) });
  });

  // Where the register says each controlled medicine stands against what the shelf records say.
  app.get("/provider/pharmacy/controlled-register/balances", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const products = await prisma.pharmacyProduct.findMany({ where: { tenantId, dispensingClass: "CONTROLLED" }, include: { batches: { select: { quantityOnHand: true } } } });
    const items = [];
    for (const p of products as { id: string; genericName: string; brandName: string | null; strength: string | null; batches: { quantityOnHand: number }[] }[]) {
      const last = await prisma.controlledRegisterEntry.findFirst({ where: { tenantId, productId: p.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const onHand = p.batches.reduce((s, b) => s + b.quantityOnHand, 0);
      const registerBalance = last ? (last as { balanceAfter: number }).balanceAfter : null;
      items.push({
        productId: p.id,
        name: [p.genericName, p.brandName ? `(${p.brandName})` : "", p.strength ?? ""].filter(Boolean).join(" "),
        onHand,
        registerBalance: registerBalance ?? undefined,
        // Stock with no register entry yet counts as matching only when there is none on the shelf.
        matches: registerBalance === null ? onHand === 0 : registerBalance === onHand,
        lastEntryAt: last ? (last as { createdAt: Date }).createdAt.toISOString() : undefined,
      });
    }
    return reply.code(200).send({ items });
  });
};

export default pharmacyRegisterRoutes;
