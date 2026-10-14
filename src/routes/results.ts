import type { FastifyPluginAsync } from "fastify";
import { addResultsSchema, updateResultSchema } from "../schemas/results.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { canEnterResults } from "../lib/results.js";

interface ResultRow {
  id: string; bookingId: string; testName: string; serviceItemId: string | null; status: string;
  resultText: string | null; abnormal: boolean; enteredBy: string | null; enteredAt: Date | null; createdAt: Date; updatedAt: Date;
}

function serialize(r: ResultRow) {
  return {
    resultId: r.id,
    bookingId: r.bookingId,
    testName: r.testName,
    serviceItemId: r.serviceItemId ?? undefined,
    status: r.status,
    resultText: r.resultText ?? undefined,
    abnormal: r.abnormal,
    enteredBy: r.enteredBy ?? undefined,
    enteredAt: r.enteredAt?.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Per-test results (or the report of a scan) on a booking.
const resultRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/bookings/:id/results", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const booking = await prisma.booking.findFirst({ where: { id, tenantId } });
    if (!booking) return sendProblem(reply, problems.notFound("Booking not found."));
    const rows = await prisma.bookingResult.findMany({ where: { bookingId: id, tenantId }, orderBy: { createdAt: "asc" } });
    return reply.code(200).send({ items: rows.map(serialize) });
  });

  // List the tests on a booking. Tests already listed are skipped.
  app.post("/provider/bookings/:id/results", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = addResultsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const booking = await prisma.booking.findFirst({ where: { id, tenantId } });
    if (!booking) return sendProblem(reply, problems.notFound("Booking not found."));
    if (booking.status === "CANCELLED") return sendProblem(reply, problems.conflict("This booking is cancelled.", "booking_cancelled"));
    const existing = await prisma.bookingResult.findMany({ where: { bookingId: id }, select: { testName: true } });
    const have = new Set(existing.map((e) => e.testName.toLowerCase()));
    const fresh = parsed.data.tests.filter((t, i, all) => !have.has(t.testName.toLowerCase()) && all.findIndex((o) => o.testName.toLowerCase() === t.testName.toLowerCase()) === i);
    if (fresh.length > 0) {
      await prisma.bookingResult.createMany({
        data: fresh.map((t) => ({
          tenantId,
          bookingId: id,
          testName: t.testName,
          ...(t.serviceItemId !== undefined ? { serviceItemId: t.serviceItemId } : {}),
        })),
      });
    }
    const rows = await prisma.bookingResult.findMany({ where: { bookingId: id, tenantId }, orderBy: { createdAt: "asc" } });
    return reply.code(201).send({ items: rows.map(serialize), added: fresh.length });
  });

  app.patch("/provider/booking-results/:resultId", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateResultSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { resultId } = request.params as { resultId: string };
    const existing = await prisma.bookingResult.findFirst({ where: { id: resultId, tenantId }, include: { booking: true } });
    if (!existing) return sendProblem(reply, problems.notFound("Result not found."));
    if (!canEnterResults(existing.booking.status)) {
      return sendProblem(reply, problems.conflict("Results can be entered after the sample is collected.", "booking_not_ready_for_results"));
    }
    const body = parsed.data;
    const nextText = body.resultText === undefined ? existing.resultText : body.resultText;
    if (body.status === "READY" && !nextText) {
      return sendProblem(reply, problems.unprocessable("Enter the result before marking it ready.", "result_text_required"));
    }
    const actor = resolveActor(request.auth, undefined) ?? null;
    const entering = body.resultText !== undefined || body.status === "READY";
    const updated = await prisma.bookingResult.update({
      where: { id: resultId },
      data: {
        ...(body.resultText !== undefined ? { resultText: body.resultText } : {}),
        ...(body.abnormal !== undefined ? { abnormal: body.abnormal } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(entering ? { enteredBy: actor, enteredAt: new Date() } : {}),
      },
    });
    return reply.code(200).send(serialize(updated));
  });
};

export default resultRoutes;
