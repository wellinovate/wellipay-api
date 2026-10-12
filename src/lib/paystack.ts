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

export interface PaystackSettlement {
  id: string;
  status: string;
  // What Paystack collected, the fees it kept, and what it paid out. All kobo.
  totalAmountMinor: number;
  totalFeesMinor: number;
  payoutAmountMinor: number;
  settlementDate: string | null;
}

// Lists payouts Paystack has made (or is making) to the business bank
// account. Read-only. `from` and `to` are YYYY-MM-DD.
export async function listSettlements(
  secret: string,
  range: { from?: string | undefined; to?: string | undefined },
  fetchImpl: typeof fetch = fetch
): Promise<PaystackSettlement[]> {
  const qs = new URLSearchParams({ perPage: "100" });
  if (range.from) qs.set("from", range.from);
  if (range.to) qs.set("to", range.to);
  const res = await fetchImpl(`${BASE_URL}/settlement?${qs.toString()}`, { headers: { Authorization: `Bearer ${secret}` } });
  const payload = (await res.json().catch(() => null)) as
    | { status?: boolean; message?: string; data?: Array<{ id?: number | string; status?: string; total_amount?: number; total_fees?: number; effective_amount?: number; settled_by?: string | null; settlement_date?: string | null; createdAt?: string }> }
    | null;
  if (!res.ok || !payload?.status || !Array.isArray(payload.data)) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  return payload.data.map((s) => ({
    id: String(s.id),
    status: s.status ?? "unknown",
    totalAmountMinor: Number(s.total_amount ?? 0),
    totalFeesMinor: Number(s.total_fees ?? 0),
    payoutAmountMinor: Number(s.effective_amount ?? 0),
    settlementDate: s.settlement_date ?? s.createdAt ?? null,
  }));
}
