import { randomInt } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { createPatientRecordSchema, listPatientRecordsQuerySchema } from "../schemas/patientRecords.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";

function serialize(row: { id: string; patientRef: string; fullName: string; phone: string | null; email: string | null; facilityRef: string | null; createdAt: Date }) {
  return {
    patientRecordId: row.id,
    patientRef: row.patientRef,
    fullName: row.fullName,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    facilityRef: row.facilityRef ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

// Patients the provider has registered. Invoices still carry only a
// patientRef; the console joins the two.
const patientRecordRoutes: FastifyPluginAsync = async (app) => {
  app.post("/provider/patient-records", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createPatientRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const createdBy = resolveActor(request.auth, undefined);

    // Retry a few times if a generated reference collides.
    for (let attempt = 0; attempt < 5; attempt++) {
      const patientRef = body.patientRef ?? `P-${randomInt(100000, 999999)}`;
      const clash = await prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } });
      if (clash) {
        if (body.patientRef) return sendProblem(reply, problems.conflict(`patientRef "${patientRef}" already exists.`, "patient_ref_already_exists"));
        continue;
      }
      const created = await prisma.patientRecord.create({
        data: {
          tenantId,
          patientRef,
          fullName: body.fullName,
          phone: body.phone ?? null,
          email: body.email ?? null,
          facilityRef: body.facilityRef ?? null,
          createdBy: createdBy ?? null,
        },
      });
      return reply.code(201).send(serialize(created));
    }
    return sendProblem(reply, problems.conflict("Could not assign a patient reference. Try again.", "patient_ref_unavailable"));
  });

  app.get("/provider/patient-records", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listPatientRecordsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const tenantId = request.auth!.tenantId;
    const { q, limit, offset } = parsed.data;
    const where = {
      tenantId,
      ...(q ? { OR: [{ fullName: { contains: q, mode: "insensitive" as const } }, { patientRef: { contains: q, mode: "insensitive" as const } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.patientRecord.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
      prisma.patientRecord.count({ where }),
    ]);
    return reply.code(200).send({ items: rows.map(serialize), total, limit, offset });
  });
};

export default patientRecordRoutes;
