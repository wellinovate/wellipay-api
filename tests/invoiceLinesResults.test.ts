import { describe, it, expect } from "vitest";
import { linesProblem, linesTotal } from "../src/lib/invoiceLines.js";
import { paymentProblem } from "../src/lib/paymentLimit.js";
import { pendingResults, canEnterResults } from "../src/lib/results.js";
import { createInvoiceSchema } from "../src/schemas/invoices.js";
import { addResultsSchema, updateResultSchema } from "../src/schemas/results.js";

describe("invoice lines", () => {
  const lines = [{ quantity: 1, unitPriceMinor: 450000 }, { quantity: 2, unitPriceMinor: 150000 }];
  it("adds quantity times price", () => expect(linesTotal(lines)).toBe(750000));
  it("accepts matching total", () => expect(linesProblem(lines, 750000)).toBeNull());
  it("rejects a wrong total", () => expect(linesProblem(lines, 700000)).not.toBeNull());
  const base = { providerInvoiceRef: "INV-1", facilityRef: "f", patientRef: "P-1", description: "Tests", amountMinor: 750000, currency: "NGN" as const };
  it("accepts an invoice with lines", () => {
    expect(createInvoiceSchema.safeParse({ ...base, lines: [{ description: "FBC", unitPriceMinor: 750000 }] }).success).toBe(true);
  });
  it("defaults quantity to 1", () => {
    const r = createInvoiceSchema.parse({ ...base, lines: [{ description: "FBC", unitPriceMinor: 750000 }] });
    expect(r.lines?.[0]?.quantity).toBe(1);
  });
  it("rejects an empty lines list", () => expect(createInvoiceSchema.safeParse({ ...base, lines: [] }).success).toBe(false));
  it("still accepts an invoice with no lines", () => expect(createInvoiceSchema.safeParse(base).success).toBe(true));
});

describe("paymentProblem", () => {
  it("allows the exact balance", () => expect(paymentProblem(500n, 1000n, 500n, "PARTIALLY_PAID")).toBeNull());
  it("allows less than the balance", () => expect(paymentProblem(100n, 1000n, 0n, "OPEN")).toBeNull());
  it("rejects more than the balance", () => expect(paymentProblem(501n, 1000n, 500n, "PARTIALLY_PAID")).not.toBeNull());
  it("rejects a paid invoice", () => expect(paymentProblem(1n, 1000n, 1000n, "PAID")).not.toBeNull());
  it("rejects a cancelled invoice", () => expect(paymentProblem(1n, 1000n, 0n, "CANCELLED")).not.toBeNull());
});

describe("results", () => {
  it("counts results not ready", () => expect(pendingResults([{ status: "READY" }, { status: "PENDING" }])).toBe(1));
  it("counts none when all are ready", () => expect(pendingResults([{ status: "READY" }])).toBe(0));
  it("blocks entry before collection", () => expect(canEnterResults("BOOKED")).toBe(false));
  it("allows entry after collection", () => expect(canEnterResults("SAMPLE_COLLECTED")).toBe(true));
  it("blocks entry on a cancelled booking", () => expect(canEnterResults("CANCELLED")).toBe(false));
  it("needs at least one test", () => expect(addResultsSchema.safeParse({ tests: [] }).success).toBe(false));
  it("rejects an empty change", () => expect(updateResultSchema.safeParse({}).success).toBe(false));
  it("accepts a result with a flag", () => expect(updateResultSchema.safeParse({ resultText: "Hb 13.2 g/dL", abnormal: false, status: "READY" }).success).toBe(true));
});
