import { describe, it, expect } from "vitest";
import { staffLoginSchema } from "../src/schemas/staffAuth.js";
import { createStaffSchema, setStaffPasswordSchema } from "../src/schemas/staff.js";
import { createPaymentSchema } from "../src/schemas/payments.js";
import { linkPatientAccountSchema } from "../src/schemas/patientAuth.js";
import { patientAcceptConsentSchema, patientListInvoicesQuerySchema } from "../src/schemas/patientData.js";

describe("staffLoginSchema", () => {
  it("accepts a valid email/password pair", () => {
    const result = staffLoginSchema.safeParse({ email: "a@abchealthcare.ng", password: "anything" });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(staffLoginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("rejects an empty password", () => {
    expect(staffLoginSchema.safeParse({ email: "a@abchealthcare.ng", password: "" }).success).toBe(false);
  });

  it("does not silently accept extra unexpected fields as a role/scope escalation vector", () => {
    // zod's default .object() strips unknown keys rather than rejecting —
    // this test pins that behavior down so a client-sent "scopes" or "role"
    // field can never sneak through to the login route's logic.
    const result = staffLoginSchema.safeParse({
      email: "a@abchealthcare.ng",
      password: "x",
      scopes: ["admin"],
      role: "super-admin",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ email: "a@abchealthcare.ng", password: "x" });
    }
  });
});

describe("setStaffPasswordSchema", () => {
  it("requires at least 8 characters", () => {
    expect(setStaffPasswordSchema.safeParse({ password: "short1" }).success).toBe(false);
    expect(setStaffPasswordSchema.safeParse({ password: "longenough1" }).success).toBe(true);
  });
});

describe("createStaffSchema", () => {
  it("accepts a well-formed invite", () => {
    const result = createStaffSchema.safeParse({
      name: "Samuel Okafor",
      email: "s.okafor@abchealth.ng",
      role: "Front-Desk Cashier",
      branch: "Wuse Branch",
    });
    expect(result.success).toBe(true);
  });

  it("branch is optional", () => {
    expect(
      createStaffSchema.safeParse({ name: "A", email: "a@b.com", role: "Cashier" }).success
    ).toBe(true);
  });

  it("rejects a missing name or role", () => {
    expect(createStaffSchema.safeParse({ email: "a@b.com", role: "Cashier" }).success).toBe(false);
    expect(createStaffSchema.safeParse({ name: "A", email: "a@b.com" }).success).toBe(false);
  });
});

describe("createPaymentSchema", () => {
  it("accepts a well-formed payment", () => {
    const result = createPaymentSchema.safeParse({
      providerPaymentRef: "pay-1",
      invoiceId: "inv_1",
      channel: "card",
      amountMinor: 48150,
      currency: "NGN",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a zero or negative amount — a free or reversed payment isn't valid input here", () => {
    expect(
      createPaymentSchema.safeParse({
        providerPaymentRef: "pay-1",
        invoiceId: "inv_1",
        channel: "card",
        amountMinor: 0,
        currency: "NGN",
      }).success
    ).toBe(false);
  });

  it("rejects a non-integer amount (kobo must be a whole number)", () => {
    expect(
      createPaymentSchema.safeParse({
        providerPaymentRef: "pay-1",
        invoiceId: "inv_1",
        channel: "card",
        amountMinor: 485.5,
        currency: "NGN",
      }).success
    ).toBe(false);
  });

  it("rejects a currency other than NGN", () => {
    expect(
      createPaymentSchema.safeParse({
        providerPaymentRef: "pay-1",
        invoiceId: "inv_1",
        channel: "card",
        amountMinor: 1000,
        currency: "USD",
      }).success
    ).toBe(false);
  });

  it("rejects an unknown payment channel", () => {
    expect(
      createPaymentSchema.safeParse({
        providerPaymentRef: "pay-1",
        invoiceId: "inv_1",
        channel: "bitcoin",
        amountMinor: 1000,
        currency: "NGN",
      }).success
    ).toBe(false);
  });
});

describe("linkPatientAccountSchema", () => {
  it("accepts a well-formed invoiceRef/amountMinor pair", () => {
    const result = linkPatientAccountSchema.safeParse({ invoiceRef: "INV-2026-0042", amountMinor: 48150 });
    expect(result.success).toBe(true);
  });

  it("rejects an empty invoiceRef", () => {
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "", amountMinor: 48150 }).success).toBe(false);
  });

  it("rejects an invoiceRef longer than 80 characters", () => {
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "x".repeat(81), amountMinor: 48150 }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "INV-1", amountMinor: -1 }).success).toBe(false);
  });

  it("accepts a zero amount — a fully-covered/no-balance invoice is still linkable", () => {
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "INV-1", amountMinor: 0 }).success).toBe(true);
  });

  it("rejects a non-integer amount", () => {
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "INV-1", amountMinor: 48150.5 }).success).toBe(false);
  });

  it("rejects a missing invoiceRef or amountMinor", () => {
    expect(linkPatientAccountSchema.safeParse({ amountMinor: 48150 }).success).toBe(false);
    expect(linkPatientAccountSchema.safeParse({ invoiceRef: "INV-1" }).success).toBe(false);
  });
});

describe("patientListInvoicesQuerySchema", () => {
  it("defaults limit to 50 with no query params", () => {
    const result = patientListInvoicesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it("rejects a status outside the known invoice statuses", () => {
    expect(patientListInvoicesQuerySchema.safeParse({ status: "REFUNDED" }).success).toBe(false);
  });

  it("has no facilityRef field to filter by — a patient token is already scoped to one patientRef", () => {
    const result = patientListInvoicesQuerySchema.safeParse({ facilityRef: "fac_1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("facilityRef");
  });
});

describe("patientAcceptConsentSchema", () => {
  const validBody = {
    providerConsentRef: "consent-1",
    invoiceId: "inv_1",
    estimateRevision: "rev-1",
    policyVersion: "policy-1",
    payerSplit: [{ payerType: "PATIENT", amountMinor: 48150, currency: "NGN" }],
  };

  it("accepts a well-formed acceptance", () => {
    expect(patientAcceptConsentSchema.safeParse(validBody).success).toBe(true);
  });

  it("has no facilityRef or patientRef fields — those come from the invoice and the token, never the body", () => {
    const result = patientAcceptConsentSchema.safeParse({ ...validBody, facilityRef: "fac_1", patientRef: "pat_1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("facilityRef");
      expect(result.data).not.toHaveProperty("patientRef");
    }
  });

  it("rejects an unknown payerType", () => {
    expect(
      patientAcceptConsentSchema.safeParse({ ...validBody, payerSplit: [{ payerType: "CRYPTO", amountMinor: 100, currency: "NGN" }] }).success
    ).toBe(false);
  });

  it("rejects an empty payerSplit array", () => {
    expect(patientAcceptConsentSchema.safeParse({ ...validBody, payerSplit: [] }).success).toBe(false);
  });
});
