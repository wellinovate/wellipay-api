import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_RULES, STAFF_ACCESS_LEVELS, levelCanCall, allowedLevels } from "../src/lib/permissions.js";
import { issueAccessToken, verifyAccessToken } from "../src/lib/tokens.js";

function providerRoutes(): string[] {
  const dir = join(__dirname, "../src/routes");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/app\.(get|post|patch|put|delete)\(\s*"(\/provider[^"]*)"/g)) {
      found.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
  }
  return [...found];
}

describe("route rules", () => {
  it("cover every /provider route", () => {
    const ruled = new Set(ROUTE_RULES.map(([m, p]) => `${m} ${p}`));
    const missing = providerRoutes().filter((r) => !ruled.has(r));
    expect(missing).toEqual([]);
  });

  it("do not name routes that no longer exist", () => {
    const real = new Set(providerRoutes());
    const stale = ROUTE_RULES.map(([m, p]) => `${m} ${p}`).filter((r) => !real.has(r));
    expect(stale).toEqual([]);
  });

  it("have no duplicate entries", () => {
    const keys = ROUTE_RULES.map(([m, p]) => `${m} ${p}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("levelCanCall", () => {
  it("lets Admin call everything, including unmapped routes", () => {
    for (const [m, p] of ROUTE_RULES) expect(levelCanCall("ADMIN", m, p)).toBe(true);
    expect(levelCanCall("ADMIN", "GET", "/provider/not-a-route")).toBe(true);
  });

  it("denies every other level on an unmapped route", () => {
    for (const level of STAFF_ACCESS_LEVELS.filter((l) => l !== "ADMIN")) {
      expect(levelCanCall(level, "GET", "/provider/not-a-route")).toBe(false);
    }
  });

  it("lets a cashier take payments and request refunds but not decide them", () => {
    expect(levelCanCall("CASHIER", "POST", "/provider/payments")).toBe(true);
    expect(levelCanCall("CASHIER", "POST", "/provider/refunds")).toBe(true);
    expect(levelCanCall("CASHIER", "PATCH", "/provider/refunds/:refundId/decision")).toBe(false);
  });

  it("lets Finance decide refunds and confirm settlements", () => {
    expect(levelCanCall("FINANCE", "PATCH", "/provider/refunds/:refundId/decision")).toBe(true);
    expect(levelCanCall("FINANCE", "PATCH", "/provider/settlements/:id/confirm")).toBe(true);
  });

  it("keeps Billing out of refund decisions and settlements", () => {
    expect(levelCanCall("BILLING", "PATCH", "/provider/refunds/:refundId/decision")).toBe(false);
    expect(levelCanCall("BILLING", "PATCH", "/provider/settlements/:id/confirm")).toBe(false);
    expect(levelCanCall("BILLING", "PATCH", "/provider/claims/:claimId/status")).toBe(true);
  });

  it("makes Viewer read-only", () => {
    for (const [m, p, levels] of ROUTE_RULES) {
      if (m !== "GET") expect(levels.includes("VIEWER"), `${m} ${p}`).toBe(false);
    }
  });

  it("restricts staff and webhook routes to Admin", () => {
    for (const [m, p] of ROUTE_RULES.filter(([, p]) => p.startsWith("/provider/staff") || p.startsWith("/provider/webhook-endpoints"))) {
      expect(allowedLevels(m, p)).toEqual(["ADMIN"]);
    }
  });

  it("keeps cashiers out of settlement and reconciliation reads", () => {
    expect(levelCanCall("CASHIER", "GET", "/provider/settlements")).toBe(false);
    expect(levelCanCall("CASHIER", "GET", "/provider/unmatched-transactions")).toBe(false);
    expect(levelCanCall("CASHIER", "GET", "/provider/claims/reconciliation")).toBe(false);
  });
});

describe("staffLevel claim", () => {
  it("round-trips through the token", async () => {
    const { token } = await issueAccessToken({
      sub: "staff_1",
      tenantId: "t1",
      scopes: ["mobile.integration.read"],
      staffName: "A",
      staffRole: "Cashier",
      staffLevel: "CASHIER",
    });
    const claims = await verifyAccessToken(token);
    expect(claims.staffLevel).toBe("CASHIER");
  });
});
