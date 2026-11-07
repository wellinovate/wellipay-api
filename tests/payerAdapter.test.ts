import { describe, it, expect, beforeEach } from "vitest";
import { payerAdapterFor, registerPayerAdapter, clearPayerAdapters, simulatedEligibility, simulatedPreAuth, MANUAL_VERIFICATION_REASON } from "../src/lib/payerAdapter.js";
import { launchWarnings } from "../src/lib/launchChecks.js";

describe("payer adapters", () => {
  beforeEach(() => clearPayerAdapters());

  it("has no adapter registered by default, so nothing answers for a payer", () => {
    expect(payerAdapterFor("Reliance HMO")).toBeUndefined();
    expect(MANUAL_VERIFICATION_REASON).toBe("manual_verification_required");
  });

  it("finds a registered adapter regardless of case and spacing", async () => {
    registerPayerAdapter("Reliance HMO", {
      checkEligibility: async () => ({ decision: "ELIGIBLE", coveredAmountMinor: null, patientResponsibilityMinor: null, validUntil: new Date(0) }),
    });
    const a = payerAdapterFor("  reliance hmo ");
    expect(a).toBeDefined();
    expect((await a!.checkEligibility({ payerRef: "x", patientRef: "p", serviceCodes: ["a"], amountMinor: null })).decision).toBe("ELIGIBLE");
  });
});

describe("development stand-ins", () => {
  it("splits 80/20 for eligibility and passes through when there is no amount", () => {
    const r = simulatedEligibility(100_000n);
    expect(r.decision).toBe("PARTIALLY_ELIGIBLE");
    expect(r.coveredAmountMinor).toBe(80_000n);
    expect(r.patientResponsibilityMinor).toBe(20_000n);
    expect(simulatedEligibility(null).decision).toBe("ELIGIBLE");
  });
  it("splits a pre-authorization by the co-pay and issues a code", () => {
    const r = simulatedPreAuth(100_000n, 10);
    expect(r.patientPortionMinor).toBe(10_000n);
    expect(r.coveredAmountMinor).toBe(90_000n);
    expect(r.approvalCode).toMatch(/^AUTH-\d{4}$/);
  });
});

describe("launch warning for the stand-in", () => {
  const live = { NODE_ENV: "production", CORS_ORIGIN: "https://app.wellipay.net", CLERK_SECRET_KEY: "sk_live_x", PAYSTACK_SECRET_KEY: "sk_live_y", ALLOW_PUBLIC_FRONTEND_TOKEN: "false" };
  it("warns in production when simulation is on, and is quiet when off or in development", () => {
    expect(launchWarnings({ ...live, ALLOW_SIMULATED_HMO: "false" })).toEqual([]);
    expect(launchWarnings({ ...live, ALLOW_SIMULATED_HMO: "true" }).join(" ")).toContain("ALLOW_SIMULATED_HMO");
    expect(launchWarnings({ ...live, NODE_ENV: "development", ALLOW_SIMULATED_HMO: "true" })).toEqual([]);
  });
});
