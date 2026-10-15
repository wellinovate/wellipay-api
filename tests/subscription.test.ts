import { describe, it, expect } from "vitest";
import { serializeSubscription } from "../src/lib/subscription.js";
import { ROUTE_RULES } from "../src/lib/permissions.js";

describe("serializeSubscription", () => {
  it("returns nulls and the default fee when nothing is recorded", () => {
    expect(serializeSubscription({ planName: null, planMonthlyFeeMinor: null, platformFeePercent: null, planStartedAt: null }, 1)).toEqual({
      planName: null, monthlyFeeMinor: null, startedAt: null, platformFeePercent: 1, platformFeeSource: "default",
    });
  });
  it("reports recorded terms as agreed", () => {
    const out = serializeSubscription(
      { planName: "Standard", planMonthlyFeeMinor: 2500000n, platformFeePercent: { toString: () => "1.50" }, planStartedAt: new Date("2026-11-01T00:00:00Z") }, 1);
    expect(out).toMatchObject({ planName: "Standard", monthlyFeeMinor: 2500000, platformFeePercent: 1.5, platformFeeSource: "agreed", startedAt: "2026-11-01T00:00:00.000Z" });
  });
  it("is limited to Admin and Finance", () => {
    const rule = ROUTE_RULES.find(([m, p]) => m === "GET" && p === "/provider/subscription");
    expect(rule?.[2]).toEqual(["ADMIN", "FINANCE"]);
  });
});
