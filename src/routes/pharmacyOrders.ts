import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { createOrderSchema, dispenseSchema, cancelOrderSchema, deliverySchema, listOrdersQuery } from "../schemas/pharmacyOrders.js";
import { needsPharmacist } from "../lib/pharmacyProducts.js";
import { allocateFefo } from "../lib/pharmacyStock.js";
import { prescriptionUsable } from "../lib/prescriptions.js";
import { anyNeedsPharmacist, coverageProblem, handoverProblem, paymentGate, type DispenseLine } from "../lib/dispensing.js";
import { deliveryActionProblem, deliveryFeeFromLines, newProofCode, nextDeliveryStatus, proofProblem } from "../lib/delivery.js";
import { requirePharmacist } from "./pharmacyPrescriptions.js";

class OrderError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface OrderRow {
  id: string;
  invoiceId: string;
  patientRef: string;
  prescriptionId: string | null;
  status: string;
  fulfilment: string;
  deliveryAddress: string | null;
  deliveryPhone: string | null;
  deliveryFeeMinor: number;
  deliveryStatus: string;
  courierName: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  deliveredToName: string | null;
  proofCode: string | null;
  deliveryNote: string | null;
  failureReason: string | null;
  dispensedBy: string | null;
  dispensedAt: Date | null;
  handedToName: string | null;
  paymentOverrideReason: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: Date;
  lines: { id: string; productId: string; description: string; quantity: number; unitPriceMinor: number; dispensed: number }[];
}

// Staff see the proof code so they can read it back to a patient who phones in.
// The patient endpoint decides separately when to show it.
export function serializeOrder(o: OrderRow, invoiceStatus?: string) {
  return {
    orderId: o.id,
    invoiceId: o.invoiceId,
    patientRef: o.patientRef,
    prescriptionId: o.prescriptionId ?? undefined,
    status: o.status,
    paymentStatus: invoiceStatus,
    fulfilment: o.fulfilment,
    deliveryAddress: o.deliveryAddress ?? undefined,
    deliveryPhone: o.deliveryPhone ?? undefined,
    deliveryFeeMinor: o.deliveryFeeMinor,
    deliveryStatus: o.deliveryStatus,
    courierName: o.courierName ?? undefined,
    dispatchedAt: o.dispatchedAt?.toISOString(),
    deliveredAt: o.deliveredAt?.toISOString(),
    deliveredToName: o.deliveredToName ?? undefined,
    proofCode: o.proofCode ?? undefined,
    deliveryNote: o.deliveryNote ?? undefined,
    failureReason: o.failureReason ?? undefined,
    dispensedBy: o.dispensedBy ?? undefined,
    dispensedAt: o.dispensedAt?.toISOString(),
    handedToName: o.handedToName ?? undefined,
    paymentOverrideReason: o.paymentOverrideReason ?? undefined,
    cancelReason: o.cancelReason ?? undefined,
    notes: o.notes ?? undefined,
    createdAt: o.createdAt.toISOString(),
    lines: o.lines.map((l) => ({ lineId: l.id, productId: l.productId, description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, dispensed: l.dispensed })),
  };
}

function sendOrderError(reply: Parameters<typeof sendProblem>[0], err: OrderError) {
  const title = err.status === 404 ? "Not Found" : err.status === 409 ? "Conflict" : err.status === 403 ? "Forbidden" : "Unprocessable Entity";
  return sendProblem(reply, { status: err.status, title, detail: err.message, code: err.code });
}

const pharmacyOrderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/pharmacy/orders", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listOrdersQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const tenantId = request.auth!.tenantId;
    const rows = await prisma.pharmacyOrder.findMany({
      where: { tenantId, ...(parsed.data.status ? { status: parsed.data.status } : {}), ...(parsed.data.deliveryStatus ? { deliveryStatus: parsed.data.deliveryStatus } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.data.limit,
      include: { lines: true },
    });
    const invoices = rows.length ? await prisma.invoice.findMany({ where: { tenantId, id: { in: rows.map((r: { invoiceId: string }) => r.invoiceId) } }, select: { id: true, status: true, providerInvoiceRef: true } }) : [];
    const byId = new Map(invoices.map((i: { id: string; status: string; providerInvoiceRef: string }) => [i.id, i]));
    return reply.code(200).send({
      items: rows.map((r: OrderRow) => {
        const inv = byId.get(r.invoiceId) as { status: string; providerInvoiceRef: string } | undefined;
        return { ...serializeOrder(r, inv?.status), invoiceRef: inv?.providerInvoiceRef };
      }),
    });
  });

  // Start an order from an invoice that has pharmacy products on it.
  app.post("/provider/pharmacy/orders", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    const invoice = await prisma.invoice.findFirst({ where: { id: b.invoiceId, tenantId }, include: { lines: true } });
    if (!invoice) return sendProblem(reply, problems.notFound("Bill not found."));
    if (invoice.status === "CANCELLED") return sendProblem(reply, problems.conflict("The bill is cancelled.", "invoice_cancelled"));
    if (await prisma.pharmacyOrder.findUnique({ where: { invoiceId: invoice.id } })) {
      return sendProblem(reply, problems.conflict("This bill already has an order.", "order_exists"));
    }
    const itemIds = invoice.lines.map((l: { serviceItemId: string | null }) => l.serviceItemId).filter((x: string | null): x is string => !!x);
    const items = itemIds.length ? await prisma.serviceItem.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true, productId: true, category: true } }) : [];
    const itemById = new Map(items.map((i: { id: string; productId: string | null; category: string | null }) => [i.id, i]));
    const productLines = invoice.lines.filter((l: { serviceItemId: string | null }) => l.serviceItemId && (itemById.get(l.serviceItemId) as { productId: string | null } | undefined)?.productId);
    if (productLines.length === 0) return sendProblem(reply, problems.unprocessable("This bill has no pharmacy products on it.", "no_products"));
    const products = await prisma.pharmacyProduct.findMany({ where: { tenantId, id: { in: productLines.map((l: { serviceItemId: string }) => (itemById.get(l.serviceItemId) as { productId: string }).productId) } } });
    const productById = new Map(products.map((p: { id: string; dispensingClass: string }) => [p.id, p]));
    const needsRx = products.some((p: { dispensingClass: string }) => needsPharmacist(p.dispensingClass));

    let prescriptionId: string | null = null;
    if (b.prescriptionId) {
      const rx = await prisma.prescription.findFirst({ where: { id: b.prescriptionId, tenantId } });
      if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
      if (rx.patientRef !== invoice.patientRef) return sendProblem(reply, problems.unprocessable("The prescription belongs to a different patient.", "patient_mismatch"));
      if (!prescriptionUsable(rx)) return sendProblem(reply, problems.conflict("The prescription is not verified, or it has expired.", "prescription_not_usable"));
      if (await prisma.pharmacyOrder.findFirst({ where: { prescriptionId: rx.id, status: { not: "CANCELLED" } } })) {
        return sendProblem(reply, problems.conflict("This prescription is already on another order.", "prescription_in_use"));
      }
      prescriptionId = rx.id;
    } else if (needsRx) {
      return sendProblem(reply, problems.unprocessable("This bill has prescription-only or controlled medicines. Attach a verified prescription.", "prescription_required"));
    }

    const deliveryFee = deliveryFeeFromLines(invoice.lines.map((l: { quantity: number; unitPriceMinor: number; serviceItemId: string | null }) => ({
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      category: l.serviceItemId ? ((itemById.get(l.serviceItemId) as { category: string | null } | undefined)?.category ?? null) : null,
    })));

    const created = await prisma.pharmacyOrder.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        patientRef: invoice.patientRef,
        fulfilment: b.fulfilment,
        deliveryFeeMinor: deliveryFee,
        createdBy: resolveActor(request.auth, undefined) ?? null,
        ...(prescriptionId ? { prescriptionId } : {}),
        ...(b.fulfilment === "DELIVERY"
          ? { deliveryStatus: "PENDING" as const, proofCode: newProofCode(), ...(b.deliveryAddress !== undefined ? { deliveryAddress: b.deliveryAddress } : {}), ...(b.deliveryPhone !== undefined ? { deliveryPhone: b.deliveryPhone } : {}) }
          : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
        lines: {
          create: productLines.map((l: { serviceItemId: string; description: string; quantity: number; unitPriceMinor: number }) => ({
            productId: (itemById.get(l.serviceItemId) as { productId: string }).productId,
            description: l.description,
            quantity: l.quantity,
            unitPriceMinor: l.unitPriceMinor,
          })),
        },
      },
      include: { lines: true },
    });
    void productById;
    return reply.code(201).send(serializeOrder(created, invoice.status));
  });

  app.get("/provider/pharmacy/orders/:id", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const tenantId = request.auth!.tenantId;
    const order = await prisma.pharmacyOrder.findFirst({ where: { id, tenantId }, include: { lines: { include: { allocations: true } } } });
    if (!order) return sendProblem(reply, problems.notFound("Order not found."));
    const invoice = await prisma.invoice.findFirst({ where: { id: order.invoiceId, tenantId }, select: { status: true } });
    const batchIds = [...new Set(order.lines.flatMap((l: { allocations: { batchId: string }[] }) => l.allocations.map((a) => a.batchId)))] as string[];
    const batches = batchIds.length ? await prisma.stockBatch.findMany({ where: { tenantId, id: { in: batchIds } }, select: { id: true, batchNo: true, expiryDate: true } }) : [];
    const batchById = new Map(batches.map((x: { id: string; batchNo: string; expiryDate: Date | null }) => [x.id, x]));
    return reply.code(200).send({
      ...serializeOrder(order, invoice?.status),
      batches: order.lines.flatMap((l: { id: string; description: string; allocations: { batchId: string; quantity: number }[] }) =>
        l.allocations.map((a) => {
          const bt = batchById.get(a.batchId) as { batchNo: string; expiryDate: Date | null } | undefined;
          return { lineId: l.id, description: l.description, batchNo: bt?.batchNo, expiryDate: bt?.expiryDate ? bt.expiryDate.toISOString().slice(0, 10) : undefined, quantity: a.quantity };
        }),
      ),
    });
  });

  // Hand the goods over. This is the step that takes stock off the shelf, and it
  // is separate from payment. Prescription-only and controlled lines need a
  // verified prescription and a registered pharmacist.
  app.post("/provider/pharmacy/orders/:id/dispense", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = dispenseSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const b = parsed.data;
    const order = await prisma.pharmacyOrder.findFirst({ where: { id, tenantId }, include: { lines: true } });
    if (!order) return sendProblem(reply, problems.notFound("Order not found."));
    if (order.status !== "AWAITING_DISPENSING") return sendProblem(reply, problems.conflict(`This order is ${order.status.toLowerCase().replace("_", " ")}.`, "order_not_open"));

    const invoice = await prisma.invoice.findFirst({ where: { id: order.invoiceId, tenantId }, select: { status: true } });
    if (!invoice) return sendProblem(reply, problems.notFound("Bill not found."));
    const gate = paymentGate(invoice.status, b.overridePaymentReason, request.auth!.staff?.level);
    if (!gate.ok) return sendProblem(reply, problems.conflict(gate.problem ?? "The bill is not paid.", "payment_required"));

    const products = await prisma.pharmacyProduct.findMany({ where: { tenantId, id: { in: order.lines.map((l: { productId: string }) => l.productId) } } });
    const productById = new Map(products.map((p: { id: string; dispensingClass: string; genericName: string }) => [p.id, p]));
    const lines: DispenseLine[] = order.lines.map((l: { productId: string; quantity: number; description: string }) => ({
      productId: l.productId,
      quantity: l.quantity,
      name: l.description,
      dispensingClass: (productById.get(l.productId) as { dispensingClass: string } | undefined)?.dispensingClass ?? "OTC",
    }));

    let pharmacistLabel: string | null = null;
    if (anyNeedsPharmacist(lines)) {
      const pharmacist = await requirePharmacist(request, reply);
      if (!pharmacist) return;
      pharmacistLabel = `${pharmacist.name} [${pharmacist.id}] PCN ${pharmacist.pharmacistLicenceNo}`.slice(0, 160);
      if (!order.prescriptionId) return sendProblem(reply, problems.unprocessable("Attach a verified prescription first.", "prescription_required"));
      const rx = await prisma.prescription.findFirst({ where: { id: order.prescriptionId, tenantId }, include: { items: true } });
      if (!rx || !prescriptionUsable(rx)) return sendProblem(reply, problems.conflict("The prescription is not verified, or it has expired.", "prescription_not_usable"));
      if (rx.patientRef !== order.patientRef) return sendProblem(reply, problems.unprocessable("The prescription belongs to a different patient.", "patient_mismatch"));
      const cover = coverageProblem(lines, rx.items);
      if (cover) return sendProblem(reply, problems.unprocessable(cover, "prescription_mismatch"));
    }
    const handover = handoverProblem(order.fulfilment, b.handedToName);
    if (handover) return sendProblem(reply, problems.unprocessable(handover, "handover_required"));
    const actor = pharmacistLabel ?? resolveActor(request.auth, undefined) ?? "system";

    try {
      const done = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Claim the order first. A second dispense at the same moment gets count 0.
        const claimed = await tx.pharmacyOrder.updateMany({
          where: { id: order.id, status: "AWAITING_DISPENSING" },
          data: {
            status: "DISPENSED",
            dispensedBy: actor,
            dispensedAt: new Date(),
            ...(b.handedToName !== undefined ? { handedToName: b.handedToName } : {}),
            ...(gate.overridden ? { paymentOverrideReason: b.overridePaymentReason ?? null } : {}),
          },
        });
        if (claimed.count === 0) throw new OrderError(409, "order_not_open", "This order was just dispensed.");
        const today = new Date();
        for (const line of order.lines as { id: string; productId: string; quantity: number; description: string }[]) {
          const batches = await tx.stockBatch.findMany({ where: { tenantId, productId: line.productId } });
          const { allocations, shortfall } = allocateFefo(batches, line.quantity, today);
          if (shortfall > 0) throw new OrderError(409, "insufficient_stock", `${line.description}: ${shortfall} short. Receive stock or change the order.`);
          for (const a of allocations) {
            const taken = await tx.stockBatch.updateMany({
              where: { id: a.batchId, status: "ACTIVE", quantityOnHand: { gte: a.quantity } },
              data: { quantityOnHand: { decrement: a.quantity } },
            });
            if (taken.count === 0) throw new OrderError(409, "stock_changed", `${line.description}: the stock changed. Try again.`);
            await tx.dispenseRecord.create({ data: { tenantId, orderLineId: line.id, productId: line.productId, batchId: a.batchId, quantity: a.quantity, dispensedBy: actor } });
            await tx.stockMovement.create({ data: { tenantId, productId: line.productId, batchId: a.batchId, kind: "DISPENSE", quantity: -a.quantity, reference: order.id, actor } });
          }
          await tx.pharmacyOrderLine.update({ where: { id: line.id }, data: { dispensed: line.quantity } });
        }
        if (order.prescriptionId) await tx.prescription.update({ where: { id: order.prescriptionId }, data: { status: "COMPLETED" } });
        return tx.pharmacyOrder.findUnique({ where: { id: order.id }, include: { lines: true } });
      });
      return reply.code(200).send(serializeOrder(done as OrderRow, invoice.status));
    } catch (err) {
      if (err instanceof OrderError) return sendOrderError(reply, err);
      throw err;
    }
  });

  app.post("/provider/pharmacy/orders/:id/cancel", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = cancelOrderSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const changed = await prisma.pharmacyOrder.updateMany({ where: { id, tenantId, status: "AWAITING_DISPENSING" }, data: { status: "CANCELLED", cancelReason: parsed.data.reason, deliveryStatus: "NOT_APPLICABLE" } });
    if (changed.count === 0) {
      const exists = await prisma.pharmacyOrder.findFirst({ where: { id, tenantId } });
      return sendProblem(reply, exists ? problems.conflict("Only an order waiting to be dispensed can be cancelled.", "order_not_open") : problems.notFound("Order not found."));
    }
    const row = await prisma.pharmacyOrder.findUnique({ where: { id }, include: { lines: true } });
    return reply.code(200).send(serializeOrder(row as OrderRow));
  });

  // Delivery steps: out for delivery, delivered with proof, or failed.
  app.patch("/provider/pharmacy/orders/:id/delivery", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = deliverySchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const b = parsed.data;
    const order = await prisma.pharmacyOrder.findFirst({ where: { id, tenantId } });
    if (!order) return sendProblem(reply, problems.notFound("Order not found."));
    const problem = deliveryActionProblem({ orderStatus: order.status, fulfilment: order.fulfilment, deliveryStatus: order.deliveryStatus }, b.action);
    if (problem) return sendProblem(reply, problems.conflict(problem, "invalid_delivery_step"));

    let data: {
      deliveryStatus: "PENDING" | "OUT_FOR_DELIVERY" | "DELIVERED" | "FAILED";
      courierName?: string;
      dispatchedAt?: Date;
      failureReason?: string | null;
      deliveredAt?: Date;
      deliveredToName?: string | null;
      deliveryNote?: string | null;
    };
    if (b.action === "dispatch") {
      if (!(b.courierName && b.courierName.trim().length >= 2)) return sendProblem(reply, problems.unprocessable("Enter the courier or rider's name.", "courier_required"));
      data = { deliveryStatus: nextDeliveryStatus("dispatch"), courierName: b.courierName, dispatchedAt: new Date(), failureReason: null };
    } else if (b.action === "deliver") {
      const pp = proofProblem(order.proofCode, b.proofCode, b.recipientName, b.note);
      if (pp) return sendProblem(reply, problems.unprocessable(pp, "proof_required"));
      data = {
        deliveryStatus: nextDeliveryStatus("deliver"),
        deliveredAt: new Date(),
        deliveredToName: b.recipientName ?? null,
        deliveryNote: b.proofCode ? `Confirmed with the patient's code.${b.note ? ` ${b.note}` : ""}` : (b.note ?? null),
      };
    } else {
      if (!(b.reason && b.reason.trim().length >= 3)) return sendProblem(reply, problems.unprocessable("Say why the delivery failed.", "reason_required"));
      data = { deliveryStatus: nextDeliveryStatus("fail"), failureReason: b.reason };
    }
    // Only move from the state we checked, so two staff cannot both record it.
    const changed = await prisma.pharmacyOrder.updateMany({ where: { id, tenantId, deliveryStatus: order.deliveryStatus }, data });
    if (changed.count === 0) return sendProblem(reply, problems.conflict("The delivery changed. Reload and try again.", "delivery_changed"));
    const row = await prisma.pharmacyOrder.findUnique({ where: { id }, include: { lines: true } });
    return reply.code(200).send(serializeOrder(row as OrderRow));
  });
};

export default pharmacyOrderRoutes;
