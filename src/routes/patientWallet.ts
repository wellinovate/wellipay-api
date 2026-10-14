import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import { initializeTransaction, PaystackError } from "../lib/paystack.js";
import { resolveChargeAmount } from "../lib/payLinks.js";
import { queueEvent } from "../lib/webhooks.js";
import { topUpProblem, walletPayProblem, walletView } from "../lib/wallet.js";

class WalletError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const topUpBody = z.object({
  amountMinor: z.number().int().min(1),
  email: z.string().trim().email().max(160).optional(),
});

const payBody = z.object({
  invoiceId: z.string().min(1),
  amountMinor: z.number().int().min(100).optional(),
});

// Prepaid credit with one provider. A top-up is paid to the provider, so the
// platform never holds the money. Paying a bill moves credit to that bill.
const patientWalletRoutes: FastifyPluginAsync = async (app) => {
  app.get("/patient/wallet", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { tenantId, patientRef } = request.patientAuth!;
    const [account, entries, tenant] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } }),
      prisma.walletEntry.findMany({ where: { tenantId, patientRef }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 30 }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    ]);
    return reply.code(200).send({
      ...walletView(account?.balanceMinor ?? 0n),
      providerName: tenant?.name ?? "",
      entries: entries.map((e: { id: string; kind: string; amountMinor: bigint; reference: string; invoiceId: string | null; createdAt: Date }) => ({
        entryId: e.id,
        kind: e.kind,
        amountMinor: toMinorNumber(e.amountMinor),
        reference: e.reference,
        invoiceId: e.invoiceId ?? undefined,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });

  app.post("/patient/wallet/topups", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    if (!env.PAYSTACK_SECRET_KEY) return sendProblem(reply, problems.unprocessable("Online payment is not set up yet.", "paystack_not_configured"));
    const parsed = topUpBody.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const { tenantId, patientRef } = request.patientAuth!;
    const [account, record, tenant] = await Promise.all([
      prisma.walletAccount.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } }),
      prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } }),
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { paystackSubaccountCode: true } }),
    ]);
    const amount = BigInt(parsed.data.amountMinor);
    const problem = topUpProblem(amount, account?.balanceMinor ?? 0n);
    if (problem) return sendProblem(reply, problems.unprocessable(problem, "invalid_amount"));
    const email = parsed.data.email ?? record?.email ?? undefined;
    if (!email) return sendProblem(reply, problems.unprocessable("Add an email address for your payment receipt.", "email_required"));

    const reference = `wt_${randomUUID().replace(/-/g, "")}`;
    let init;
    try {
      init = await initializeTransaction(env.PAYSTACK_SECRET_KEY, {
        email,
        amountMinor: Number(amount),
        reference,
        callbackUrl: env.PAY_PAGE_URL ? `${env.PAY_PAGE_URL}?done=1` : env.PAYSTACK_CALLBACK_URL,
        metadata: { tenantId, kind: "wallet_topup" },
        subaccount: tenant?.paystackSubaccountCode ?? null,
      });
    } catch (err) {
      if (err instanceof PaystackError) return sendProblem(reply, problems.badGateway(err.message, "paystack_unavailable"));
      return sendProblem(reply, problems.badGateway("Could not reach the payment service.", "paystack_unavailable"));
    }
    const topUp = await prisma.walletTopUp.create({
      data: { tenantId, patientRef, reference, amountMinor: amount, email, authorizationUrl: init.authorizationUrl },
    });
    return reply.code(201).send({ reference: topUp.reference, authorizationUrl: topUp.authorizationUrl, amountMinor: toMinorNumber(topUp.amountMinor), status: topUp.status });
  });

  app.get("/patient/wallet/topups/:reference", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { reference } = request.params as { reference: string };
    const { tenantId, patientRef } = request.patientAuth!;
    const topUp = await prisma.walletTopUp.findFirst({ where: { reference, tenantId, patientRef } });
    if (!topUp) return sendProblem(reply, problems.notFound());
    return reply.code(200).send({
      reference: topUp.reference,
      amountMinor: toMinorNumber(topUp.amountMinor),
      status: topUp.status,
      failureReason: topUp.failureReason ?? undefined,
      createdAt: topUp.createdAt.toISOString(),
    });
  });

  app.post("/patient/wallet/pay", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const parsed = payBody.safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    const { tenantId, patientRef } = request.patientAuth!;
    const ref = `wallet_${randomUUID().replace(/-/g, "")}`;

    try {
      const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const invoice = await tx.invoice.findFirst({ where: { id: parsed.data.invoiceId, tenantId, patientRef } });
        if (!invoice) throw new WalletError(404, "not_found", "Bill not found.");
        if (invoice.status === "PAID" || invoice.status === "CANCELLED") throw new WalletError(409, "invoice_not_payable", `This bill is ${invoice.status.toLowerCase()}.`);
        const outstanding = BigInt(invoice.amountMinor) - BigInt(invoice.paidAmountMinor);
        const resolved = resolveChargeAmount(outstanding, parsed.data.amountMinor !== undefined ? BigInt(parsed.data.amountMinor) : undefined);
        if ("error" in resolved) throw new WalletError(422, "invalid_amount", resolved.error);
        const amount = resolved.amount;

        const account = await tx.walletAccount.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } });
        const problem = walletPayProblem(amount, account?.balanceMinor ?? 0n, outstanding);
        if (problem) throw new WalletError(422, "insufficient_balance", problem);

        // The balance check and the debit are one statement, so two payments
        // at once cannot both spend the same credit.
        const debited = await tx.walletAccount.updateMany({
          where: { tenantId, patientRef, balanceMinor: { gte: amount } },
          data: { balanceMinor: { decrement: amount } },
        });
        if (debited.count === 0) throw new WalletError(422, "insufficient_balance", "Your wallet balance is too low.");

        const paid = BigInt(invoice.paidAmountMinor) + amount;
        const bumped = await tx.invoice.updateMany({
          where: { id: invoice.id, paidAmountMinor: invoice.paidAmountMinor },
          data: { paidAmountMinor: paid, status: paid >= BigInt(invoice.amountMinor) ? "PAID" : "PARTIALLY_PAID" },
        });
        if (bumped.count === 0) throw new WalletError(409, "bill_changed", "The bill changed. Try again.");

        const payment = await tx.payment.create({
          data: {
            tenantId,
            providerPaymentRef: ref,
            invoiceId: invoice.id,
            patientRef,
            facilityRef: invoice.facilityRef,
            channel: "wallet",
            reference: ref,
            amountMinor: amount,
            currency: "NGN",
          },
        });
        await tx.walletEntry.create({
          data: { tenantId, patientRef, kind: "INVOICE_PAYMENT", amountMinor: -amount, reference: ref, invoiceId: invoice.id, paymentId: payment.id },
        });
        await queueEvent(tx, {
          tenantId,
          eventType: "payment.recorded",
          resourceRef: payment.id,
          data: { paymentRef: payment.id, invoiceId: invoice.id, amountMinor: toMinorNumber(amount), channel: "wallet" },
        });
        const after = await tx.walletAccount.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } });
        return { paymentId: payment.id, paidMinor: amount, invoiceStatus: paid >= BigInt(invoice.amountMinor) ? "PAID" : "PARTIALLY_PAID", balanceMinor: after?.balanceMinor ?? 0n };
      });
      return reply.code(201).send({
        paymentId: result.paymentId,
        reference: ref,
        amountMinor: toMinorNumber(result.paidMinor),
        invoiceStatus: result.invoiceStatus,
        balanceMinor: toMinorNumber(result.balanceMinor),
      });
    } catch (err) {
      if (err instanceof WalletError) return sendProblem(reply, { status: err.status, title: err.status === 404 ? "Not Found" : err.status === 409 ? "Conflict" : "Unprocessable Entity", detail: err.message, code: err.code });
      throw err;
    }
  });
};

export default patientWalletRoutes;
