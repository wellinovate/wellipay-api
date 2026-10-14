import { describe, it, expect } from "vitest";
import { canMoveBooking, nextBookingStatuses } from "../src/lib/bookings.js";
import { packageProblem } from "../src/lib/packages.js";
import { createBookingSchema, updateBookingSchema } from "../src/schemas/bookings.js";
import { createCorporateAccountSchema, updateCorporateAccountSchema } from "../src/schemas/corporateAccounts.js";
import { createServiceItemSchema } from "../src/schemas/serviceItems.js";
import { createInvoiceSchema } from "../src/schemas/invoices.js";

describe("booking status flow", () => {
  it("moves forward one step at a time", () => {
    expect(canMoveBooking("BOOKED", "SAMPLE_COLLECTED")).toBe(true);
    expect(canMoveBooking("SAMPLE_COLLECTED", "PROCESSING")).toBe(true);
    expect(canMoveBooking("PROCESSING", "READY")).toBe(true);
  });
  it("does not skip steps or go back", () => {
    expect(canMoveBooking("BOOKED", "READY")).toBe(false);
    expect(canMoveBooking("PROCESSING", "BOOKED" as never)).toBe(false);
  });
  it("cancels only before collection", () => {
    expect(canMoveBooking("BOOKED", "CANCELLED")).toBe(true);
    expect(canMoveBooking("SAMPLE_COLLECTED", "CANCELLED")).toBe(false);
  });
  it("treats READY and CANCELLED as final", () => {
    expect(nextBookingStatuses("READY")).toEqual([]);
    expect(nextBookingStatuses("CANCELLED")).toEqual([]);
  });
});

describe("createBookingSchema", () => {
  const base = { patientRef: "P-100000", scheduledAt: "2026-10-20T09:00:00.000Z" };
  it("accepts a centre visit without an address", () => {
    expect(createBookingSchema.safeParse({ ...base, type: "CENTRE_VISIT" }).success).toBe(true);
  });
  it("requires an address for a home collection", () => {
    expect(createBookingSchema.safeParse({ ...base, type: "HOME_COLLECTION" }).success).toBe(false);
    expect(createBookingSchema.safeParse({ ...base, type: "HOME_COLLECTION", address: "12 Aminu Kano Crescent, Wuse 2" }).success).toBe(true);
  });
  it("rejects a bad date", () => {
    expect(createBookingSchema.safeParse({ ...base, scheduledAt: "tomorrow", type: "CENTRE_VISIT" }).success).toBe(false);
  });
});

describe("updateBookingSchema", () => {
  it("rejects an empty change", () => {
    expect(updateBookingSchema.safeParse({}).success).toBe(false);
  });
  it("does not allow setting BOOKED", () => {
    expect(updateBookingSchema.safeParse({ status: "BOOKED" }).success).toBe(false);
  });
});

describe("packageProblem", () => {
  const items = [
    { id: "a", active: true, componentIds: [] },
    { id: "b", active: true, componentIds: [] },
    { id: "off", active: false, componentIds: [] },
    { id: "pkg", active: true, componentIds: ["a", "b"] },
  ];
  it("accepts two active single items", () => {
    expect(packageProblem(["a", "b"], items)).toBeNull();
  });
  it("needs at least two items", () => {
    expect(packageProblem(["a"], items)).toMatch(/at least two/);
  });
  it("refuses duplicates", () => {
    expect(packageProblem(["a", "a"], items)).toMatch(/twice/);
  });
  it("refuses switched-off items", () => {
    expect(packageProblem(["a", "off"], items)).toMatch(/switched off/);
  });
  it("refuses nesting", () => {
    expect(packageProblem(["a", "pkg"], items)).toMatch(/another package/);
  });
  it("refuses unknown items", () => {
    expect(packageProblem(["a", "zzz"], items)).toMatch(/not on your price list/);
  });
  it("refuses a package containing itself", () => {
    expect(packageProblem(["a", "b"], items, "a")).toMatch(/itself/);
  });
});

describe("service item schema with components", () => {
  it("accepts a package", () => {
    expect(createServiceItemSchema.safeParse({ name: "Executive screening", unitPriceMinor: 5000000, componentIds: ["a", "b"] }).success).toBe(true);
  });
});

describe("corporate account schemas", () => {
  it("accepts a name alone", () => {
    expect(createCorporateAccountSchema.safeParse({ name: "Zenith Staff Clinic" }).success).toBe(true);
  });
  it("rejects a bad email", () => {
    expect(createCorporateAccountSchema.safeParse({ name: "Zenith Staff Clinic", email: "x" }).success).toBe(false);
  });
  it("rejects an empty change", () => {
    expect(updateCorporateAccountSchema.safeParse({}).success).toBe(false);
  });
});

describe("invoice schema with an account", () => {
  const inv = { providerInvoiceRef: "INV-1", facilityRef: "facility-main", patientRef: "P-1", description: "Screening", amountMinor: 100, currency: "NGN" as const };
  it("accepts corporateAccountId", () => {
    expect(createInvoiceSchema.safeParse({ ...inv, corporateAccountId: "acc1" }).success).toBe(true);
  });
  it("still works without it", () => {
    expect(createInvoiceSchema.safeParse(inv).success).toBe(true);
  });
});

describe("imaging bookings", () => {
  const base = { patientRef: "P-100000", scheduledAt: "2026-10-20T09:00:00.000Z" };
  it("defaults to a lab booking", () => {
    expect(createBookingSchema.parse({ ...base, type: "CENTRE_VISIT" }).kind).toBe("LAB");
  });
  it("accepts a scan at the centre", () => {
    expect(createBookingSchema.safeParse({ ...base, type: "CENTRE_VISIT", kind: "IMAGING" }).success).toBe(true);
  });
  it("refuses a home collection for a scan", () => {
    expect(createBookingSchema.safeParse({ ...base, type: "HOME_COLLECTION", kind: "IMAGING", address: "12 Aminu Kano Crescent" }).success).toBe(false);
  });
});
