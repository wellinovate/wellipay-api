import { describe, it, expect } from "vitest";
import { refundIsRecoverable } from "../src/lib/recovery.js";

describe("refundIsRecoverable", () => {
  it("is true for a Paystack payment of a provider with a subaccount", () => {
    expect(refundIsRecoverable("paystack_wp_abc", "ACCT_123")).toBe(true);
  });
  it("is false when the provider has no subaccount", () => {
    expect(refundIsRecoverable("paystack_wp_abc", null)).toBe(false);
    expect(refundIsRecoverable("paystack_wp_abc", undefined)).toBe(false);
  });
  it("is false for a payment that did not go through Paystack", () => {
    expect(refundIsRecoverable("cash-123", "ACCT_123")).toBe(false);
  });
});
