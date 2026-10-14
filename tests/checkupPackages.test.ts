import { describe, it, expect } from "vitest";
import { checkupProblem } from "../src/lib/checkups.js";
import {
  offerTestsSchema,
  createCheckupPackageSchema,
  updateCheckupPackageSchema,
} from "../src/schemas/catalogue.js";
import { createServiceItemSchema } from "../src/schemas/serviceItems.js";

const items = [
  { id: "a", active: true, componentIds: [] },
  { id: "b", active: true, componentIds: [] },
  { id: "off", active: false, componentIds: [] },
  { id: "pkg", active: true, componentIds: ["a", "b"] },
];

describe("checkupProblem", () => {
  it("accepts two active single items", () => expect(checkupProblem(["a", "b"], items)).toBeNull());
  it("rejects fewer than two", () => expect(checkupProblem(["a"], items)).not.toBeNull());
  it("rejects a repeated test", () => expect(checkupProblem(["a", "a"], items)).not.toBeNull());
  it("rejects an unknown item", () => expect(checkupProblem(["a", "zzz"], items)).not.toBeNull());
  it("rejects a switched-off item", () => expect(checkupProblem(["a", "off"], items)).not.toBeNull());
  it("rejects a package inside a package", () => expect(checkupProblem(["a", "pkg"], items)).not.toBeNull());
});

describe("offerTestsSchema", () => {
  it("accepts a priced test", () => {
    expect(offerTestsSchema.safeParse({ tests: [{ code: "LAB-HAEM-001", unitPriceMinor: 500000 }] }).success).toBe(true);
  });
  it("requires a price", () => {
    expect(offerTestsSchema.safeParse({ tests: [{ code: "LAB-HAEM-001" }] }).success).toBe(false);
  });
  it("rejects an empty list", () => {
    expect(offerTestsSchema.safeParse({ tests: [] }).success).toBe(false);
  });
  it("rejects more than 60 tests", () => {
    const tests = Array.from({ length: 61 }, (_, i) => ({ code: `LAB-HAEM-${i}`, unitPriceMinor: 100 }));
    expect(offerTestsSchema.safeParse({ tests }).success).toBe(false);
  });
});

describe("check-up package schemas", () => {
  const base = { name: "Executive male", tier: "EXECUTIVE", priceMinor: 9000000, includedIds: ["a", "b"] };
  it("accepts a valid package", () => expect(createCheckupPackageSchema.safeParse(base).success).toBe(true));
  it("accepts Platinum", () => expect(createCheckupPackageSchema.safeParse({ ...base, tier: "PLATINUM" }).success).toBe(true));
  it("rejects an unknown tier", () => expect(createCheckupPackageSchema.safeParse({ ...base, tier: "GOLD" }).success).toBe(false));
  it("rejects a zero price", () => expect(createCheckupPackageSchema.safeParse({ ...base, priceMinor: 0 }).success).toBe(false));
  it("rejects an empty change", () => expect(updateCheckupPackageSchema.safeParse({}).success).toBe(false));
  it("accepts switching a package off", () => expect(updateCheckupPackageSchema.safeParse({ available: false }).success).toBe(true));
});

describe("service record fields", () => {
  it("accepts the new fields on a price list item", () => {
    const r = createServiceItemSchema.safeParse({
      name: "Lipid profile",
      unitPriceMinor: 800000,
      serviceCode: "L-12",
      sampleType: "Blood",
      turnaround: "24 hours",
      preparation: "Fast for 12 hours.",
      homeCollection: true,
      digitalResults: true,
    });
    expect(r.success).toBe(true);
  });
});
