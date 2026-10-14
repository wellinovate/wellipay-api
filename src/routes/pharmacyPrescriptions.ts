import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { staffPrescriptionSchema, listPrescriptionsQuery, verifySchema, pharmacistSchema } from "../schemas/pharmacyOrders.js";
import { verificationProblem, validUntilFrom } from "../lib/prescriptions.js";

export interface RxRow {
  id: string;
  patientRef: string;
  source: string;
  prescriberName: string | null;
  prescriberLicenceNo: string | null;
  issuedOn: Date | null;
  notes: string | null;
  status: string;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  validUntil: Date | null;
  refillsAllowed: number;
  refillOfId: string | null;
  createdAt: Date;
  items: { id: string; description: string; quantity: number; directions: string | null; productId: string | null }[];
  images?: { id: string; contentType: string; sizeBytes: number }[];
}

export function serializePrescription(r: RxRow) {
  return {
    prescriptionId: r.id,
    patientRef: r.patientRef,
    source: r.source,
    prescriberName: r.prescriberName ?? undefined,
    prescriberLicenceNo: r.prescriberLicenceNo ?? undefined,
    issuedOn: r.issuedOn ? r.issuedOn.toISOString().slice(0, 10) : undefined,
    notes: r.notes ?? undefined,
    status: r.status,
    verifiedBy: r.verifiedBy ?? undefined,
    verifiedAt: r.verifiedAt?.toISOString(),
    rejectionReason: r.rejectionReason ?? undefined,
    validUntil: r.validUntil?.toISOString(),
    refillsAllowed: r.refillsAllowed,
    refillOfId: r.refillOfId ?? undefined,
    createdAt: r.createdAt.toISOString(),
    items: r.items.map((i) => ({ itemId: i.id, description: i.description, quantity: i.quantity, directions: i.directions ?? undefined, productId: i.productId ?? undefined })),
    images: (r.images ?? []).map((i) => ({ imageId: i.id, contentType: i.contentType, sizeBytes: i.sizeBytes })),
  };
}

// Loads the signed-in staff member and checks they are a registered pharmacist.
// A server-to-server token has no person behind it, so it never qualifies.
export async function requirePharmacist(request: FastifyRequest, reply: FastifyReply) {
  const staff = request.auth?.staff;
  if (!staff) {
    sendProblem(reply, problems.forbidden("Only a signed-in pharmacist can do this.", "pharmacist_required"));
    return null;
  }
  const row = await prisma.staff.findFirst({ where: { id: staff.id, tenantId: request.auth!.tenantId, status: "ACTIVE" } });
  if (!row?.pharmacistLicenceNo) {
    sendProblem(reply, problems.forbidden("Only a registered pharmacist can do this. An admin can add your licence number.", "pharmacist_required"));
    return null;
  }
  return row;
}

const pharmacyPrescriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/prescriptions", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listPrescriptionsQuery.safeParse(request.query);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    const rows = await prisma.prescription.findMany({
      where: { tenantId: request.auth!.tenantId, ...(parsed.data.status ? { status: parsed.data.status } : {}), ...(parsed.data.patientRef ? { patientRef: parsed.data.patientRef } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: parsed.data.limit,
      include: { items: true, images: { select: { id: true, contentType: true, sizeBytes: true } } },
    });
    return reply.code(200).send({ items: rows.map(serializePrescription) });
  });

  // A walk-in prescription entered at the counter.
  app.post("/provider/prescriptions", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = staffPrescriptionSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const b = parsed.data;
    if (!(await prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef: b.patientRef } } }))) {
      return sendProblem(reply, problems.unprocessable("Patient not found.", "unknown_patient"));
    }
    const productIds = [...new Set(b.items.map((i) => i.productId).filter((x): x is string => !!x))];
    if (productIds.length > 0) {
      const found = await prisma.pharmacyProduct.count({ where: { tenantId, id: { in: productIds } } });
      if (found !== productIds.length) return sendProblem(reply, problems.unprocessable("A product on the prescription was not found.", "unknown_product"));
    }
    const created = await prisma.prescription.create({
      data: {
        tenantId,
        patientRef: b.patientRef,
        source: "STAFF",
        prescriberName: b.prescriberName,
        createdBy: resolveActor(request.auth, undefined) ?? null,
        ...(b.prescriberLicenceNo !== undefined ? { prescriberLicenceNo: b.prescriberLicenceNo } : {}),
        ...(b.issuedOn !== undefined ? { issuedOn: new Date(`${b.issuedOn}T00:00:00.000Z`) } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}),
        items: {
          create: b.items.map((i) => ({
            description: i.description,
            quantity: i.quantity,
            ...(i.directions !== undefined ? { directions: i.directions } : {}),
            ...(i.productId !== undefined ? { productId: i.productId } : {}),
          })),
        },
      },
      include: { items: true },
    });
    return reply.code(201).send(serializePrescription(created));
  });

  // Pharmacist decision. Verifying matches each item to a product and sets validity and refills.
  app.patch("/provider/prescriptions/:id/verify", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const pharmacist = await requirePharmacist(request, reply);
    if (!pharmacist) return;
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const b = parsed.data;
    const rx = await prisma.prescription.findFirst({ where: { id, tenantId }, include: { items: true } });
    if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
    if (rx.status !== "SUBMITTED") return sendProblem(reply, problems.conflict(`This prescription is already ${rx.status.toLowerCase()}.`, "already_decided"));

    const actor = `${pharmacist.name} [${pharmacist.id}] PCN ${pharmacist.pharmacistLicenceNo}`.slice(0, 160);
    if (b.decision === "REJECT") {
      const problem = verificationProblem({ decision: "REJECT", reason: b.reason, mappedCount: 0, hasControlled: false, validDays: 0, refillsAllowed: 0 });
      if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_decision"));
      const row = await prisma.prescription.update({
        where: { id },
        data: { status: "REJECTED", rejectionReason: b.reason ?? null, verifiedBy: actor, verifiedAt: new Date() },
        include: { items: true },
      });
      return reply.code(200).send(serializePrescription(row));
    }

    // Items the pharmacist matched now, plus any matched when the prescription was entered.
    const matched = new Map<string, string | null>(rx.items.map((i: { id: string; productId: string | null }) => [i.id, i.productId]));
    for (const m of b.items) {
      if (!matched.has(m.itemId)) return sendProblem(reply, problems.unprocessable("An item does not belong to this prescription.", "unknown_item"));
      matched.set(m.itemId, m.productId);
    }
    const productIds = [...new Set([...matched.values()].filter((x): x is string => !!x))];
    const products = productIds.length ? await prisma.pharmacyProduct.findMany({ where: { tenantId, id: { in: productIds }, active: true } }) : [];
    if (products.length !== productIds.length) return sendProblem(reply, problems.unprocessable("A matched product was not found or is switched off.", "unknown_product"));
    const problem = verificationProblem({
      decision: "VERIFY",
      mappedCount: productIds.length,
      hasControlled: products.some((p: { dispensingClass: string }) => p.dispensingClass === "CONTROLLED"),
      validDays: b.validDays,
      refillsAllowed: b.refillsAllowed,
    });
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_decision"));

    const now = new Date();
    const row = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const [itemId, productId] of matched) {
        await tx.prescriptionItem.update({ where: { id: itemId }, data: { productId } });
      }
      return tx.prescription.update({
        where: { id },
        data: { status: "VERIFIED", verifiedBy: actor, verifiedAt: now, validUntil: validUntilFrom(now, b.validDays), refillsAllowed: b.refillsAllowed },
        include: { items: true },
      });
    });
    return reply.code(200).send(serializePrescription(row));
  });

  // Admin records which staff are registered pharmacists. Clearing the number removes the right.
  app.patch("/provider/staff/:id/pharmacist", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = pharmacistSchema.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const staff = await prisma.staff.findFirst({ where: { id, tenantId } });
    if (!staff) return sendProblem(reply, problems.notFound("Staff member not found."));
    const row = await prisma.staff.update({ where: { id }, data: { pharmacistLicenceNo: parsed.data.licenceNo } });
    return reply.code(200).send({ staffId: row.id, name: row.name, pharmacistLicenceNo: row.pharmacistLicenceNo ?? undefined, isPharmacist: row.pharmacistLicenceNo !== null });
  });
};

export default pharmacyPrescriptionRoutes;
