import { randomBytes, randomInt } from "node:crypto";

export function newPayToken(): string {
  return randomBytes(16).toString("base64url");
}

// No 0, O, 1, I or L, so a code read aloud or copied by hand survives.
const CLAIM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newClaimCode(): string {
  let out = "";
  for (let i = 0; i < 10; i++) out += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  return out;
}

export function normalizeClaimCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export const MIN_CHARGE_MINOR = 100n;

// The amount to charge: the whole balance unless a smaller part was asked for.
export function resolveChargeAmount(outstanding: bigint, requested?: bigint): { amount: bigint } | { error: string } {
  const amount = requested ?? outstanding;
  if (outstanding <= 0n) return { error: "This bill has nothing left to pay." };
  if (amount < MIN_CHARGE_MINOR) return { error: "The smallest online payment is 100 kobo." };
  if (amount > outstanding) return { error: `The amount is more than the balance (${outstanding.toString()} kobo).` };
  return { amount };
}

export interface RefundLike {
  status: string;
  amountMinor: bigint;
}

// NONE, PENDING (a refund is waiting for a decision) or REFUNDED (some money went back).
export function refundSummary(refunds: RefundLike[]): { refundStatus: "NONE" | "PENDING" | "REFUNDED"; refundedMinor: bigint } {
  const refunded = refunds.filter((r) => r.status === "APPROVED").reduce((sum, r) => sum + r.amountMinor, 0n);
  if (refunded > 0n) return { refundStatus: "REFUNDED", refundedMinor: refunded };
  if (refunds.some((r) => r.status === "PENDING")) return { refundStatus: "PENDING", refundedMinor: 0n };
  return { refundStatus: "NONE", refundedMinor: 0n };
}
