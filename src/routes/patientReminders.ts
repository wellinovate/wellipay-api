import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import { MAX_ACTIVE_REMINDERS, dueState, reminderTimeProblem } from "../lib/reminders.js";

const putBody = z.object({
  remindAt: z.string().datetime(),
  note: z.string().trim().max(120).optional(),
});

const ORDER: Record<string, number> = { OVERDUE: 0, DUE_SOON: 1, OPEN: 2 };

// A patient's unpaid bills, how urgent each is, and any reminder they set.
const patientReminderRoutes: FastifyPluginAsync = async (app) => {
  app.get("/patient/reminders", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const [invoices, reminders, tenant] = await Promise.all([
      prisma.invoice.findMany({ where: { tenantId, patientRef, status: { in: ["OPEN", "PARTIALLY_PAID"] } }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.patientReminder.findMany({ where: { tenantId, patientRef } }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    const plans = invoices.length
      ? await prisma.paymentPlan.findMany({
          where: { tenantId, status: "ACTIVE", invoiceId: { in: invoices.map((i: { id: string }) => i.id) } },
          include: { installments: { where: { status: "PENDING" }, orderBy: { seq: "asc" }, take: 1 } },
        })
      : [];
    const nextByInvoice = new Map<string, { dueAt: Date; amountMinor: bigint }>();
    for (const p of plans as { invoiceId: string; installments: { dueAt: Date; amountMinor: bigint }[] }[]) {
      const first = p.installments[0];
      if (first) nextByInvoice.set(p.invoiceId, first);
    }
    const reminderByInvoice = new Map(reminders.map((r: { invoiceId: string; remindAt: Date; note: string | null; sentAt: Date | null }) => [r.invoiceId, r]));
    const now = new Date();

    const items = invoices
      .map((inv: { id: string; providerInvoiceRef: string; description: string; amountMinor: bigint; paidAmountMinor: bigint; dueAt: Date | null }) => {
        const next = nextByInvoice.get(inv.id);
        const effectiveDue = next?.dueAt ?? inv.dueAt;
        const r = reminderByInvoice.get(inv.id) as { remindAt: Date; note: string | null; sentAt: Date | null } | undefined;
        return {
          invoiceId: inv.id,
          invoiceRef: inv.providerInvoiceRef,
          providerName: tenant?.name ?? "",
          description: inv.description,
          outstandingMinor: toMinorNumber(inv.amountMinor - inv.paidAmountMinor),
          dueAt: effectiveDue?.toISOString(),
          dueState: dueState(effectiveDue, now),
          nextInstallment: next ? { dueAt: next.dueAt.toISOString(), amountMinor: toMinorNumber(next.amountMinor) } : undefined,
          reminder: r ? { remindAt: r.remindAt.toISOString(), note: r.note ?? undefined, sent: r.sentAt !== null } : undefined,
        };
      })
      .sort((a: { dueState: string; dueAt?: string | undefined }, b: { dueState: string; dueAt?: string | undefined }) => {
        const d = (ORDER[a.dueState] ?? 3) - (ORDER[b.dueState] ?? 3);
        if (d !== 0) return d;
        return (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
      });
    return reply.code(200).send({ items });
  });

  app.put("/patient/reminders/:invoiceId", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const parsed = putBody.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const { invoiceId } = request.params as { invoiceId: string };
    const { tenantId, patientRef } = request.patientAuth!;
    const remindAt = new Date(parsed.data.remindAt);
    const timeProblem = reminderTimeProblem(remindAt);
    if (timeProblem) return sendProblem(reply, problems.unprocessable(timeProblem, "invalid_time"));

    const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, tenantId, patientRef } });
    if (!invoice) return sendProblem(reply, problems.notFound());
    if (invoice.status === "PAID" || invoice.status === "CANCELLED") return sendProblem(reply, problems.conflict("This bill needs no reminder.", "invoice_not_payable"));

    const active = await prisma.patientReminder.count({ where: { tenantId, patientRef, sentAt: null, NOT: { invoiceId } } });
    if (active >= MAX_ACTIVE_REMINDERS) return sendProblem(reply, problems.unprocessable(`You can have ${MAX_ACTIVE_REMINDERS} reminders at a time.`, "too_many_reminders"));

    const note = parsed.data.note ? parsed.data.note : null;
    const saved = await prisma.patientReminder.upsert({
      where: { tenantId_patientRef_invoiceId: { tenantId, patientRef, invoiceId } },
      create: { tenantId, patientRef, invoiceId, remindAt, note },
      update: { remindAt, note, sentAt: null },
    });
    return reply.code(200).send({ invoiceId, remindAt: saved.remindAt.toISOString(), note: saved.note ?? undefined, sent: false });
  });

  app.delete("/patient/reminders/:invoiceId", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const { invoiceId } = request.params as { invoiceId: string };
    const { tenantId, patientRef } = request.patientAuth!;
    const removed = await prisma.patientReminder.deleteMany({ where: { tenantId, patientRef, invoiceId } });
    if (removed.count === 0) return sendProblem(reply, problems.notFound());
    return reply.code(204).send();
  });
};

export default patientReminderRoutes;
