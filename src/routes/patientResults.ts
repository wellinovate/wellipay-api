import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { visibleToPatient } from "../lib/patientResults.js";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

// Results a patient can read in the app. Scoped to the signed-in patient by
// tenantId and patientRef from the verified patient token, never from the request.
const patientResultRoutes: FastifyPluginAsync = async (app) => {
  app.get("/patient/results", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const { tenantId, patientRef } = request.patientAuth!;
    const rows = await prisma.bookingResult.findMany({
      where: { tenantId, status: "READY", booking: { patientRef } },
      include: { booking: true },
      orderBy: [{ enteredAt: "desc" }, { id: "desc" }],
    });
    const ids = [...new Set(rows.map((r) => r.serviceItemId).filter((x): x is string => !!x))];
    const digital = ids.length
      ? await prisma.serviceItem.findMany({ where: { tenantId, id: { in: ids }, digitalResults: true }, select: { id: true } })
      : [];
    const digitalIds = new Set<string>(digital.map((d: { id: string }) => d.id));
    const visible = rows.filter((r) => visibleToPatient(r, digitalIds));
    return reply.code(200).send({
      items: visible.slice(0, parsed.data.limit).map((r) => ({
        resultId: r.id,
        bookingId: r.bookingId,
        kind: r.booking.kind,
        testName: r.testName,
        resultText: r.resultText ?? undefined,
        abnormal: r.abnormal,
        takenOn: r.booking.scheduledAt.toISOString(),
        readyAt: r.enteredAt?.toISOString(),
      })),
      // Ready results the lab hands over in person.
      inPersonCount: rows.length - visible.length,
    });
  });
};

export default patientResultRoutes;
