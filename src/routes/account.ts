import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../lib/prisma.js";
import { setRefundLimitSchema } from "../schemas/account.js";
import { sendProblem, problems } from "../lib/problem.js";
import { toMinorBigInt, toMinorNumber } from "../lib/money.js";
import { env } from "../env.js";
import { serializeSubscription } from "../lib/subscription.js";

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

  // Plan and fee terms. Values are null when Wellinovate has not recorded them.
  app.get("/provider/subscription", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: request.auth!.tenantId },
      select: { planName: true, planMonthlyFeeMinor: true, platformFeePercent: true, planStartedAt: true },
    });
    if (!tenant) return sendProblem(reply, problems.notFound());
    return reply.code(200).send(serializeSubscription(tenant, env.PLATFORM_FEE_PERCENT));
  });

  // What is set up on this service for the tenant. Reports whether each service
  // is configured and the state of the tenant's own webhook queue. It makes no
  // call to Paystack or Termii, so "configured" means a key is present, not that
  // the provider accepts it.
  app.get("/provider/integrations/status", { preHandler: app.requireScope("mobile.integration.read") }, async (request, reply) => {
    const tenantId = request.auth!.tenantId;
    const [tenant, activeEndpoints, pendingEvents, deadEvents, lastDelivered] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { paystackSubaccountCode: true } }),
      prisma.webhookEndpoint.count({ where: { tenantId, active: true } }),
      prisma.outboxEvent.count({ where: { tenantId, status: "PENDING" } }),
      prisma.outboxEvent.count({ where: { tenantId, status: "DEAD_LETTERED" } }),
      prisma.outboxEvent.findFirst({ where: { tenantId, status: "DELIVERED" }, orderBy: { deliveredAt: "desc" }, select: { deliveredAt: true } }),
    ]);
    return reply.code(200).send({
      paystack: { configured: Boolean(env.PAYSTACK_SECRET_KEY), hasPayoutAccount: Boolean(tenant?.paystackSubaccountCode) },
      sms: { configured: Boolean(env.TERMII_API_KEY), senderId: env.TERMII_SENDER_ID },
      webhooks: {
        activeEndpoints,
        pendingEvents,
        deadLetteredEvents: deadEvents,
        lastDeliveredAt: lastDelivered?.deliveredAt?.toISOString(),
      },
    });
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
