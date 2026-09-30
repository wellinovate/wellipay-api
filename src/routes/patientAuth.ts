import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { linkPatientAccountSchema } from "../schemas/patientAuth.js";
import { prisma } from "../lib/prisma.js";
import { verifyClerkToken, ClerkNotConfiguredError } from "../lib/clerk.js";
import { issueAccessToken } from "../lib/tokens.js";
import { toMinorBigInt } from "../lib/money.js";
import { sendProblem, problems } from "../lib/problem.js";

const PATIENT_SCOPES = ["patient.self.read", "patient.self.write"];
const RATE_LIMIT = {
  max: 20,
  timeWindow: "1 minute",
  errorResponseBuilder: (_request: unknown, context: { after: string; statusCode: number }) => {
    const err = new Error(`Rate limit exceeded, retry in ${context.after}.`) as Error & { statusCode?: number };
    err.statusCode = context.statusCode;
    return err;
  },
} as const;

async function requireClerkUserId(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    sendProblem(reply, problems.unauthorized("Missing bearer token (expected a Clerk session token)."));
    return undefined;
  }
  try {
    const { clerkUserId } = await verifyClerkToken(header.slice("Bearer ".length));
    return clerkUserId;
  } catch (err) {
    if (err instanceof ClerkNotConfiguredError) {
      sendProblem(reply, problems.serviceUnavailable(err.message, "clerk_not_configured"));
    } else {
      sendProblem(reply, problems.unauthorized("Clerk token is invalid or expired."));
    }
    return undefined;
  }
}

const patientAuthRoutes: FastifyPluginAsync = async (app) => {
  // First-time account linking: proves the caller holds a specific invoice
  // (ref + amount), then ties their Clerk identity to that invoice's
  // (tenantId, patientRef) permanently. See schemas/patientAuth.ts for why
  // this check is intentionally lightweight, not strong identity proofing.
  app.post(
    "/patient/link",
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const clerkUserId = await requireClerkUserId(request, reply);
      if (!clerkUserId) return;

      const parsed = linkPatientAccountSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendProblem(reply, problems.badRequest(parsed.error.issues.map((i) => i.message).join("; "), "invalid_body"));
      }

      const existingAccount = await prisma.patientAccount.findUnique({ where: { clerkUserId } });
      if (existingAccount) {
        return sendProblem(
          reply,
          problems.conflict("This account is already linked to a patient record. Use POST /patient/token instead.", "already_linked")
        );
      }

      // No tenantId filter here — providerInvoiceRef is only unique per
      // tenant, and the caller's tenant isn't known until an invoice match
      // resolves it. Fine with today's single real tenant; a genuinely
      // multi-tenant deployment would need a narrower lookup (e.g. asking
      // which facility/provider the patient means) before this scales.
      const invoice = await prisma.invoice.findFirst({
        where: { providerInvoiceRef: parsed.data.invoiceRef, amountMinor: toMinorBigInt(parsed.data.amountMinor) },
      });
      if (!invoice) {
        return sendProblem(
          reply,
          problems.unprocessable("No invoice matches that reference and amount. Double-check both against your bill.", "invoice_not_found")
        );
      }

      const account = await prisma.patientAccount.create({
        data: { clerkUserId, tenantId: invoice.tenantId, patientRef: invoice.patientRef },
      });

      const { token, expiresIn } = await issueAccessToken({
        sub: account.id,
        tenantId: account.tenantId,
        scopes: PATIENT_SCOPES,
        patientRef: account.patientRef,
      });

      return reply.code(201).send({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
    }
  );

  // Subsequent app opens: already linked, just trade a fresh Clerk session
  // for a fresh WelliPay-issued patient token.
  app.post(
    "/patient/token",
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const clerkUserId = await requireClerkUserId(request, reply);
      if (!clerkUserId) return;

      const account = await prisma.patientAccount.findUnique({ where: { clerkUserId } });
      if (!account) {
        return sendProblem(reply, problems.notFound("No linked patient account yet. Call POST /patient/link first.", "not_linked"));
      }

      const { token, expiresIn } = await issueAccessToken({
        sub: account.id,
        tenantId: account.tenantId,
        scopes: PATIENT_SCOPES,
        patientRef: account.patientRef,
      });

      return reply.code(200).send({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
    }
  );
};

export default patientAuthRoutes;
