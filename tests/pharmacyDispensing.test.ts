import { describe, it, expect } from "vitest";
import { verificationProblem, validUntilFrom, prescriptionUsable, refillEligibility } from "../src/lib/prescriptions.js";
import { anyNeedsPharmacist, coverageProblem, paymentGate, handoverProblem } from "../src/lib/dispensing.js";
import { newProofCode, deliveryActionProblem, nextDeliveryStatus, proofProblem, deliveryFeeFromLines } from "../src/lib/delivery.js";
import { patientPrescriptionSchema, verifySchema, createOrderSchema, deliverySchema, pharmacistSchema } from "../src/schemas/pharmacyOrders.js";
import { ROUTE_RULES } from "../src/lib/permissions.js";

const now = new Date("2026-10-14T10:00:00Z");
const base = { decision: "VERIFY" as const, mappedCount: 1, hasControlled: false, validDays: 30, refillsAllowed: 0 };

describe("prescription verification", () => {
  it("accepts a plain verification", () => expect(verificationProblem(base)).toBeNull());
  it("needs a reason to reject", () => {
    expect(verificationProblem({ ...base, decision: "REJECT" })).toMatch(/why/);
    expect(verificationProblem({ ...base, decision: "REJECT", reason: "Illegible" })).toBeNull();
  });
  it("needs at least one matched item", () => expect(verificationProblem({ ...base, mappedCount: 0 })).toMatch(/Match/));
  it("limits validity and refills", () => {
    expect(verificationProblem({ ...base, validDays: 181 })).toMatch(/180/);
    expect(verificationProblem({ ...base, refillsAllowed: 6 })).toMatch(/0 to 5/);
  });
  it("restricts controlled medicines", () => {
    expect(verificationProblem({ ...base, hasControlled: true, validDays: 31 })).toMatch(/30 days/);
    expect(verificationProblem({ ...base, hasControlled: true, refillsAllowed: 1 })).toMatch(/cannot be refilled/);
    expect(verificationProblem({ ...base, hasControlled: true })).toBeNull();
  });
  it("computes validity and usability", () => {
    const until = validUntilFrom(now, 10);
    expect(until.toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(prescriptionUsable({ status: "VERIFIED", validUntil: until }, now)).toBe(true);
    expect(prescriptionUsable({ status: "VERIFIED", validUntil: new Date("2026-10-01") }, now)).toBe(false);
    expect(prescriptionUsable({ status: "SUBMITTED", validUntil: null }, now)).toBe(false);
  });
});

describe("refill eligibility", () => {
  const ok = { rootRefillsAllowed: 2, rootValidUntil: new Date("2026-12-01"), activeRefills: 0, openInChain: false, lastStatus: "COMPLETED" };
  it("allows a refill when supply is complete", () => expect(refillEligibility(ok, now)).toEqual({ ok: true, remaining: 2 }));
  it("blocks while a supply is unfinished", () => expect(refillEligibility({ ...ok, lastStatus: "VERIFIED" }, now).ok).toBe(false));
  it("blocks when one is waiting", () => expect(refillEligibility({ ...ok, openInChain: true }, now).reason).toMatch(/waiting/));
  it("blocks when none are left", () => expect(refillEligibility({ ...ok, activeRefills: 2 }, now).remaining).toBe(0));
  it("blocks after expiry", () => expect(refillEligibility({ ...ok, rootValidUntil: new Date("2026-10-01") }, now).reason).toMatch(/expired/));
});

describe("dispensing rules", () => {
  const lines = [
    { productId: "p1", quantity: 2, name: "Amoxicillin", dispensingClass: "PRESCRIPTION_ONLY" },
    { productId: "p2", quantity: 1, name: "Paracetamol", dispensingClass: "OTC" },
  ];
  it("flags lines that need a pharmacist", () => {
    expect(anyNeedsPharmacist(lines)).toBe(true);
    expect(anyNeedsPharmacist([lines[1]!])).toBe(false);
  });
  it("checks prescription coverage", () => {
    expect(coverageProblem(lines, [{ productId: "p1", quantity: 2 }])).toBeNull();
    expect(coverageProblem(lines, [])).toMatch(/not on the prescription/);
    expect(coverageProblem(lines, [{ productId: "p1", quantity: 1 }])).toMatch(/allows 1/);
    expect(coverageProblem([lines[1]!], [])).toBeNull();
  });
  it("gates on payment", () => {
    expect(paymentGate("PAID", undefined, "CASHIER").ok).toBe(true);
    expect(paymentGate("OPEN", undefined, "ADMIN").ok).toBe(false);
    expect(paymentGate("CANCELLED", "ok then", "ADMIN").ok).toBe(false);
    expect(paymentGate("OPEN", "HMO claim pending", "CASHIER").ok).toBe(false);
    expect(paymentGate("OPEN", "HMO claim pending", "BILLING")).toEqual({ ok: true, overridden: true });
    expect(paymentGate("OPEN", "x", "BILLING").ok).toBe(false);
  });
  it("needs a name for pickups", () => {
    expect(handoverProblem("PICKUP", undefined)).toMatch(/name/);
    expect(handoverProblem("PICKUP", "Ada")).toBeNull();
    expect(handoverProblem("DELIVERY", undefined)).toBeNull();
  });
});

describe("delivery", () => {
  it("makes six-digit codes", () => expect(newProofCode()).toMatch(/^\d{6}$/));
  it("blocks delivery steps before dispensing", () => {
    expect(deliveryActionProblem({ orderStatus: "AWAITING_DISPENSING", fulfilment: "DELIVERY", deliveryStatus: "PENDING" }, "dispatch")).toMatch(/Dispense/);
    expect(deliveryActionProblem({ orderStatus: "DISPENSED", fulfilment: "PICKUP", deliveryStatus: "NOT_APPLICABLE" }, "dispatch")).toMatch(/pickup/);
  });
  it("follows the step order", () => {
    const s = { orderStatus: "DISPENSED", fulfilment: "DELIVERY", deliveryStatus: "PENDING" };
    expect(deliveryActionProblem(s, "dispatch")).toBeNull();
    expect(deliveryActionProblem(s, "deliver")).toMatch(/out for delivery/);
    expect(deliveryActionProblem({ ...s, deliveryStatus: "OUT_FOR_DELIVERY" }, "deliver")).toBeNull();
    expect(deliveryActionProblem({ ...s, deliveryStatus: "FAILED" }, "dispatch")).toBeNull();
    expect(deliveryActionProblem({ ...s, deliveryStatus: "DELIVERED" }, "dispatch")).toMatch(/delivered/);
    expect(nextDeliveryStatus("fail")).toBe("FAILED");
  });
  it("needs proof of handover", () => {
    expect(proofProblem("123456", "123456", "Ada", undefined)).toBeNull();
    expect(proofProblem("123456", "000000", "Ada", undefined)).toMatch(/match/);
    expect(proofProblem("123456", undefined, "Ada", undefined)).toMatch(/code/);
    expect(proofProblem("123456", undefined, "Ada", "Checked ID card")).toBeNull();
    expect(proofProblem("123456", "123456", undefined, undefined)).toMatch(/name/);
  });
  it("derives the fee from delivery lines only", () => {
    expect(deliveryFeeFromLines([{ quantity: 1, unitPriceMinor: 150000, category: "Delivery" }, { quantity: 2, unitPriceMinor: 500, category: null }])).toBe(150000);
  });
});

describe("pharmacy order schemas", () => {
  it("requires at least one item on a prescription", () => {
    expect(patientPrescriptionSchema.safeParse({ prescriberName: "Dr A", items: [] }).success).toBe(false);
    expect(patientPrescriptionSchema.safeParse({ prescriberName: "Dr A", items: [{ description: "Amoxicillin 500mg", quantity: 10 }] }).success).toBe(true);
  });
  it("limits refills in the verify body", () => {
    expect(verifySchema.safeParse({ decision: "VERIFY", refillsAllowed: 9 }).success).toBe(false);
    expect(verifySchema.parse({ decision: "VERIFY" })).toMatchObject({ validDays: 30, refillsAllowed: 0 });
  });
  it("needs an address and phone for delivery", () => {
    expect(createOrderSchema.safeParse({ invoiceId: "i1", fulfilment: "DELIVERY" }).success).toBe(false);
    expect(createOrderSchema.safeParse({ invoiceId: "i1", fulfilment: "DELIVERY", deliveryAddress: "1 Main St", deliveryPhone: "0800" }).success).toBe(true);
    expect(createOrderSchema.parse({ invoiceId: "i1" }).fulfilment).toBe("PICKUP");
  });
  it("checks the proof code format", () => {
    expect(deliverySchema.safeParse({ action: "deliver", proofCode: "12ab" }).success).toBe(false);
    expect(deliverySchema.safeParse({ action: "deliver", proofCode: "123456", recipientName: "Ada" }).success).toBe(true);
  });
  it("allows clearing a licence number", () => expect(pharmacistSchema.safeParse({ licenceNo: null }).success).toBe(true));
});

describe("permissions", () => {
  const rule = (m: string, p: string) => ROUTE_RULES.find((r) => r[0] === m && r[1] === p)?.[2];
  it("lets only admins set pharmacist licences", () => expect(rule("PATCH", "/provider/staff/:id/pharmacist")).toEqual(["ADMIN"]));
  it("keeps viewers from dispensing", () => expect(rule("POST", "/provider/pharmacy/orders/:id/dispense")).not.toContain("VIEWER"));
});
