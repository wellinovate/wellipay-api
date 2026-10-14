import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { setRefundLimitSchema } from "../schemas/account.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";

const accountSelect = {
  name: true,
  providerType: true,
  paystackSubaccountCode: true,
  settlementBankCode: true,
  settlementAccountNumber: true,
  settlementAccountName: true,
  refundApprovalLimitMinor: true,
} as const;

function serializeAccount(t: {
  name: string; providerType: string | null; paystackSubaccountCode: string | null; settlementBankCode: string | null;
  settlementAccountNumber: string | null; settlementAccountName: string | null; refundApprovalLimitMinor: bigint | null;
}) {
  return {
    name: t.name,
    providerType: t.providerType ?? "HOSPITAL",
    // The full account number is never sent. The last four digits are enough to recognise the account.
    settlement: {
      hasPayoutAccount: Boolean(t.paystackSubaccountCode),
      bankCode: t.settlementBankCode ?? undefined,
      accountName: t.settlementAccountName ?? undefined,
      accountNumberLast4: t.settlementAccountNumber ? t.settlementAccountNumber.slice(-4) : undefined,
    },
    refundApprovalLimitMinor: t.refundApprovalLimitMinor === null ? null : toMinorNumber(t.refundApprovalLimitMinor),
  };
}

const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get("/provider/account", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: request.auth!.tenantId }, select: accountSelect });
    if (!tenant) return sendProblem(reply, problems.notFound());
    return reply.code(200).send(serializeAccount(tenant));
  });

  app.patch("/provider/account/refund-limit", { preHandler: app.requireScope("mobile.integration.write") }, async (request, reply) => {
    const parsed = setRefundLimitSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
    }
    const tenant = await prisma.tenant.update({
      where: { id: request.auth!.tenantId },
      data: { refundApprovalLimitMinor: parsed.data.limitMinor === null ? null : toMinorBigInt(parsed.data.limitMinor) },
      select: accountSelect,
    });
    return reply.code(200).send(serializeAccount(tenant));
  });
};

export default accountRoutes;
