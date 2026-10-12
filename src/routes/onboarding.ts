import type { FastifyPluginAsync } from "fastify";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { listBanks, resolveAccount, PaystackError, type Bank } from "../lib/paystack.js";
import { sendProblem, problems } from "../lib/problem.js";
import { createApplicationSchema } from "../schemas/onboarding.js";

// Public routes a provider uses to ask to join. They create an application,
// never a tenant, and give nothing back that is not the applicant's own input.
// A person at Wellinovate approves applications from the shell
// (src/scripts/providerApplications.ts).
let bankCache: { at: number; banks: Bank[] } | null = null;
const BANK_CACHE_MS = 60 * 60 * 1000;

const notConfigured = (reply: Parameters<typeof sendProblem>[0]) =>
  sendProblem(reply, { status: 503, title: "Service Unavailable", detail: "Provider sign-up is not available right now.", code: "paystack_not_configured" });

const onboardingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/onboarding/banks", async (request, reply) => {
    if (!env.PAYSTACK_SECRET_KEY) return notConfigured(reply);
    if (!bankCache || Date.now() - bankCache.at > BANK_CACHE_MS) {
      try {
        bankCache = { at: Date.now(), banks: await listBanks(env.PAYSTACK_SECRET_KEY) };
      } catch (err) {
        request.log.error({ err }, "Paystack bank list failed");
        return sendProblem(reply, { status: 502, title: "Bad Gateway", detail: "Could not load the bank list.", code: "paystack_unavailable" });
      }
    }
    return reply.code(200).send({ items: bankCache.banks });
  });

  app.post(
    "/onboarding/applications",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 hour",
          errorResponseBuilder: (_request, context) => {
            const err = new Error(`Too many applications from this address, retry in ${context.after}.`) as Error & { statusCode?: number };
            err.statusCode = context.statusCode;
            return err;
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = createApplicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }
      if (!env.PAYSTACK_SECRET_KEY) return notConfigured(reply);
      const body = parsed.data;
      const email = body.contactEmail.toLowerCase();

      // One open application per email, and no application for an email that
      // already signs in to a tenant.
      const [pending, staff] = await Promise.all([
        prisma.providerApplication.findFirst({ where: { contactEmail: { equals: email, mode: "insensitive" }, status: "PENDING" } }),
        prisma.staff.findFirst({ where: { email: { equals: email, mode: "insensitive" } } }),
      ]);
      if (pending || staff) {
        return sendProblem(reply, problems.conflict("An application or account already exists for this email.", "application_exists"));
      }

      let accountName: string;
      try {
        ({ accountName } = await resolveAccount(env.PAYSTACK_SECRET_KEY, { accountNumber: body.accountNumber, bankCode: body.bankCode }));
      } catch (err) {
        if (err instanceof PaystackError) {
          return sendProblem(reply, problems.unprocessable("The bank could not confirm this account number. Check the bank and the number.", "account_not_verified"));
        }
        request.log.error({ err }, "Paystack account resolve failed");
        return sendProblem(reply, { status: 502, title: "Bad Gateway", detail: "Could not reach the bank check. Try again.", code: "paystack_unavailable" });
      }

      const bankName = bankCache?.banks.find((b) => b.code === body.bankCode)?.name ?? null;
      const application = await prisma.providerApplication.create({
        data: {
          businessName: body.businessName,
          providerType: body.providerType,
          contactName: body.contactName,
          contactEmail: email,
          contactPhone: body.contactPhone,
          address: body.address ?? null,
          licenseNumber: body.licenseNumber ?? null,
          bankCode: body.bankCode,
          bankName,
          accountNumber: body.accountNumber,
          accountName,
        },
      });
      // accountName goes back so the applicant can see which name the bank holds.
      return reply.code(201).send({ applicationId: application.id, status: application.status, accountName });
    }
  );
};

export default onboardingRoutes;
