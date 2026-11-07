// HMO / payer decisions.
//
// No payer integration exists yet. Until one does, WelliPay must not invent a
// coverage decision: a patient could be told an HMO covers 80% when nobody has
// asked the HMO. So by default an eligibility check or pre-authorization with
// no adapter for its payer is recorded as pending and left for the HMO or the
// provider's staff to decide.
//
// To connect a real payer, write an adapter and register it in `adapters`
// under the payer's reference (the `payerRef` on an eligibility check, the
// policy's provider name on a pre-authorization). Nothing else changes.
//
// ALLOW_SIMULATED_HMO=true restores the old 80/20 stand-in for local
// development only. launchWarnings flags it when set in production.

export type EligibilityInput = {
  payerRef: string;
  patientRef: string;
  serviceCodes: string[];
  amountMinor: bigint | null;
};

export type EligibilityResult = {
  decision: "ELIGIBLE" | "PARTIALLY_ELIGIBLE" | "INELIGIBLE";
  coveredAmountMinor: bigint | null;
  patientResponsibilityMinor: bigint | null;
  reasonCode?: string;
  validUntil: Date;
};

export interface PayerAdapter {
  checkEligibility(input: EligibilityInput): Promise<EligibilityResult>;
}

/** Registered payer integrations, keyed by lower-case payer reference. Empty until a partner API is wired up. */
const adapters = new Map<string, PayerAdapter>();

export function registerPayerAdapter(payerRef: string, adapter: PayerAdapter): void {
  adapters.set(payerRef.trim().toLowerCase(), adapter);
}

export function clearPayerAdapters(): void {
  adapters.clear();
}

export function payerAdapterFor(payerRef: string): PayerAdapter | undefined {
  return adapters.get(payerRef.trim().toLowerCase());
}

export const MANUAL_VERIFICATION_REASON = "manual_verification_required";

/** The old stand-in: 80% covered by the payer, 20% by the patient, valid 30 days. Development only. */
export function simulatedEligibility(amountMinor: bigint | null): EligibilityResult {
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (amountMinor == null) {
    return { decision: "ELIGIBLE", coveredAmountMinor: null, patientResponsibilityMinor: null, validUntil };
  }
  const coveredAmountMinor = (amountMinor * 80n) / 100n;
  return { decision: "PARTIALLY_ELIGIBLE", coveredAmountMinor, patientResponsibilityMinor: amountMinor - coveredAmountMinor, validUntil };
}

/** The old pre-authorization stand-in: split the estimate by the policy's co-pay and issue a made-up code. Development only. */
export function simulatedPreAuth(estimatedCostMinor: bigint, coPayPercent: number) {
  const patientPortionMinor = (estimatedCostMinor * BigInt(coPayPercent)) / 100n;
  const coveredAmountMinor = estimatedCostMinor - patientPortionMinor;
  const approvalCode = `AUTH-${Math.floor(1000 + Math.random() * 9000)}`;
  return { patientPortionMinor, coveredAmountMinor, approvalCode };
}
