import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { prisma } from "./prisma.js";
import { initializeTransaction, chargeAuthorization, PaystackError, PaystackDeclined } from "./paystack.js";
import { cardExpired } from "./cards.js";
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
  // Keep the card for next time. Only for a signed-in patient.
  saveCard?: boolean | undefined;
  // Pay with a card the patient saved earlier instead of opening checkout.
  savedMethodId?: string | undefined;
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

  if (input.savedMethodId) {
    if (input.source !== "PATIENT" || !input.payerPatientRef) throw new ChargeError(403, "forbidden", "Saved cards are for signed-in patients.");
    const method = await prisma.savedPaymentMethod.findFirst({ where: { id: input.savedMethodId, tenantId: input.tenantId, patientRef: input.payerPatientRef } });
    if (!method) throw new ChargeError(404, "method_not_found", "That card was not found.");
    if (cardExpired(method.expMonth, method.expYear)) throw new ChargeError(422, "card_expired", "That card has expired. Remove it and pay with a new one.");
    // The row exists before Paystack is called, so a fast webhook always finds it.
    const pending = await prisma.paystackCharge.create({
      data: {
        tenantId: input.tenantId,
        invoiceId: invoice.id,
        reference,
        amountMinor: resolved.amount,
        email: method.email,
        source: "PATIENT",
        payerPatientRef: input.payerPatientRef,
        savedMethodId: method.id,
      },
    });
    try {
      const result = await chargeAuthorization(env.PAYSTACK_SECRET_KEY, {
        email: method.email,
        amountMinor: Number(resolved.amount),
        authorizationCode: method.authorizationCode,
        reference,
        metadata: { invoiceId: invoice.id, tenantId: input.tenantId, source: "PATIENT", savedMethod: true },
        subaccount: tenant?.paystackSubaccountCode ?? null,
      });
      if (!["success", "pending", "ongoing", "processing", "queued"].includes(result.status)) {
        throw new PaystackDeclined("The bank needs you to confirm this payment. Pay with a new card instead.");
      }
    } catch (err) {
      const reason = err instanceof PaystackError ? err.message : "Could not reach the payment service.";
      // Mark the charge failed only when Paystack said no. After a network
      // error the charge may still have gone through, and the webhook settles it.
      if (err instanceof PaystackDeclined) {
        await prisma.paystackCharge.updateMany({ where: { id: pending.id, status: "PENDING" }, data: { status: "FAILED", failureReason: reason.slice(0, 200) } });
        throw new ChargeError(422, "card_declined", reason);
      }
      throw new ChargeError(502, "paystack_unavailable", reason);
    }
    return pending;
  }
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
      saveCard: input.saveCard === true && input.source === "PATIENT",
      ...(input.payerPatientRef !== undefined ? { payerPatientRef: input.payerPatientRef } : {}),
      ...(input.payerPhone !== undefined ? { payerPhone: input.payerPhone } : {}),
      ...(input.claimCode !== undefined ? { claimCode: input.claimCode } : {}),
    },
  });
}
