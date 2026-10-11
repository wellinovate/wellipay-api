import { describe, it, expect } from "vitest";
import { resolveActor } from "../src/lib/actor.js";
import { issueAccessToken, verifyAccessToken } from "../src/lib/tokens.js";

describe("resolveActor", () => {
  const staff = { id: "staff_1", name: "Adaeze Okafor", role: "Finance Manager" };

  it("uses the signed-in staff member and ignores a supplied name", () => {
    expect(resolveActor({ staff }, "Someone Else")).toBe("Adaeze Okafor [staff_1]");
  });

  it("uses the supplied name for a server-to-server token", () => {
    expect(resolveActor({}, "  ERP system  ")).toBe("ERP system");
  });

  it("returns null when there is no staff and nothing supplied", () => {
    expect(resolveActor({}, undefined)).toBeNull();
    expect(resolveActor(undefined, "   ")).toBeNull();
  });

  it("never exceeds 120 characters", () => {
    expect(resolveActor({}, "x".repeat(300))?.length).toBe(120);
  });
});

describe("staff claims", () => {
  it("round-trip through the token", async () => {
    const { token } = await issueAccessToken({
      sub: "staff_1",
      tenantId: "t",
      scopes: ["mobile.integration.read"],
      staffName: "Adaeze Okafor",
      staffRole: "Finance Manager",
    });
    const claims = await verifyAccessToken(token);
    expect(claims.staffName).toBe("Adaeze Okafor");
    expect(claims.staffRole).toBe("Finance Manager");
  });

  it("are absent on a client-credentials token", async () => {
    const { token } = await issueAccessToken({ sub: "client_1", tenantId: "t", scopes: [] });
    const claims = await verifyAccessToken(token);
    expect(claims.staffName).toBeUndefined();
  });
});
