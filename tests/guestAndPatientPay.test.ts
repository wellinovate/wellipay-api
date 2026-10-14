import { describe, it, expect } from "vitest";
import { newPayToken, newClaimCode, normalizeClaimCode, resolveChargeAmount, refundSummary } from "../src/lib/payLinks.js";
import { transactionView } from "../src/lib/transactions.js";

describe("pay tokens and claim codes", () => {
  it("makes long, different tokens", () => {
    const a = newPayToken();
    expect(a.length).toBeGreaterThanOrEqual(21);
    expect(newPayToken()).not.toBe(a);
  });
  it("makes 10-character claim codes without look-alike characters", () => {
    for (let i = 0; i < 50; i++) expect(newClaimCode()).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
  });
  it("normalises a typed code", () => expect(normalizeClaimCode(" ab-cd 23 ")).toBe("ABCD23"));
});

describe("resolveChargeAmount", () => {
  it("defaults to the whole balance", () => expect(resolveChargeAmount(500000n)).toEqual({ amount: 500000n }));
  it("allows a part payment", () => expect(resolveChargeAmount(500000n, 100000n)).toEqual({ amount: 100000n }));
  it("rejects more than the balance", () => expect(resolveChargeAmount(500000n, 500001n)).toHaveProperty("error"));
  it("rejects under 100 kobo", () => expect(resolveChargeAmount(500000n, 99n)).toHaveProperty("error"));
  it("rejects a paid bill", () => expect(resolveChargeAmount(0n)).toHaveProperty("error"));
});

describe("refundSummary", () => {
  it("is NONE with no refunds", () => expect(refundSummary([])).toEqual({ refundStatus: "NONE", refundedMinor: 0n }));
  it("is PENDING while waiting", () => expect(refundSummary([{ status: "PENDING", amountMinor: 100n }]).refundStatus).toBe("PENDING"));
  it("is REFUNDED with an approved refund", () => expect(refundSummary([{ status: "APPROVED", amountMinor: 300n }, { status: "REJECTED", amountMinor: 50n }])).toEqual({ refundStatus: "REFUNDED", refundedMinor: 300n }));
  it("ignores rejected refunds", () => expect(refundSummary([{ status: "REJECTED", amountMinor: 50n }]).refundStatus).toBe("NONE"));
});

describe("transactionView", () => {
  const charge = { id: "c1", invoiceId: "i1", reference: "wp_abc", amountMinor: 250000n, status: "SUCCESS", source: "GUEST", payerPatientRef: "P-1", failureReason: null, paymentId: "p1", createdAt: new Date("2026-10-14T10:00:00Z") };
  const inv = { providerInvoiceRef: "INV-1", description: "Malaria test", patientRef: "P-1", providerName: "Lab One" };
  it("shows a paid transaction with its processor", () => {
    const v = transactionView(charge, inv, new Date("2026-10-14T10:01:00Z"), [], "P-1");
    expect(v).toMatchObject({ processor: "paystack", status: "SUCCESS", amountMinor: 250000, paidByMe: true, refundStatus: "NONE", providerName: "Lab One" });
    expect(v.paidAt).toBe("2026-10-14T10:01:00.000Z");
  });
  it("marks someone else's payment", () => {
    expect(transactionView({ ...charge, payerPatientRef: null }, inv, null, [], "P-1").paidByMe).toBe(false);
  });
  it("shows a refund", () => {
    const v = transactionView(charge, inv, null, [{ status: "APPROVED", amountMinor: 100000n }], "P-1");
    expect(v.refundStatus).toBe("REFUNDED");
    expect(v.refundedMinor).toBe(100000);
  });
  it("leaves lines out when there are none", () => expect(transactionView(charge, inv, null, [], "P-1").lines).toBeUndefined());
});
