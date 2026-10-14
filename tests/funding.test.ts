import { describe, it, expect } from "vitest";
import { fundingTotals } from "../src/lib/funding.js";

const pledges = [
  { id: "a", amountMinor: 50000n, status: "PENDING" },
  { id: "b", amountMinor: 30000n, status: "PENDING" },
];

describe("fundingTotals", () => {
  it("stays OPEN while a pledge is unpaid", () => {
    const r = fundingTotals(pledges, "a", 50000n);
    expect(r.totalPaid).toBe(50000n);
    expect(r.totalPledged).toBe(80000n);
    expect(r.status).toBe("OPEN");
  });
  it("is FUNDED when the last pledge is paid", () => {
    const r = fundingTotals([{ id: "a", amountMinor: 50000n, status: "PAID" }, pledges[1]], "b", 30000n);
    expect(r.totalPaid).toBe(80000n);
    expect(r.status).toBe("FUNDED");
  });
  it("does not count failed pledges as paid", () => {
    const r = fundingTotals([{ id: "a", amountMinor: 50000n, status: "FAILED" }, pledges[1]], "b", 30000n);
    expect(r.totalPaid).toBe(30000n);
    expect(r.status).toBe("OPEN");
  });
});

import { listFamilyFundingQuerySchema } from "../src/schemas/familyFunding.js";
describe("listFamilyFundingQuerySchema", () => {
  it("defaults the limit to 50", () => {
    expect(listFamilyFundingQuerySchema.parse({}).limit).toBe(50);
  });
  it("accepts an invoice filter", () => {
    expect(listFamilyFundingQuerySchema.parse({ invoiceId: "abc" }).invoiceId).toBe("abc");
  });
});
