import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { prisma } from "./prisma.js";
import { initializeTransaction, PaystackError } from "./paystack.js";
import { resolveChargeAmount } from "./payLinks.js";

export class ChargeError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface StartChargeInput {
  tenantId: string;
  invoiceId: string;
  email: string;
  amountMinor?: bigint | undefined;
  source: "PATIENT" | "GUEST";
  payerPatientRef?: string | undefined;
  payerPhone?: string | undefined;
  claimCode?: string | undefined;
  callbackUrl?: string | undefined;
}

// Starts a Paystack checkout for an invoice and records the charge. The Payment
// is created later, by Paystack's signed webhook.
export async function startCharge(input: StartChargeInput) {
  if (!env.PAYSTACK_SECRET_KEY) throw new ChargeError(503, "paystack_not_configured", "Online payment is not set up yet.");
  const invoice = await prisma.invoice.findFirst({ where: { id: input.invoiceId, tenantId: input.tenantId } });
  if (!invoice) throw new ChargeError(404, "not_found", "Bill not found.");
  if (invoice.status === "PAID" || invoice.status === "CANCELLED") {
    throw new ChargeError(409, "invoice_not_payable", `This bill is ${invoice.status.toLowerCase()}.`);
  }
  const outstanding = BigInt(invoice.amountMinor) - BigInt(invoice.paidAmountMinor);
  const resolved = resolveChargeAmount(outstanding, input.amountMinor);
  if ("error" in resolved) throw new ChargeError(422, "invalid_amount", resolved.error);

  const reference = `wp_${randomUUID().replace(/-/g, "")}`;
  const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { paystackSubaccountCode: true } });
  let init;
  try {
    init = await initializeTransaction(env.PAYSTACK_SECRET_KEY, {
      email: input.email,
      amountMinor: Number(resolved.amount),
      reference,
      callbackUrl: input.callbackUrl ?? env.PAYSTACK_CALLBACK_URL,
      metadata: { invoiceId: invoice.id, tenantId: input.tenantId, source: input.source },
      subaccount: tenant?.paystackSubaccountCode ?? null,
    });
  } catch (err) {
    if (err instanceof PaystackError) throw new ChargeError(502, "paystack_unavailable", err.message);
    throw new ChargeError(502, "paystack_unavailable", "Could not reach the payment service.");
  }
  return prisma.paystackCharge.create({
    data: {
      tenantId: input.tenantId,
      invoiceId: invoice.id,
      reference,
      amountMinor: resolved.amount,
      email: input.email,
      authorizationUrl: init.authorizationUrl,
      source: input.source,
      ...(input.payerPatientRef !== undefined ? { payerPatientRef: input.payerPatientRef } : {}),
      ...(input.payerPhone !== undefined ? { payerPhone: input.payerPhone } : {}),
      ...(input.claimCode !== undefined ? { claimCode: input.claimCode } : {}),
    },
  });
}
