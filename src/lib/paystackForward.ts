// The Paystack account has one webhook URL, and it points at this service.
// The WelliRecord mobile backend also takes payments (consultation bookings
// with references "wr-...", pharmacy orders with "wo-...") on the same account.
// This hands those events on, unchanged, so the mobile backend can check the
// signature itself and confirm the payment at once.

const FORWARD_PREFIXES = ["wr-", "wo-"];

export function isForwardedReference(reference: string | undefined): boolean {
  return typeof reference === "string" && FORWARD_PREFIXES.some((p) => reference.startsWith(p));
}

/** True when the receiver answered 2xx. Never throws. */
export async function forwardPaystackEvent(
  url: string,
  rawBody: string,
  signature: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paystack-signature": signature },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
