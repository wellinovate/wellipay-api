import type { FastifyPluginAsync } from "fastify";
import { createCorporateAccountSchema, updateCorporateAccountSchema } from "../schemas/corporateAccounts.js";
import { prisma } from "../lib/prisma.js";
import { sendProblem, problems } from "../lib/problem.js";
import { resolveActor } from "../lib/actor.js";
import { toMinorNumber } from "../lib/money.js";

type AccountRow = { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; active: boolean; createdAt: Date };

function serialize(a: AccountRow, totals?: { billedMinor: number; paidMinor: number; invoiceCount: number }) {
  return {
    accountId: a.id,
    name: a.name,
    contactName: a.contactName ?? undefined,
    email: a.email ?? undefined,
    phone: a.phone ?? undefined,
    active: a.active,
    createdAt: a.createdAt.toISOString(),
    ...(totals ? { ...totals, outstandingMinor: totals.billedMinor - totals.paidMinor } : {}),
  };
}

// Companies billed on account. An invoice joins an account through
// corporateAccountId on POST /provider/invoices. The statement lists them.
const corporateAccountRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/corporate-accounts", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const [accounts, invoices] = await Promise.all([
      prisma.corporateAccount.findMany({ where: { tenantId }, orderBy: { name: "asc" }, take: 500 }),
      prisma.invoice.findMany({
        where: { tenantId, corporateAccountId: { not: null }, status: { not: "CANCELLED" } },
        select: { corporateAccountId: true, amountMinor: true, paidAmountMinor: true },
      }),
    ]);
    const totals = new Map<string, { billedMinor: number; paidMinor: number; invoiceCount: number }>();
    for (const inv of invoices) {
      const key = inv.corporateAccountId as string;
      const t = totals.get(key) ?? { billedMinor: 0, paidMinor: 0, invoiceCount: 0 };
      t.billedMinor += toMinorNumber(inv.amountMinor);
      t.paidMinor += toMinorNumber(inv.paidAmountMinor);
      t.invoiceCount += 1;
      totals.set(key, t);
    }
    return reply.code(200).send({ items: accounts.map((a) => serialize(a, totals.get(a.id) ?? { billedMinor: 0, paidMinor: 0, invoiceCount: 0 })) });
  });

  app.post("/provider/corporate-accounts", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = createCorporateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const body = parsed.data;
    const clash = await prisma.corporateAccount.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
    if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already an account.`, "corporate_account_exists"));
    const created = await prisma.corporateAccount.create({
      data: {
        tenantId,
        name: body.name,
        contactName: body.contactName ?? null,
        email: body.email ?? null,
        phone: body.phone ?? null,
        createdBy: resolveActor(request.auth, undefined) ?? null,
      },
    });
    return reply.code(201).send(serialize(created));
  });

  app.patch("/provider/corporate-accounts/:id", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = updateCorporateAccountSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const existing = await prisma.corporateAccount.findFirst({ where: { id, tenantId } });
    if (!existing) return sendProblem(reply, problems.notFound("Account not found."));
    const body = parsed.data;
    if (body.name && body.name !== existing.name) {
      const clash = await prisma.corporateAccount.findUnique({ where: { tenantId_name: { tenantId, name: body.name } } });
      if (clash) return sendProblem(reply, problems.conflict(`"${body.name}" is already an account.`, "corporate_account_exists"));
    }
    const updated = await prisma.corporateAccount.update({ where: { id }, data: body });
    return reply.code(200).send(serialize(updated));
  });

  app.get("/provider/corporate-accounts/:id/statement", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const { id } = request.params as { id: string };
    const account = await prisma.corporateAccount.findFirst({ where: { id, tenantId } });
    if (!account) return sendProblem(reply, problems.notFound("Account not found."));
    const invoices = await prisma.invoice.findMany({
      where: { tenantId, corporateAccountId: id },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    const live = invoices.filter((i) => i.status !== "CANCELLED");
    const billedMinor = live.reduce((sum, i) => sum + toMinorNumber(i.amountMinor), 0);
    const paidMinor = live.reduce((sum, i) => sum + toMinorNumber(i.paidAmountMinor), 0);
    return reply.code(200).send({
      account: serialize(account),
      billedMinor,
      paidMinor,
      outstandingMinor: billedMinor - paidMinor,
      invoices: invoices.map((i) => ({
        invoiceId: i.id,
        providerInvoiceRef: i.providerInvoiceRef,
        patientRef: i.patientRef,
        description: i.description,
        amountMinor: toMinorNumber(i.amountMinor),
        paidAmountMinor: toMinorNumber(i.paidAmountMinor),
        status: i.status,
        createdAt: i.createdAt.toISOString(),
      })),
    });
  });
};

export default corporateAccountRoutes;
