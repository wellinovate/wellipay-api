import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { cardView } from "../lib/cards.js";

// Cards a signed-in patient chose to keep. The token never leaves the server.
const patientCardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/patient/payment-methods", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const rows = await prisma.savedPaymentMethod.findMany({ where: { tenantId, patientRef }, orderBy: { createdAt: "desc" }, take: 20 });
    return reply.code(200).send({ items: rows.map((r: Parameters<typeof cardView>[0]) => cardView(r)) });
  });

  app.delete("/patient/payment-methods/:id", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { tenantId, patientRef } = request.patientAuth!;
    const removed = await prisma.savedPaymentMethod.deleteMany({ where: { id, tenantId, patientRef } });
    if (removed.count === 0) return sendProblem(reply, problems.notFound());
    return reply.code(204).send();
  });
};

export default patientCardRoutes;
