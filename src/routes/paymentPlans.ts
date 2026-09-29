import type { FastifyPluginAsync } from "fastify";
import { createPaymentPlanSchema, listPaymentPlansQuerySchema, payInstallmentSchema } from "../schemas/paymentPlans.js";
import { prisma } from "../lib/prisma.js";
import { checkIdempotency, storeIdempotentResponse } from "../lib/idempotency.js";
import { queueEvent } from "../lib/webhooks.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import type { Prisma } from "@prisma/client";

const CREATE_ROUTE = "POST /provider/payment-plans";

function serializeInstallment(row: {
  id: string; seq: number; dueAt: Date; amountMinor: bigint; status: string;
  paidPaymentId: string | null; paidAt: Date | null;
}) {
  return {
    installmentId: row.id,
    seq: row.seq,
    dueAt: row.dueAt.toISOString(),
    amountMinor: toMinorNumber(row.amountMinor),
    status: row.status,
    paidPaymentId: row.paidPaymentId ?? undefined,
    paidAt: row.paidAt ? row.paidAt.toISOString() : undefined,
  };
}

function serializePlan(row: {
  id: string; invoiceId: string; totalMinor: bigint; installmentCount: number;
  status: string; createdAt: Date;
  installments?: Parameters<typeof serializeInstallment>[0][];
}) {
  return {
    planId: row.id,
    invoiceId: row.invoiceId,
    totalMinor: toMinorNumber(row.totalMinor),
    installmentCount: row.installmentCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    installments: row.installments ? row.installments.map(serializeInstallment) : undefined,
  };
}

const paymentPlanRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/provider/payment-plans",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const parsed = createPaymentPlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const idem = await checkIdempotency(prisma, request, reply, CREATE_ROUTE);
      if (!idem) return;
      if (idem.replayed) return;

      const invoice = await prisma.invoice.findFirst({ where: { id: body.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.unprocessable(`invoiceId "${body.invoiceId}" does not exist for this tenant.`, "unknown_invoice"));
      }
      const remaining = (invoice.amountMinor - invoice.paidAmountMinor) as unknown as bigint;
      if (remaining <= 0n) {
        return sendProblem(reply, problems.conflict("Invoice has no remaining balance to schedule.", "invoice_already_settled"));
      }

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const plan = await tx.paymentPlan.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            totalMinor: remaining,
            installmentCount: body.installmentCount,
          },
        });

        // Even split with the remainder folded into the last installment,
        // so the sum of installments always equals `remaining` exactly —
        // no fractional kobo left unaccounted for.
        const base: bigint = remaining / BigInt(body.installmentCount);
        const remainder: bigint = remaining - base * BigInt(body.installmentCount);
        const start = body.startAt ? new Date(body.startAt) : new Date();

        const installments = await Promise.all(
          Array.from({ length: body.installmentCount }, (_, i) => {
            const seq = i + 1;
            const dueAt = new Date(start);
            dueAt.setMonth(dueAt.getMonth() + seq);
            const amountMinor = seq === body.installmentCount ? base + remainder : base;
            return tx.paymentPlanInstallment.create({
              data: { planId: plan.id, seq, dueAt, amountMinor },
            });
          })
        );

        await queueEvent(tx, {
          tenantId,
          eventType: "payment_plan.created",
          resourceRef: plan.id,
          data: { planRef: plan.id, invoiceId: invoice.id, totalMinor: toMinorNumber(remaining), installmentCount: body.installmentCount },
        });

        return { plan, installments };
      });

      const responseBody = serializePlan({ ...created.plan, installments: created.installments });
      await storeIdempotentResponse(prisma, idem, 201, responseBody);
      return reply.code(201).header("Location", `/provider/payment-plans/${created.plan.id}`).send(responseBody);
    }
  );

  app.get(
    "/provider/payment-plans",
    { preHandler: app.requireScope("mobile.integration.read") },
    async (request, reply) => {
      const parsed = listPaymentPlansQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
      }
      const tenantId = request.auth!.tenantId;
      const { status, limit, cursor } = parsed.data;

      const rows = await prisma.paymentPlan.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { installments: { orderBy: { seq: "asc" } } },
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map((row: any) => serializePlan(row));
      return reply.code(200).send({
        items,
        nextCursor: hasMore ? rows[limit - 1]!.id : undefined,
      });
    }
  );

  app.post(
    "/provider/payment-plans/:id/installments/:seq/pay",
    { preHandler: app.requireScope("mobile.integration.write") },
    async (request, reply) => {
      const { id, seq } = request.params as { id: string; seq: string };
      const parsed = payInstallmentSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      const tenantId = request.auth!.tenantId;
      const body = parsed.data;

      const plan = await prisma.paymentPlan.findFirst({ where: { id, tenantId }, include: { installments: true } });
      if (!plan) {
        return sendProblem(reply, problems.notFound("No payment plan with that id for this tenant."));
      }
      const installment = plan.installments.find((row: any) => row.seq === Number(seq));
      if (!installment) {
        return sendProblem(reply, problems.notFound("No installment with that sequence number on this plan."));
      }
      if (installment.status !== "PENDING") {
        return sendProblem(reply, problems.conflict("Installment is already paid.", "installment_already_paid"));
      }

      const invoice = await prisma.invoice.findFirst({ where: { id: plan.invoiceId, tenantId } });
      if (!invoice) {
        return sendProblem(reply, problems.notFound("Invoice for this plan no longer exists."));
      }

      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const payment = await tx.payment.create({
          data: {
            tenantId,
            providerPaymentRef: `plan-${plan.id}-${installment.seq}`,
            invoiceId: invoice.id,
            patientRef: invoice.patientRef,
            facilityRef: invoice.facilityRef,
            channel: body.channel,
            reference: body.reference,
            amountMinor: installment.amountMinor,
          },
        });

        const newPaidAmount = invoice.paidAmountMinor + installment.amountMinor;
        const newInvoiceStatus = newPaidAmount >= invoice.amountMinor ? "PAID" : newPaidAmount > 0n ? "PARTIALLY_PAID" : invoice.status;
        const updatedInvoice = await tx.invoice.update({
          where: { id: invoice.id },
          data: { paidAmountMinor: newPaidAmount, status: newInvoiceStatus },
        });

        const updatedInstallment = await tx.paymentPlanInstallment.update({
          where: { id: installment.id },
          data: { status: "PAID", paidPaymentId: payment.id, paidAt: new Date() },
        });

        const remainingPending = plan.installments.filter((row: any) => row.id !== installment.id && row.status !== "PAID").length;
        const updatedPlan = remainingPending === 0
          ? await tx.paymentPlan.update({ where: { id: plan.id }, data: { status: "COMPLETED" } })
          : plan;

        await queueEvent(tx, {
          tenantId,
          eventType: "payment_plan.installment_paid",
          resourceRef: updatedInstallment.id,
          data: { planRef: plan.id, installmentSeq: installment.seq, paymentRef: payment.id, amountMinor: toMinorNumber(installment.amountMinor) },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "payment.recorded",
          resourceRef: payment.id,
          data: { paymentRef: payment.id, invoiceId: invoice.id, amountMinor: toMinorNumber(installment.amountMinor), channel: body.channel },
        });

        return { installment: updatedInstallment, plan: updatedPlan, invoice: updatedInvoice, payment };
      });

      return reply.code(200).send({
        installment: serializeInstallment(result.installment),
        plan: { planId: result.plan.id, status: result.plan.status },
        invoice: {
          invoiceId: result.invoice.id,
          paidAmountMinor: toMinorNumber(result.invoice.paidAmountMinor),
          status: result.invoice.status,
        },
        payment: { paymentId: result.payment.id, providerPaymentRef: result.payment.providerPaymentRef },
      });
    }
  );
};

export default paymentPlanRoutes;
