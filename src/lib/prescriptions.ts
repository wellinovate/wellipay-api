export const RX_DEFAULT_DAYS = 30;
export const RX_MAX_DAYS = 180;
export const CONTROLLED_MAX_DAYS = 30;
export const MAX_REFILLS = 5;

export interface VerificationInput {
  decision: "VERIFY" | "REJECT";
  reason?: string | undefined;
  // How many prescription items the pharmacist matched to a product.
  mappedCount: number;
  hasControlled: boolean;
  validDays: number;
  refillsAllowed: number;
}

// Why a verification decision cannot be recorded, or null.
export function verificationProblem(v: VerificationInput): string | null {
  if (v.decision === "REJECT") {
    return v.reason && v.reason.trim().length >= 3 ? null : "Say why the prescription is rejected.";
  }
  if (v.mappedCount < 1) return "Match at least one item to a product in stock before verifying.";
  if (!Number.isInteger(v.validDays) || v.validDays < 1 || v.validDays > RX_MAX_DAYS) return `Validity must be 1 to ${RX_MAX_DAYS} days.`;
  if (!Number.isInteger(v.refillsAllowed) || v.refillsAllowed < 0 || v.refillsAllowed > MAX_REFILLS) return `Refills must be 0 to ${MAX_REFILLS}.`;
  if (v.hasControlled) {
    if (v.validDays > CONTROLLED_MAX_DAYS) return `A controlled medicine is valid for at most ${CONTROLLED_MAX_DAYS} days.`;
    if (v.refillsAllowed > 0) return "A controlled medicine cannot be refilled. A new prescription is needed.";
  }
  return null;
}

export function validUntilFrom(verifiedAt: Date, days: number): Date {
  return new Date(verifiedAt.getTime() + days * 86_400_000);
}

export interface RxLike {
  status: string;
  validUntil: Date | null;
}

// A verified prescription inside its validity can be dispensed against.
export function prescriptionUsable(rx: RxLike, now: Date = new Date()): boolean {
  return rx.status === "VERIFIED" && (!rx.validUntil || rx.validUntil.getTime() >= now.getTime());
}

export interface RefillCheck {
  rootRefillsAllowed: number;
  rootValidUntil: Date | null;
  // Refill requests on this chain that were not rejected or cancelled.
  activeRefills: number;
  // A refill on this chain is still waiting or verified but not dispensed.
  openInChain: boolean;
  lastStatus: string;
}

// Whether a patient can ask for another refill, and how many are left.
export function refillEligibility(c: RefillCheck, now: Date = new Date()): { ok: boolean; remaining: number; reason?: string } {
  const remaining = Math.max(0, c.rootRefillsAllowed - c.activeRefills);
  if (c.lastStatus !== "COMPLETED") return { ok: false, remaining, reason: "The last supply is not finished yet." };
  if (c.openInChain) return { ok: false, remaining, reason: "A refill is already waiting." };
  if (remaining <= 0) return { ok: false, remaining: 0, reason: "No refills are left. Ask your prescriber for a new prescription." };
  if (c.rootValidUntil && c.rootValidUntil.getTime() < now.getTime()) return { ok: false, remaining, reason: "This prescription has expired." };
  return { ok: true, remaining };
}
