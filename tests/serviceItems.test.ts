import { describe, it, expect } from "vitest";
import { createServiceItemSchema, updateServiceItemSchema, listServiceItemsQuerySchema } from "../src/schemas/serviceItems.js";

describe("createServiceItemSchema", () => {
  it("accepts a name and a price in kobo", () => {
    expect(createServiceItemSchema.safeParse({ name: "Malaria test", unitPriceMinor: 250000 }).success).toBe(true);
  });
  it("rejects a zero price", () => {
    expect(createServiceItemSchema.safeParse({ name: "Malaria test", unitPriceMinor: 0 }).success).toBe(false);
  });
  it("rejects a price with decimals", () => {
    expect(createServiceItemSchema.safeParse({ name: "Malaria test", unitPriceMinor: 10.5 }).success).toBe(false);
  });
  it("rejects a one-letter name", () => {
    expect(createServiceItemSchema.safeParse({ name: "M", unitPriceMinor: 100 }).success).toBe(false);
  });
});

describe("updateServiceItemSchema", () => {
  it("rejects an empty change", () => {
    expect(updateServiceItemSchema.safeParse({}).success).toBe(false);
  });
  it("accepts turning an item off", () => {
    expect(updateServiceItemSchema.safeParse({ active: false }).success).toBe(true);
  });
  it("accepts clearing the category", () => {
    expect(updateServiceItemSchema.safeParse({ category: null }).success).toBe(true);
  });
});

describe("listServiceItemsQuerySchema", () => {
  it("hides inactive items by default", () => {
    expect(listServiceItemsQuerySchema.parse({}).includeInactive).toBe(false);
  });
  it("reads includeInactive=true", () => {
    expect(listServiceItemsQuerySchema.parse({ includeInactive: "true" }).includeInactive).toBe(true);
  });
});
