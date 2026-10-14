import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { patientPrescriptionSchema } from "../schemas/pharmacyOrders.js";
import { refillEligibility } from "../lib/prescriptions.js";
import { serializePrescription, type RxRow } from "./pharmacyPrescriptions.js";

const OPEN_STATES = ["SUBMITTED", "VERIFIED"];

interface ChainRow {
  id: string;
  status: string;
  refillOfId: string | null;
  refillsAllowed: number;
  validUntil: Date | null;
  createdAt: Date;
}

// Works out the refill state for the chain a prescription belongs to.
async function chainState(tenantId: string, patientRef: string, rx: { id: string; refillOfId: string | null }) {
  const rootId = rx.refillOfId ?? rx.id;
  const rows: ChainRow[] = await prisma.prescription.findMany({
    where: { tenantId, patientRef, OR: [{ id: rootId }, { refillOfId: rootId }] },
    orderBy: { createdAt: "asc" },
  });
  const root = rows.find((r) => r.id === rootId);
  const last = rows[rows.length - 1];
  const refills = rows.filter((r) => r.id !== rootId);
  return {
    rootId,
    last,
    eligibility: refillEligibility({
      rootRefillsAllowed: root?.refillsAllowed ?? 0,
      rootValidUntil: root?.validUntil ?? null,
      activeRefills: refills.filter((r) => r.status !== "REJECTED" && r.status !== "CANCELLED").length,
      openInChain: rows.some((r) => OPEN_STATES.includes(r.status)),
      lastStatus: last?.status ?? "",
    }),
  };
}

// Prescriptions, refills and order tracking for the signed-in patient.
const patientPharmacyRoutes: FastifyPluginAsync = async (app) => {
  app.get("/patient/prescriptions", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const rows = (await prisma.prescription.findMany({ where: { tenantId, patientRef }, include: { items: true }, orderBy: { createdAt: "desc" }, take: 50 })) as RxRow[];
    const out = [];
    for (const r of rows) {
      const state = r.status === "COMPLETED" ? await chainState(tenantId, patientRef, r) : null;
      out.push({
        ...serializePrescription(r),
        // Staff-matched product ids and internal notes are not for the patient.
        items: r.items.map((i) => ({ itemId: i.id, description: i.description, quantity: i.quantity, directions: i.directions ?? undefined })),
        canRefill: !!state && state.last?.id === r.id && state.eligibility.ok,
        refillsRemaining: state?.eligibility.remaining,
        refillBlockedReason: state && state.last?.id === r.id && !state.eligibility.ok ? state.eligibility.reason : undefined,
      });
    }
    return reply.send({ items: out });
  });

  app.post("/patient/prescriptions", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const parsed = patientPrescriptionSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const { tenantId, patientRef } = request.patientAuth!;
    const b = parsed.data;
    const waiting = await prisma.prescription.count({ where: { tenantId, patientRef, status: "SUBMITTED" } });
    if (waiting >= 5) return sendProblem(reply, problems.conflict("You have 5 prescriptions waiting for review. Wait for the pharmacy to respond.", "too_many_waiting"));
    const created = await prisma.prescription.create({
      data: {
        tenantId,
        patientRef,
        source: "PATIENT",
        prescriberName: b.prescriberName,
        createdBy: `patient:${patientRef}`,
        ...(b.prescriberLicenceNo !== undefined ? { prescriberLicenceNo: b.prescriberLicenceNo } : {}),
        ...(b.issuedOn !== undefined ? { issuedOn: new Date(`${b.issuedOn}T00:00:00.000Z`) } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
        items: { create: b.items.map((i) => ({ description: i.description, quantity: i.quantity, ...(i.directions !== undefined ? { directions: i.directions } : {}) })) },
      },
      include: { items: true },
    });
    return reply.code(201).send(serializePrescription(created as RxRow));
  });

  app.post("/patient/prescriptions/:id/refill", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const { id } = request.params as { id: string };
    const rx = await prisma.prescription.findFirst({ where: { id, tenantId, patientRef }, include: { items: true } });
    if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
    const state = await chainState(tenantId, patientRef, rx);
    if (state.last?.id !== rx.id) return sendProblem(reply, problems.conflict("Ask for the refill on your latest prescription.", "not_latest"));
    if (!state.eligibility.ok) return sendProblem(reply, problems.conflict(state.eligibility.reason ?? "No refill is available.", "refill_not_available"));
    // Refills reuse the matched products from the original. The pharmacist still verifies.
    const created = await prisma.prescription.create({
      data: {
        tenantId,
        patientRef,
        source: "PATIENT",
        prescriberName: rx.prescriberName,
        refillOfId: state.rootId,
        createdBy: `patient:${patientRef}`,
        ...(rx.prescriberLicenceNo ? { prescriberLicenceNo: rx.prescriberLicenceNo } : {}),
        ...(rx.issuedOn ? { issuedOn: rx.issuedOn } : {}),
        items: {
          create: rx.items.map((i: { description: string; quantity: number; directions: string | null; productId: string | null }) => ({
            description: i.description,
            quantity: i.quantity,
            ...(i.directions ? { directions: i.directions } : {}),
            ...(i.productId ? { productId: i.productId } : {}),
          })),
        },
      },
      include: { items: true },
    });
    return reply.code(201).send(serializePrescription(created as RxRow));
  });

  app.post("/patient/prescriptions/:id/cancel", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const { id } = request.params as { id: string };
    const changed = await prisma.prescription.updateMany({ where: { id, tenantId, patientRef, status: "SUBMITTED" }, data: { status: "CANCELLED" } });
    if (changed.count === 0) return sendProblem(reply, problems.conflict("Only a prescription that is waiting for review can be cancelled.", "not_cancellable"));
    const row = await prisma.prescription.findUnique({ where: { id }, include: { items: true } });
    return reply.send(serializePrescription(row as RxRow));
  });

  app.get("/patient/pharmacy-orders", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const rows = await prisma.pharmacyOrder.findMany({ where: { tenantId, patientRef }, include: { lines: true }, orderBy: { createdAt: "desc" }, take: 50 });
    const items = rows.map((o: any) => ({
      orderId: o.id,
      invoiceId: o.invoiceId,
      status: o.status,
      fulfilment: o.fulfilment,
      deliveryStatus: o.deliveryStatus,
      deliveryFeeMinor: o.deliveryFeeMinor,
      courierName: o.courierName ?? undefined,
      dispatchedAt: o.dispatchedAt?.toISOString(),
      deliveredAt: o.deliveredAt?.toISOString(),
      failureReason: o.deliveryStatus === "FAILED" ? (o.failureReason ?? undefined) : undefined,
      dispensedAt: o.dispensedAt?.toISOString(),
      createdAt: o.createdAt.toISOString(),
      // The code is shown only while a delivery is still on its way.
      proofCode: o.fulfilment === "DELIVERY" && o.status === "DISPENSED" && (o.deliveryStatus === "PENDING" || o.deliveryStatus === "OUT_FOR_DELIVERY") ? (o.proofCode ?? undefined) : undefined,
      lines: o.lines.map((l: any) => ({ description: l.description, quantity: l.quantity })),
    }));
    return reply.send({ items });
  });
};

export default patientPharmacyRoutes;
