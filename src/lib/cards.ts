export interface SaveableCard {
  authorizationCode: string;
  signature: string;
  last4: string;
  brand: string | null;
  expMonth: string | null;
  expYear: string | null;
  bank: string | null;
}

// Reads the `authorization` block of a Paystack webhook. Returns null unless
// Paystack says the card can be charged again.
export function parseAuthorization(raw: unknown): SaveableCard | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (a.reusable !== true) return null;
  const authorizationCode = str(a.authorization_code);
  const signature = str(a.signature);
  const last4 = str(a.last4);
  if (!authorizationCode || !signature || !last4 || !/^\d{4}$/.test(last4)) return null;
  return {
    authorizationCode,
    signature,
    last4,
    brand: str(a.brand) ?? str(a.card_type),
    expMonth: str(a.exp_month),
    expYear: str(a.exp_year),
    bank: str(a.bank),
  };
}

// A card past its expiry month cannot be charged.
export function cardExpired(expMonth: string | null, expYear: string | null, now: Date = new Date()): boolean {
  const m = Number(expMonth);
  const y = Number(expYear);
  if (!Number.isInteger(m) || !Number.isInteger(y) || m < 1 || m > 12) return false;
  const lastMonthOfCard = y * 12 + (m - 1);
  const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return current > lastMonthOfCard;
}

export function cardView(row: { id: string; brand: string | null; last4: string; expMonth: string | null; expYear: string | null; bank: string | null; createdAt: Date }, now: Date = new Date()) {
  return {
    methodId: row.id,
    brand: row.brand ?? "card",
    last4: row.last4,
    expMonth: row.expMonth ?? undefined,
    expYear: row.expYear ?? undefined,
    bank: row.bank ?? undefined,
    expired: cardExpired(row.expMonth, row.expYear, now),
    createdAt: row.createdAt.toISOString(),
  };
}
