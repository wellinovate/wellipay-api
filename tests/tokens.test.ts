import { describe, it, expect } from "vitest";
import { issueAccessToken, verifyAccessToken } from "../src/lib/tokens.js";

// Every write route and POST /staff/login depend on this round-trip being
// correct — a bug here is an auth bypass or a false rejection, not a
// cosmetic issue.
describe("access token issue/verify round trip", () => {
  it("issues a token that verifies back to the same claims", async () => {
    const { token, expiresIn } = await issueAccessToken({
      sub: "staff_123",
      tenantId: "tenant_abc",
      scopes: ["mobile.integration.read", "mobile.integration.write"],
    });
    expect(typeof token).toBe("string");
    expect(expiresIn).toBe(900);

    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe("staff_123");
    expect(claims.tenantId).toBe("tenant_abc");
    expect(claims.scopes).toEqual(["mobile.integration.read", "mobile.integration.write"]);
  });

  it("honors a custom expiry", async () => {
    const { expiresIn } = await issueAccessToken({ sub: "x", tenantId: "t", scopes: [] }, 60);
    expect(expiresIn).toBe(60);
  });

  it("rejects an already-expired token", async () => {
    const { token } = await issueAccessToken({ sub: "x", tenantId: "t", scopes: [] }, -1);
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects a malformed token", async () => {
    await expect(verifyAccessToken("not-a-real-jwt")).rejects.toThrow();
  });

  it("carries a patientRef claim through the round trip when present", async () => {
    const { token } = await issueAccessToken({
      sub: "pat_acct_1",
      tenantId: "tenant_abc",
      scopes: ["patient.self.read", "patient.self.write"],
      patientRef: "ref_789",
    });
    const claims = await verifyAccessToken(token);
    expect(claims.patientRef).toBe("ref_789");
  });

  it("omits patientRef entirely (not a literal undefined key) for a staff/provider token", async () => {
    const { token } = await issueAccessToken({ sub: "staff_1", tenantId: "t", scopes: ["mobile.integration.read"] });
    const claims = await verifyAccessToken(token);
    expect(claims.patientRef).toBeUndefined();
    expect("patientRef" in claims).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    // Simulates what happens if TOKEN_SIGNING_SECRET is rotated or wrong —
    // a token from the old secret must not verify against the new one.
    const { SignJWT } = await import("jose");
    const otherSecret = new TextEncoder().encode("a-completely-different-secret-value-1234567890");
    const foreignToken = await new SignJWT({ tenantId: "t", scopes: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("x")
      .setIssuer("https://api.wellipay.internal")
      .setAudience("wellipay-integration-service")
      .setIssuedAt()
      .setExpirationTime("900s")
      .sign(otherSecret);

    await expect(verifyAccessToken(foreignToken)).rejects.toThrow();
  });
});
