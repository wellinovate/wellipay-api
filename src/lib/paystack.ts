import { createHmac, timingSafeEqual } from "node:crypto";

const BASE_URL = "https://api.paystack.co";

// Paystack signs the raw webhook body with HMAC-SHA512 using the secret key
// and sends the hex digest in the x-paystack-signature header.
export function verifyPaystackSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader.trim().toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Paystack channel names -> the channel values this API already uses.
export function mapPaystackChannel(channel: unknown): "card" | "bank_transfer" | "ussd" {
  if (channel === "bank_transfer" || channel === "bank") return "bank_transfer";
  if (channel === "ussd") return "ussd";
  return "card";
}

export interface InitializeInput {
  email: string;
  amountMinor: number;
  reference: string;
  callbackUrl?: string | undefined;
  metadata?: Record<string, unknown>;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
}

export class PaystackError extends Error {}

// Amounts are kobo, which is what Paystack expects, so no conversion.
export async function initializeTransaction(secret: string, input: InitializeInput, fetchImpl: typeof fetch = fetch): Promise<InitializeResult> {
  const res = await fetchImpl(`${BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountMinor,
      currency: "NGN",
      reference: input.reference,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
  });
  const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: { authorization_url?: string; access_code?: string } } | null;
  if (!res.ok || !payload?.status || !payload.data?.authorization_url || !payload.data.access_code) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  return { authorizationUrl: payload.data.authorization_url, accessCode: payload.data.access_code };
}

export interface RefundInput {
  // The Paystack transaction reference (or numeric id) being refunded.
  transaction: string;
  amountMinor: number;
}

export interface RefundResult {
  // Paystack's refund id.
  refundId: string;
  // pending | processing | needs-attention | processed | failed
  status: string;
}

// Starts a refund on Paystack. Paystack reviews and pays it out to the
// customer afterwards; status "pending" on return is normal.
export async function createRefund(secret: string, input: RefundInput, fetchImpl: typeof fetch = fetch): Promise<RefundResult> {
  const res = await fetchImpl(`${BASE_URL}/refund`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: input.transaction, amount: input.amountMinor }),
  });
  const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: { id?: number | string; status?: string } } | null;
  if (!res.ok || !payload?.status || payload.data?.id === undefined || !payload.data.status) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  if (payload.data.status === "failed") {
    throw new PaystackError("Paystack could not process the refund.");
  }
  return { refundId: String(payload.data.id), status: payload.data.status };
}
