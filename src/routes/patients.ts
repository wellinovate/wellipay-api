import type { FastifyPluginAsync } from "fastify";
import { listPatientsQuerySchema } from "../schemas/patients.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";

const patientRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/provider/patients",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listPatientsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { facilityRef, limit, offset } = parsed.data;
      const where = { tenantId, ...(facilityRef ? { facilityRef } : {}) };

      const [groups, distinctPatients] = await Promise.all([
        prisma.invoice.groupBy({
          by: ["patientRef"],
          where,
          _count: { _all: true },
          _sum: { amountMinor: true, paidAmountMinor: true },
          _max: { createdAt: true },
          orderBy: { _max: { createdAt: "desc" } },
          take: limit,
          skip: offset,
        }),
        prisma.invoice.findMany({ where, distinct: ["patientRef"], select: { patientRef: true } }),
      ]);

      const items = groups.map((g) => {
        const totalBilledMinor = toMinorNumber(g._sum.amountMinor ?? 0n);
        const totalPaidMinor = toMinorNumber(g._sum.paidAmountMinor ?? 0n);
        return {
          patientRef: g.patientRef,
          invoiceCount: g._count._all,
          totalBilledMinor,
          totalPaidMinor,
          balanceMinor: totalBilledMinor - totalPaidMinor,
          lastInvoiceAt: g._max.createdAt?.toISOString(),
        };
      });

      return reply.code(200).send({ items, total: distinctPatients.length, limit, offset });
    }
  );
};

export default patientRoutes;
