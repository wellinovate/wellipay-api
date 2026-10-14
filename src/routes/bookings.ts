import type { FastifyPluginAsync } from "fastify";
import { createBookingSchema, updateBookingSchema, listBookingsQuerySchema } from "../schemas/bookings.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { canMoveBooking, type BookingStatusValue } from "../lib/bookings.js";
import { pendingResults } from "../lib/results.js";

function serialize(b: {
  id: string; patientRef: string; type: string; kind: string; scheduledAt: Date; address: string | null; notes: string | null;
  status: string; invoiceId: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    bookingId: b.id,
    patientRef: b.patientRef,
    type: b.type,
    kind: b.kind,
    scheduledAt: b.scheduledAt.toISOString(),
    address: b.address ?? undefined,
    notes: b.notes ?? undefined,
    status: b.status,
    invoiceId: b.invoiceId ?? undefined,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

// Sample collection and visit bookings. Status moves forward one step at a
// time: BOOKED, SAMPLE_COLLECTED, PROCESSING, READY. Cancel only while BOOKED.
const bookingRoutes: FastifyPluginAsync = async (app) => {
  app.post("/provider/bookings", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createBookingSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const patient = await prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef: body.patientRef } } });
    if (!patient) return sendProblem(reply, problems.unprocessable(`patientRef "${body.patientRef}" is not a registered patient.`, "unknown_patient"));
    if (body.invoiceId) {
      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
    }
    const created = await prisma.booking.create({
      data: {
        tenantId,
        patientRef: body.patientRef,
        type: body.type,
        kind: body.kind,
        scheduledAt: new Date(body.scheduledAt),
        address: body.address ?? null,
        notes: body.notes ?? null,
        invoiceId: body.invoiceId ?? null,
        createdBy: resolveActor(request.auth, undefined) ?? null,
      },
    });
    return reply.code(201).send(serialize(created));
  });

  app.get("/provider/bookings", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const parsed = listBookingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const { status, kind, from, to, limit, offset } = parsed.data;
    const where = {
      tenantId: request.auth!.tenantId,
      ...(status ? { status } : {}),
      ...(kind ? { kind } : {}),
      ...(from || to
        ? { scheduledAt: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.booking.findMany({ where, orderBy: { scheduledAt: "asc" }, take: limit, skip: offset }),
      prisma.booking.count({ where }),
    ]);
    return reply.code(200).send({ items: rows.map(serialize), total, limit, offset });
  });

  app.patch("/provider/bookings/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateBookingSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.booking.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Booking not found."));
    const body = parsed.data;
    if (body.status && !canMoveBooking(existing.status as BookingStatusValue, body.status)) {
      return sendProblem(reply, problems.conflict(`A booking that is ${existing.status.toLowerCase().replace("_", " ")} cannot move to ${body.status.toLowerCase().replace("_", " ")}.`, "invalid_status_change"));
    }
    if (body.invoiceId) {
      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
    }
    if (body.status === "READY") {
      const results = await prisma.bookingResult.findMany({ where: { bookingId: id, tenantId }, select: { status: true } });
      const open = pendingResults(results);
      if (open > 0) return sendProblem(reply, problems.conflict(`${open} result${open === 1 ? " is" : "s are"} not ready yet.`, "results_incomplete"));
    }
    const updated = await prisma.booking.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.scheduledAt ? { scheduledAt: new Date(body.scheduledAt) } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.invoiceId ? { invoiceId: body.invoiceId } : {}),
      },
    });
    return reply.code(200).send(serialize(updated));
  });
};

export default bookingRoutes;
