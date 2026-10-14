import { describe, it, expect } from "vitest";
import { CATALOGUE_CATEGORIES, DIAGNOSTIC_CATALOGUE, findCatalogueTest } from "../src/data/diagnosticCatalogue.js";

describe("diagnostic catalogue", () => {
  it("has 48 distinct entries", () => {
    expect(DIAGNOSTIC_CATALOGUE).toHaveLength(48);
  });
  it("has unique codes and names", () => {
    expect(new Set(DIAGNOSTIC_CATALOGUE.map((t) => t.code)).size).toBe(48);
    expect(new Set(DIAGNOSTIC_CATALOGUE.map((t) => t.name)).size).toBe(48);
  });
  it("matches the male general check-up list of 40", () => {
    expect(DIAGNOSTIC_CATALOGUE.filter((t) => t.checkups.includes("MALE"))).toHaveLength(40);
  });
  it("matches the female general check-up list of 42", () => {
    expect(DIAGNOSTIC_CATALOGUE.filter((t) => t.checkups.includes("FEMALE"))).toHaveLength(42);
  });
  it("puts every test in a known category", () => {
    const known = new Set(CATALOGUE_CATEGORIES.map((c) => c.code));
    expect(DIAGNOSTIC_CATALOGUE.every((t) => known.has(t.categoryCode))).toBe(true);
  });
  it("uses the LAB-CAT-000 code format", () => {
    expect(DIAGNOSTIC_CATALOGUE.every((t) => /^LAB-[A-Z]{4}-\d{3}$/.test(t.code))).toBe(true);
    expect(DIAGNOSTIC_CATALOGUE[3]?.code).toBe("LAB-HAEM-001");
  });
  it("finds a test by code", () => {
    expect(findCatalogueTest("LAB-HAEM-001")?.name).toBe("Full Blood Count (FBC) + ESR");
    expect(findCatalogueTest("nope")).toBeUndefined();
  });
  it("lists every category with at least one test", () => {
    for (const c of CATALOGUE_CATEGORIES) expect(DIAGNOSTIC_CATALOGUE.some((t) => t.categoryCode === c.code)).toBe(true);
  });
});
