// Calls a partner system to prove that the patient controls an identifier.
//
// The partner holds the patient's contact details, so the one-time code goes
// from the partner to the patient. WelliPay never sees the contact. Protocol
// (HTTPS only, Bearer key plus a signed timestamp):
//
//   POST {baseUrl}/wellipay/v1/verifications
//        { requestId, reference }
//        -> 202. The partner sends a one-time code to the patient. It answers the
//           same whether or not the reference exists, so WelliPay cannot be used
//           to test which identifiers exist.
//   POST {baseUrl}/wellipay/v1/verifications/{requestId}/confirm
//        { code }
//        -> 200 { verified: boolean, reference: string }
//
// Headers on both: Authorization: Bearer <apiKey>, X-WelliPay-Timestamp (Unix
// seconds) and X-WelliPay-Signature (sha256=<hex HMAC-SHA256 of
// "<timestamp>.<raw body>" keyed with the same apiKey>).
import { signPayload } from "./webhooks.js";

export interface PartnerConfig {
  baseUrl: string;
  apiKey: string;
}

export class PartnerError extends Error {}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;

const TIMEOUT_MS = 8000;

async function post(cfg: PartnerConfig, path: string, payload: unknown, fetchImpl: FetchLike) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    return await fetchImpl(`${cfg.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
        "x-wellipay-timestamp": String(timestamp),
        "x-wellipay-signature": signPayload(cfg.apiKey, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PartnerError("The partner system could not be reached.");
  }
}

export async function startPartnerVerification(
  cfg: PartnerConfig,
  input: { requestId: string; reference: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<void> {
  const res = await post(cfg, "/wellipay/v1/verifications", input, fetchImpl);
  if (![200, 201, 202, 204].includes(res.status)) throw new PartnerError(`The partner system refused the request (HTTP ${res.status}).`);
}

export async function confirmPartnerVerification(
  cfg: PartnerConfig,
  input: { requestId: string; code: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<{ verified: boolean; reference: string | null }> {
  const res = await post(cfg, `/wellipay/v1/verifications/${encodeURIComponent(input.requestId)}/confirm`, { code: input.code }, fetchImpl);
  // A wrong code, an unknown request or an expired request all mean "not verified".
  if ([400, 404, 410, 422].includes(res.status)) return { verified: false, reference: null };
  if (res.status !== 200) throw new PartnerError(`The partner system could not check the code (HTTP ${res.status}).`);
  const data = (await res.json().catch(() => null)) as { verified?: unknown; reference?: unknown } | null;
  return {
    verified: data?.verified === true,
    reference: typeof data?.reference === "string" ? data.reference : null,
  };
}

// The partner must confirm the same identifier WelliPay asked about.
export function partnerReferenceMatches(sent: string, returned: string | null): boolean {
  return returned !== null && returned.trim().toUpperCase() === sent.trim().toUpperCase();
}
