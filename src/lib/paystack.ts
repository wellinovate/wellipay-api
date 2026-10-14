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
  // Provider's Paystack subaccount (ACCT_...). When set the payment settles to
  // that provider, and the provider bears Paystack's fee.
  subaccount?: string | null | undefined;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
}

export class PaystackError extends Error {}
// Paystack answered and said no. Nothing was charged.
export class PaystackDeclined extends PaystackError {}

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
      ...(input.subaccount ? { subaccount: input.subaccount, bearer: "subaccount" } : {}),
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

export interface GatewayRefund {
  refundId: string;
  status: string;
  amountMinor: number;
}

// Refunds Paystack holds for one transaction. Read-only.
export async function listRefundsForTransaction(secret: string, transaction: string, fetchImpl: typeof fetch = fetch): Promise<GatewayRefund[]> {
  const rows = await paystackGet<Array<{ id?: number | string; status?: string; amount?: number }>>(
    secret,
    `/refund?${new URLSearchParams({ reference: transaction, perPage: "50" }).toString()}`,
    fetchImpl
  );
  if (!Array.isArray(rows)) throw new PaystackError("Paystack returned an unexpected refund list.");
  return rows
    .filter((r) => r.id !== undefined && r.status)
    .map((r) => ({ refundId: String(r.id), status: String(r.status), amountMinor: Number(r.amount ?? 0) }));
}

// The refund we started, found by the id Paystack gave us when we created it.
export function findGatewayRefund(items: GatewayRefund[], refundId: string): GatewayRefund | undefined {
  return items.find((r) => r.refundId === refundId);
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
  range: { from?: string | undefined; to?: string | undefined; subaccount?: string | null | undefined },
  fetchImpl: typeof fetch = fetch
): Promise<PaystackSettlement[]> {
  const qs = new URLSearchParams({ perPage: "100" });
  if (range.from) qs.set("from", range.from);
  if (range.to) qs.set("to", range.to);
  if (range.subaccount) qs.set("subaccount", range.subaccount);
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

export interface SettlementTransaction {
  reference: string;
  id: string | null;
}

// The transactions inside one payout. Read-only. `page` starts at 1.
export async function listSettlementTransactions(
  secret: string,
  settlementId: string,
  page: number,
  fetchImpl: typeof fetch = fetch
): Promise<{ items: SettlementTransaction[]; hasMore: boolean }> {
  const perPage = 100;
  const rows = await paystackGet<Array<{ reference?: string; id?: number | string }>>(
    secret,
    `/settlement/${encodeURIComponent(settlementId)}/transactions?${new URLSearchParams({ perPage: String(perPage), page: String(page) }).toString()}`,
    fetchImpl
  );
  if (!Array.isArray(rows)) throw new PaystackError("Paystack returned an unexpected transaction list.");
  return {
    items: rows.filter((r) => r.reference).map((r) => ({ reference: String(r.reference), id: r.id !== undefined ? String(r.id) : null })),
    hasMore: rows.length >= perPage,
  };
}

export interface ChargeAuthorizationInput {
  email: string;
  amountMinor: number;
  authorizationCode: string;
  reference: string;
  metadata?: Record<string, unknown>;
  subaccount?: string | null | undefined;
}

// Charges a card the patient saved earlier. Paystack answers at once, but the
// result is only trusted when the signed webhook arrives, as with any charge.
export async function chargeAuthorization(secret: string, input: ChargeAuthorizationInput, fetchImpl: typeof fetch = fetch): Promise<{ status: string }> {
  const res = await fetchImpl(`${BASE_URL}/transaction/charge_authorization`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      amount: input.amountMinor,
      currency: "NGN",
      authorization_code: input.authorizationCode,
      reference: input.reference,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.subaccount ? { subaccount: input.subaccount, bearer: "subaccount" } : {}),
    }),
  });
  const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: { status?: string; gateway_response?: string } } | null;
  if (!res.ok || !payload?.status || !payload.data?.status) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  if (payload.data.status === "failed") throw new PaystackDeclined(payload.data.gateway_response ?? "The card was declined.");
  return { status: payload.data.status };
}

async function paystackGet<T>(secret: string, path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${secret}` } });
  const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || !payload?.status || payload.data === undefined) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  return payload.data;
}

export interface Bank {
  name: string;
  code: string;
}

// Nigerian banks Paystack can pay out to.
export async function listBanks(secret: string, fetchImpl: typeof fetch = fetch): Promise<Bank[]> {
  const rows = await paystackGet<Array<{ name?: string; code?: string }>>(secret, "/bank?country=nigeria&currency=NGN&perPage=200", fetchImpl);
  return rows.filter((b) => b.name && b.code).map((b) => ({ name: b.name!, code: b.code! }));
}

// Asks the bank who owns an account number. Throws if the number is not valid
// for that bank.
export async function resolveAccount(
  secret: string,
  input: { accountNumber: string; bankCode: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ accountName: string }> {
  const qs = new URLSearchParams({ account_number: input.accountNumber, bank_code: input.bankCode });
  const data = await paystackGet<{ account_name?: string }>(secret, `/bank/resolve?${qs.toString()}`, fetchImpl);
  if (!data.account_name) throw new PaystackError("The bank did not return an account name.");
  return { accountName: data.account_name };
}

export interface SubaccountInput {
  businessName: string;
  bankCode: string;
  accountNumber: string;
  // Share of each payment that stays with the platform, 0 to 100.
  platformPercent: number;
}

// Creates the Paystack subaccount that a provider's payments settle into.
export async function createSubaccount(secret: string, input: SubaccountInput, fetchImpl: typeof fetch = fetch): Promise<{ subaccountCode: string }> {
  const res = await fetchImpl(`${BASE_URL}/subaccount`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      business_name: input.businessName,
      bank_code: input.bankCode,
      account_number: input.accountNumber,
      percentage_charge: input.platformPercent,
    }),
  });
  const payload = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: { subaccount_code?: string } } | null;
  if (!res.ok || !payload?.status || !payload.data?.subaccount_code) {
    throw new PaystackError(payload?.message ?? `Paystack returned HTTP ${res.status}`);
  }
  return { subaccountCode: payload.data.subaccount_code };
}
