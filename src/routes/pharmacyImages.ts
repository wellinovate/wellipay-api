import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { imageUploadSchema } from "../schemas/pharmacyOrders.js";
import { IMAGE_BODY_LIMIT, imageProblem } from "../lib/prescriptionImages.js";

const meta = { id: true, contentType: true, sizeBytes: true, createdAt: true } as const;
interface MetaRow { id: string; contentType: string; sizeBytes: number; createdAt: Date }
const serializeMeta = (i: MetaRow) => ({ imageId: i.id, contentType: i.contentType, sizeBytes: i.sizeBytes, createdAt: i.createdAt.toISOString() });

// Photos of the paper prescription. Uploads are JSON with base64 data, so no extra
// upload library is needed. The type is read from the file's own bytes.
const pharmacyImageRoutes: FastifyPluginAsync = async (app) => {
  async function store(tenantId: string, prescriptionId: string, body: unknown, uploadedBy: string | null) {
    const parsed = imageUploadSchema.safeParse(body);
    if (!parsed.success) return { status: 400 as const, problem: problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body") };
    const count = await prisma.prescriptionImage.count({ where: { prescriptionId } });
    const checked = imageProblem(parsed.data.dataBase64, parsed.data.contentType, count);
    if ("problem" in checked) return { status: 422 as const, problem: problems.unprocessable(checked.problem, "invalid_image") };
    const row = await prisma.prescriptionImage.create({
      data: { tenantId, prescriptionId, contentType: checked.type, sizeBytes: checked.bytes.length, data: new Uint8Array(checked.bytes), ...(uploadedBy ? { uploadedBy } : {}) },
      select: meta,
    });
    return { status: 201 as const, row: serializeMeta(row) };
  }

  app.post("/patient/prescriptions/:id/images", { bodyLimit: IMAGE_BODY_LIMIT, preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const { id } = request.params as { id: string };
    const rx = await prisma.prescription.findFirst({ where: { id, tenantId, patientRef } });
    if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
    if (rx.status !== "SUBMITTED") return sendProblem(reply, problems.conflict("Photos can only be added while the prescription is waiting for review.", "not_open"));
    const r = await store(tenantId, id, request.body, `patient:${patientRef}`);
    return "problem" in r ? sendProblem(reply, r.problem) : reply.code(201).send(r.row);
  });

  app.get("/patient/prescriptions/:id/images", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const { id } = request.params as { id: string };
    if (!(await prisma.prescription.findFirst({ where: { id, tenantId, patientRef }, select: { id: true } }))) return sendProblem(reply, problems.notFound("Prescription not found."));
    const rows = await prisma.prescriptionImage.findMany({ where: { prescriptionId: id }, select: meta, orderBy: { createdAt: "asc" } });
    return reply.send({ items: rows.map(serializeMeta) });
  });

  app.delete("/patient/prescriptions/:id/images/:imageId", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const { id, imageId } = request.params as { id: string; imageId: string };
    const rx = await prisma.prescription.findFirst({ where: { id, tenantId, patientRef } });
    if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
    if (rx.status !== "SUBMITTED") return sendProblem(reply, problems.conflict("Photos cannot be removed after the pharmacy has reviewed the prescription.", "not_open"));
    await prisma.prescriptionImage.deleteMany({ where: { id: imageId, prescriptionId: id } });
    return reply.code(204).send();
  });

  app.post("/provider/prescriptions/:id/images", { bodyLimit: IMAGE_BODY_LIMIT, preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const rx = await prisma.prescription.findFirst({ where: { id, tenantId } });
    if (!rx) return sendProblem(reply, problems.notFound("Prescription not found."));
    if (rx.status !== "SUBMITTED") return sendProblem(reply, problems.conflict("Photos can only be added before the prescription is decided.", "not_open"));
    const r = await store(tenantId, id, request.body, resolveActor(request.auth, undefined) ?? null);
    return "problem" in r ? sendProblem(reply, r.problem) : reply.code(201).send(r.row);
  });

  // The picture itself. Never cached, and the browser is told not to guess its type.
  app.get("/provider/prescriptions/:id/images/:imageId", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id, imageId } = request.params as { id: string; imageId: string };
    const img = await prisma.prescriptionImage.findFirst({ where: { id: imageId, prescriptionId: id, tenantId } });
    if (!img) return sendProblem(reply, problems.notFound("Photo not found."));
    return reply
      .header("content-type", img.contentType)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "inline")
      .send(Buffer.from(img.data));
  });
};

export default pharmacyImageRoutes;
