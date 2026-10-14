import { describe, it, expect } from "vitest";
import { planRenewal, TOKEN_SECONDS } from "../src/lib/session.js";
import { issueAccessToken, verifyAccessToken } from "../src/lib/tokens.js";

describe("planRenewal", () => {
  const start = 1_000_000;
  it("allows a renewal early in the session with a full-length token", () => {
    expect(planRenewal(start, start + 600, 8)).toEqual({ allowed: true, expiresInSeconds: TOKEN_SECONDS });
  });
  it("shortens the token when little of the session is left", () => {
    expect(planRenewal(start, start + 8 * 3600 - 120, 8)).toEqual({ allowed: true, expiresInSeconds: 120 });
  });
  it("refuses once the session limit is reached", () => {
    expect(planRenewal(start, start + 8 * 3600, 8).allowed).toBe(false);
    expect(planRenewal(start, start + 9 * 3600, 8).allowed).toBe(false);
  });
});

describe("sessionStart claim", () => {
  it("survives the token round trip", async () => {
    const { token } = await issueAccessToken({ sub: "s", tenantId: "t", scopes: [], sessionStart: 1_700_000_000 });
    expect((await verifyAccessToken(token)).sessionStart).toBe(1_700_000_000);
  });
  it("is absent when not set", async () => {
    const { token } = await issueAccessToken({ sub: "s", tenantId: "t", scopes: [] });
    expect((await verifyAccessToken(token)).sessionStart).toBeUndefined();
  });
});
