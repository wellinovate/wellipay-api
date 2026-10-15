import { describe, it, expect } from "vitest";
import { ACTION_LABELS, clampLimit, describeAction, makeCursor, parseCursor, resourceIdFrom, shouldAudit } from "../src/lib/auditTrail.js";
import { ROUTE_RULES, allowedLevels } from "../src/lib/permissions.js";

describe("shouldAudit", () => {
  it("records successful writes under /provider", () => {
    expect(shouldAudit("POST", "/provider/invoices", 201)).toBe(true);
    expect(shouldAudit("PATCH", "/provider/refunds/:refundId/decision", 200)).toBe(true);
    expect(shouldAudit("DELETE", "/provider/webhook-endpoints/:id", 204)).toBe(true);
  });
  it("skips reads, failures and routes outside /provider", () => {
    expect(shouldAudit("GET", "/provider/invoices", 200)).toBe(false);
    expect(shouldAudit("POST", "/provider/invoices", 409)).toBe(false);
    expect(shouldAudit("POST", "/provider/invoices", 500)).toBe(false);
    expect(shouldAudit("POST", "/patient/record-connections", 201)).toBe(false);
    expect(shouldAudit("POST", "/webhooks/paystack", 200)).toBe(false);
  });
});

describe("describeAction", () => {
  it("uses the label table", () => {
    expect(describeAction("PATCH", "/provider/refunds/:refundId/decision")).toBe("Decided a refund");
  });
  it("falls back to a readable phrase for a route with no label", () => {
    expect(describeAction("POST", "/provider/new-thing/:id/sub-part")).toBe("Created new thing sub part");
    expect(describeAction("DELETE", "/provider/widgets/:id")).toBe("Removed widgets");
    expect(describeAction("PATCH", "/provider/widgets/:id")).toBe("Updated widgets");
  });
  it("has a label for every write route in the permissions table", () => {
    const missing = ROUTE_RULES.filter(([m, p]) => m !== "GET" && !ACTION_LABELS[`${m} ${p}`]).map(([m, p]) => `${m} ${p}`);
    expect(missing).toEqual([]);
  });
  it("has no label for a route that does not exist", () => {
    const known = new Set(ROUTE_RULES.map(([m, p]) => `${m} ${p}`));
    expect(Object.keys(ACTION_LABELS).filter((k) => !known.has(k))).toEqual([]);
  });
});

describe("helpers", () => {
  it("takes the first route parameter as the resource", () => {
    expect(resourceIdFrom({ id: "abc" })).toBe("abc");
    expect(resourceIdFrom({})).toBeNull();
    expect(resourceIdFrom(undefined)).toBeNull();
  });
  it("clamps the page size", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit("20")).toBe(20);
    expect(clampLimit("9999")).toBe(200);
    expect(clampLimit("0")).toBe(50);
    expect(clampLimit("abc")).toBe(50);
  });
  it("round-trips a cursor and rejects junk", () => {
    const row = { createdAt: new Date("2026-10-16T10:00:00.000Z"), id: "cabc123" };
    expect(parseCursor(makeCursor(row))).toEqual({ at: row.createdAt, id: "cabc123" });
    expect(parseCursor("nonsense")).toBeNull();
    expect(parseCursor("not-a-date_abc")).toBeNull();
    expect(parseCursor(5)).toBeNull();
  });
});

describe("permissions", () => {
  it("lets only Admin and Finance read the audit trail", () => {
    expect([...allowedLevels("GET", "/provider/audit-events")].sort()).toEqual(["ADMIN", "FINANCE"]);
  });
});
