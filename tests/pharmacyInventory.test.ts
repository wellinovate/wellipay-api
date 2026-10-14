import { describe, it, expect } from "vitest";
import { expiryState, daysToExpiry, isUsable, onHand, allocateFefo, stockLevel, adjustmentProblem, receiptProblem } from "../src/lib/pharmacyStock.js";
import { productProblem, productDisplayName, newSku, needsPharmacist } from "../src/lib/pharmacyProducts.js";
import { PHARMACY_SERVICES, findPharmacyService } from "../src/data/pharmacyServices.js";
import { createProductSchema, receiptSchema, adjustmentSchema } from "../src/schemas/pharmacy.js";

const today = new Date("2026-10-14T10:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const batch = (id: string, expiry: string | null, qty: number, status = "ACTIVE", received = "2026-01-01") => ({
  id,
  expiryDate: expiry ? d(expiry) : null,
  quantityOnHand: qty,
  status,
  receivedAt: d(received),
});

describe("expiry", () => {
  it("is usable through the expiry day", () => expect(expiryState(d("2026-10-14"), today)).toBe("NEAR"));
  it("expires the day after", () => expect(expiryState(d("2026-10-13"), today)).toBe("EXPIRED"));
  it("flags stock within 90 days", () => expect(expiryState(d("2027-01-10"), today)).toBe("NEAR"));
  it("is fine beyond 90 days", () => expect(expiryState(d("2027-03-01"), today)).toBe("OK"));
  it("handles no expiry date", () => expect(expiryState(null, today)).toBe("NO_EXPIRY"));
  it("counts days", () => {
    expect(daysToExpiry(d("2026-10-24"), today)).toBe(10);
    expect(daysToExpiry(null, today)).toBeNull();
  });
});

describe("usable stock", () => {
  it("excludes expired, quarantined and empty batches", () => {
    expect(isUsable(batch("a", "2026-10-01", 5), today)).toBe(false);
    expect(isUsable(batch("b", "2027-05-01", 5, "QUARANTINED"), today)).toBe(false);
    expect(isUsable(batch("c", "2027-05-01", 0), today)).toBe(false);
    expect(isUsable(batch("d", "2027-05-01", 5), today)).toBe(true);
  });
  it("counts only usable stock", () => {
    expect(onHand([batch("a", "2026-10-01", 50), batch("b", "2027-05-01", 7), batch("c", null, 3)], today)).toBe(10);
  });
});

describe("first expiry, first out", () => {
  it("takes the soonest expiry first", () => {
    const r = allocateFefo([batch("late", "2027-12-01", 10), batch("soon", "2027-01-01", 4)], 6, today);
    expect(r).toEqual({ allocations: [{ batchId: "soon", quantity: 4 }, { batchId: "late", quantity: 2 }], shortfall: 0 });
  });
  it("skips expired and quarantined batches", () => {
    const r = allocateFefo([batch("old", "2026-09-01", 100), batch("hold", "2027-01-01", 100, "QUARANTINED"), batch("ok", "2027-06-01", 3)], 5, today);
    expect(r).toEqual({ allocations: [{ batchId: "ok", quantity: 3 }], shortfall: 2 });
  });
  it("puts undated batches last", () => {
    const r = allocateFefo([batch("none", null, 5), batch("dated", "2027-06-01", 5)], 7, today);
    expect(r.allocations.map((a) => a.batchId)).toEqual(["dated", "none"]);
  });
  it("breaks ties by the older receipt", () => {
    const r = allocateFefo([batch("new", "2027-06-01", 5, "ACTIVE", "2026-09-01"), batch("old", "2027-06-01", 5, "ACTIVE", "2026-03-01")], 3, today);
    expect(r.allocations[0]!.batchId).toBe("old");
  });
  it("reports a shortfall", () => expect(allocateFefo([batch("a", "2027-06-01", 2)], 5, today).shortfall).toBe(3));
});

describe("stock level", () => {
  it("is OUT at zero", () => expect(stockLevel(0, 10)).toBe("OUT"));
  it("is LOW at or under the reorder level", () => {
    expect(stockLevel(10, 10)).toBe("LOW");
    expect(stockLevel(11, 10)).toBe("OK");
  });
  it("never flags LOW with no reorder level", () => expect(stockLevel(1, 0)).toBe("OK"));
});

describe("adjustments", () => {
  it("rejects zero", () => expect(adjustmentProblem(5, 0, "LOST", undefined)).toMatch(/not zero/));
  it("blocks going below zero", () => expect(adjustmentProblem(5, -6, "LOST", undefined)).toMatch(/below zero/));
  it("needs a note for OTHER", () => expect(adjustmentProblem(5, -1, "OTHER", undefined)).toMatch(/why/));
  it("rejects damaged stock that adds", () => expect(adjustmentProblem(5, 2, "DAMAGED", undefined)).toMatch(/cannot add/));
  it("rejects found stock that removes", () => expect(adjustmentProblem(5, -2, "FOUND", undefined)).toMatch(/adds/));
  it("allows a count correction either way", () => {
    expect(adjustmentProblem(5, -2, "COUNT_CORRECTION", undefined)).toBeNull();
    expect(adjustmentProblem(5, 2, "COUNT_CORRECTION", undefined)).toBeNull();
  });
});

describe("receipts", () => {
  it("needs an expiry date for a medicine", () => expect(receiptProblem("MEDICINE", null, 10, today)).toMatch(/expiry/));
  it("does not need one for a device", () => expect(receiptProblem("DEVICE", null, 1, today)).toBeNull());
  it("refuses expired stock", () => expect(receiptProblem("MEDICINE", d("2026-01-01"), 10, today)).toMatch(/expired/));
  it("refuses zero quantity", () => expect(receiptProblem("MEDICINE", d("2027-01-01"), 0, today)).toMatch(/at least 1/));
});

describe("products", () => {
  const med = { category: "MEDICINE", genericName: "Paracetamol", brandName: "Panadol", strength: "500 mg", dosageForm: "tablet", packSize: "10 tablets", dispensingClass: "OTC" };
  it("accepts a complete medicine", () => expect(productProblem(med)).toBeNull());
  it("needs strength, form and pack size for a medicine", () => {
    expect(productProblem({ ...med, strength: undefined })).toMatch(/strength/);
    expect(productProblem({ ...med, dosageForm: " " })).toMatch(/dosage form/);
    expect(productProblem({ ...med, packSize: null })).toMatch(/pack size/);
  });
  it("keeps prescription classes to medicines", () => {
    expect(productProblem({ category: "DEVICE", genericName: "Thermometer", dispensingClass: "PRESCRIPTION_ONLY" })).toMatch(/Only a medicine/);
    expect(productProblem({ category: "DEVICE", genericName: "Thermometer", dispensingClass: "OTC" })).toBeNull();
  });
  it("builds the display name", () => expect(productDisplayName(med)).toBe("Paracetamol 500 mg tablet (Panadol) · 10 tablets"));
  it("builds a plain name for a device", () => expect(productDisplayName({ category: "DEVICE", genericName: "Digital thermometer", dispensingClass: "OTC" })).toBe("Digital thermometer"));
  it("makes SKUs without look-alike characters", () => {
    for (let i = 0; i < 30; i++) expect(newSku("MEDICINE")).toMatch(/^MED-[A-HJKMNP-Z2-9]{6}$/);
    expect(newSku("DEVICE")).toMatch(/^DEV-/);
  });
  it("sends prescription classes to a pharmacist", () => {
    expect(needsPharmacist("OTC")).toBe(false);
    expect(needsPharmacist("PRESCRIPTION_ONLY")).toBe(true);
    expect(needsPharmacist("CONTROLLED")).toBe(true);
  });
});

describe("pharmacy services", () => {
  it("has unique codes", () => expect(new Set(PHARMACY_SERVICES.map((s) => s.code)).size).toBe(PHARMACY_SERVICES.length));
  it("finds a service", () => expect(findPharmacyService("PHS-003")?.name).toBe("Blood pressure check"));
  it("files delivery under Delivery", () => expect(findPharmacyService("PHS-011")?.category).toBe("Delivery"));
});

describe("request schemas", () => {
  it("defaults a product to OTC and a pack", () => {
    const r = createProductSchema.parse({ category: "DEVICE", genericName: "Glucose meter", priceMinor: 1500000 });
    expect(r).toMatchObject({ dispensingClass: "OTC", unit: "pack", reorderLevel: 0 });
  });
  it("rejects a bad expiry format", () => expect(receiptSchema.safeParse({ productId: "p", batchNo: "B1", quantity: 5, expiryDate: "12/2027" }).success).toBe(false));
  it("rejects an unknown adjustment reason", () => expect(adjustmentSchema.safeParse({ batchId: "b", delta: -1, reason: "STOLEN" }).success).toBe(false));
});
