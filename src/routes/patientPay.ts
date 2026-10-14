import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorNumber } from "../lib/money.js";
import { startCharge, ChargeError } from "../lib/charges.js";
import { normalizeClaimCode } from "../lib/payLinks.js";
import { transactionView, type ChargeRow } from "../lib/transactions.js";
import { publicRateLimit } from "../lib/publicRateLimit.js";

const startBody = z.object({
  invoiceId: z.string().min(1),
  email: z.string().trim().email().max(160).optional(),
  amountMinor: z.number().int().min(100).optional(),
  saveCard: z.boolean().optional(),
  savedMethodId: z.string().min(1).optional(),
});

const listQuery = z.object({
  status: z.enum(["PENDING", "SUCCESS", "FAILED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Builds the transaction views for a set of charges belonging to one patient.
async function viewsFor(tenantId: string, patientRef: string, charges: ChargeRow[]) {
  if (charges.length === 0) return [];
  const invoiceIds = [...new Set(charges.map((c) => c.invoiceId))];
  const [invoices, tenant, payments] = await Promise.all([
    prisma.invoice.findMany({ where: { tenantId, id: { in: invoiceIds } }, include: { lines: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    prisma.payment.findMany({ where: { tenantId, id: { in: charges.map((c) => c.paymentId).filter((x): x is string => !!x) } }, include: { refunds: true } }),
  ]);
  const invoiceById = new Map(invoices.map((i: { id: string }) => [i.id, i]));
  const paymentById = new Map(payments.map((p: { id: string }) => [p.id, p]));
  return charges.map((c) => {
    const inv = invoiceById.get(c.invoiceId) as
      | { providerInvoiceRef: string; description: string; patientRef: string; lines: { position: number; description: string; quantity: number; unitPriceMinor: number }[] }
      | undefined;
    const pay = c.paymentId ? (paymentById.get(c.paymentId) as { occurredAt: Date; refunds: { status: string; amountMinor: bigint }[] } | undefined) : undefined;
    return transactionView(
      c,
      {
        providerInvoiceRef: inv?.providerInvoiceRef ?? "",
        description: inv?.description ?? "",
        patientRef: inv?.patientRef ?? "",
        providerName: tenant?.name ?? "",
        lines: inv?.lines
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((l) => ({ description: l.description, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor })),
      },
      pay?.occurredAt ?? null,
      pay?.refunds ?? [],
      patientRef,
    );
  });
}

async function ownCharges(tenantId: string, patientRef: string, extra: object = {}) {
  const mine = await prisma.invoice.findMany({ where: { tenantId, patientRef }, select: { id: true }, take: 500 });
  return prisma.paystackCharge.findMany({
    where: { tenantId, OR: [{ invoiceId: { in: mine.map((i: { id: string }) => i.id) } }, { payerPatientRef: patientRef }], ...extra },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  });
}

// A signed-in patient pays their own bills and sees every payment attempt.
const patientPayRoutes: FastifyPluginAsync = async (app) => {
  app.post("/patient/paystack/charges", { preHandler: app.requirePatientScope("patient.self.write") }, async (request, reply) => {
    const parsed = startBody.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const { tenantId, patientRef } = request.patientAuth!;
    const invoice = await prisma.invoice.findFirst({ where: { id: parsed.data.invoiceId, tenantId, patientRef } });
    if (!invoice) return sendProblem(reply, problems.notFound());
    const record = await prisma.patientRecord.findUnique({ where: { tenantId_patientRef: { tenantId, patientRef } } });
    const email = parsed.data.email ?? record?.email ?? undefined;
    if (!email && !parsed.data.savedMethodId) return sendProblem(reply, problems.unprocessable("Add an email address for your payment receipt.", "email_required"));
    try {
      const charge = await startCharge({
        tenantId,
        invoiceId: invoice.id,
        email: email ?? "",
        amountMinor: parsed.data.amountMinor !== undefined ? BigInt(parsed.data.amountMinor) : undefined,
        saveCard: parsed.data.saveCard,
        savedMethodId: parsed.data.savedMethodId,
        source: "PATIENT",
        payerPatientRef: patientRef,
        callbackUrl: env.PAY_PAGE_URL ? `${env.PAY_PAGE_URL}?done=1` : undefined,
      });
      return reply.code(201).send({
        reference: charge.reference,
        authorizationUrl: charge.authorizationUrl,
        amountMinor: toMinorNumber(charge.amountMinor),
        status: charge.status,
      });
    } catch (err) {
      if (err instanceof ChargeError) return sendProblem(reply, { status: err.status, title: err.status === 502 ? "Bad Gateway" : "Error", detail: err.message, code: err.code });
      throw err;
    }
  });

  app.get("/patient/transactions", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_query"));
    }
    const { tenantId, patientRef } = request.patientAuth!;
    const charges = await ownCharges(tenantId, patientRef, parsed.data.status ? { status: parsed.data.status } : {});
    const items = await viewsFor(tenantId, patientRef, charges.slice(0, parsed.data.limit));
    return reply.code(200).send({ items });
  });

  app.get("/patient/transactions/:reference", { preHandler: app.requirePatientScope("patient.self.read") }, async (request, reply) => {
    const { reference } = request.params as { reference: string };
    const { tenantId, patientRef } = request.patientAuth!;
    const charges = await ownCharges(tenantId, patientRef, { reference });
    const first = charges[0];
    if (!first) return sendProblem(reply, problems.notFound());
    const [view] = await viewsFor(tenantId, patientRef, [first]);
    return reply.code(200).send(view);
  });

  // Add a guest payment to this profile with the code printed on the guest receipt.
  app.post("/patient/transactions/claim", { preHandler: app.requirePatientScope("patient.self.write"), config: publicRateLimit(10) }, async (request, reply) => {
    const parsed = z.object({ claimCode: z.string().trim().min(6).max(24) }).safeParse(request.body);
    if (!parsed.success) return sendProblem(reply, problems.badRequest("Enter the code from your receipt.", "invalid_body"));
    const { tenantId, patientRef } = request.patientAuth!;
    const code = normalizeClaimCode(parsed.data.claimCode);
    const charge = await prisma.paystackCharge.findUnique({ where: { claimCode: code } });
    // Same answer for a wrong code and for another provider's payment.
    if (!charge || charge.tenantId !== tenantId || charge.source !== "GUEST") {
      return sendProblem(reply, problems.notFound("That code was not found."));
    }
    if (charge.payerPatientRef && charge.payerPatientRef !== patientRef) {
      return sendProblem(reply, problems.conflict("That payment is already on another profile.", "already_claimed"));
    }
    const updated = charge.payerPatientRef
      ? charge
      : await prisma.paystackCharge.update({ where: { id: charge.id }, data: { payerPatientRef: patientRef } });
    const [view] = await viewsFor(tenantId, patientRef, [updated]);
    return reply.code(200).send(view);
  });
};

export default patientPayRoutes;
