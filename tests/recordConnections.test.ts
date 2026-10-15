import { describe, it, expect, vi } from "vitest";
import {
  canRevoke, codeProblem, confirmCheck, integrationEnvName, integrationKeyProblem, nextStep, normalizeReference, scopeKey, MAX_CODE_ATTEMPTS,
} from "../src/lib/recordConnections.js";
import { confirmPartnerVerification, partnerReferenceMatches, startPartnerVerification, PartnerError } from "../src/lib/recordPartner.js";
import { allowedLevels } from "../src/lib/permissions.js";
import { createRecordConnectionSchema } from "../src/schemas/recordConnections.js";

describe("normalizeReference", () => {
  it("upper-cases a WelliRecord ID and requires the WR- prefix", () => {
    expect(normalizeReference("WELLIRECORD", " wr-2291-04 ")).toEqual({ ok: true, value: "WR-2291-04" });
    expect(normalizeReference("WELLIRECORD", "2291-04").ok).toBe(false);
    expect(normalizeReference("WELLIRECORD", "WR-").ok).toBe(false);
  });
  it("keeps an external ID as typed and rejects spaces", () => {
    expect(normalizeReference("EXTERNAL_SYSTEM", "Pt/00931")).toEqual({ ok: true, value: "Pt/00931" });
    expect(normalizeReference("EXTERNAL_SYSTEM", "pt 00931").ok).toBe(false);
  });
  it("tidies a provider patient number", () => {
    expect(normalizeReference("PROVIDER_PATIENT_NUMBER", " lab  12/445 ")).toEqual({ ok: true, value: "LAB 12/445" });
    expect(normalizeReference("PROVIDER_PATIENT_NUMBER", "").ok).toBe(false);
  });
});

describe("scopeKey", () => {
  it("scopes partner references to the integration", () => {
    expect(scopeKey("WELLIRECORD", "wellirecord", "t1")).toBe("integration:wellirecord");
  });
  it("scopes patient numbers to the provider, so two providers never collide", () => {
    expect(scopeKey("PROVIDER_PATIENT_NUMBER", null, "t1")).not.toBe(scopeKey("PROVIDER_PATIENT_NUMBER", null, "t2"));
  });
});

describe("integration names", () => {
  it("builds the environment variable name", () => {
    expect(integrationEnvName("acme-labs")).toBe("RECORD_INTEGRATION_ACME_LABS_API_KEY");
  });
  it("checks the key format", () => {
    expect(integrationKeyProblem("wellirecord")).toBeNull();
    expect(integrationKeyProblem("Acme")).not.toBeNull();
    expect(integrationKeyProblem("1abc")).not.toBeNull();
  });
});

describe("confirmCheck", () => {
  const now = new Date("2026-10-17T10:00:00Z");
  const ok = { status: "PENDING_VERIFICATION", attempts: 0, expiresAt: new Date("2026-10-17T10:05:00Z"), now };
  it("accepts a pending, unexpired connection", () => expect(confirmCheck(ok).ok).toBe(true));
  it("rejects a closed connection", () => expect(confirmCheck({ ...ok, status: "VERIFIED" })).toMatchObject({ ok: false, code: "not_pending" }));
  it("rejects an expired code", () => expect(confirmCheck({ ...ok, expiresAt: new Date("2026-10-17T09:59:00Z") })).toMatchObject({ ok: false, code: "expired" }));
  it("rejects after the attempt limit", () => expect(confirmCheck({ ...ok, attempts: MAX_CODE_ATTEMPTS })).toMatchObject({ ok: false, code: "too_many_attempts" }));
});

describe("small rules", () => {
  it("only open or verified connections can be revoked", () => {
    expect(canRevoke("VERIFIED")).toBe(true);
    expect(canRevoke("PENDING_VERIFICATION")).toBe(true);
    expect(canRevoke("REVOKED")).toBe(false);
    expect(canRevoke("REJECTED")).toBe(false);
  });
  it("tells the app what comes next", () => {
    expect(nextStep("WELLIRECORD", "PENDING_VERIFICATION")).toBe("ENTER_CODE");
    expect(nextStep("PROVIDER_PATIENT_NUMBER", "PENDING_VERIFICATION")).toBe("AWAIT_PROVIDER_REVIEW");
    expect(nextStep("WELLIRECORD", "VERIFIED")).toBe("NONE");
  });
  it("checks the code format", () => {
    expect(codeProblem("123456")).toBeNull();
    expect(codeProblem("12345")).not.toBeNull();
    expect(codeProblem("12345a")).not.toBeNull();
  });
});

describe("partner calls", () => {
  const cfg = { baseUrl: "https://partner.example/", apiKey: "key-123" };
  const reply = (status: number, body?: unknown) => vi.fn().mockResolvedValue({ status, json: async () => body });

  it("sends the request id and reference with a bearer key and a signature", async () => {
    const f = reply(202);
    await startPartnerVerification(cfg, { requestId: "r1", reference: "WR-1" }, f);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://partner.example/wellipay/v1/verifications");
    expect(init.headers.authorization).toBe("Bearer key-123");
    expect(init.headers["x-wellipay-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body)).toEqual({ requestId: "r1", reference: "WR-1" });
  });
  it("raises when the partner refuses to start", async () => {
    await expect(startPartnerVerification(cfg, { requestId: "r1", reference: "WR-1" }, reply(500))).rejects.toBeInstanceOf(PartnerError);
  });
  it("raises when the partner cannot be reached", async () => {
    await expect(startPartnerVerification(cfg, { requestId: "r1", reference: "WR-1" }, vi.fn().mockRejectedValue(new Error("down")))).rejects.toBeInstanceOf(PartnerError);
  });
  it("reads a verified answer", async () => {
    expect(await confirmPartnerVerification(cfg, { requestId: "r1", code: "123456" }, reply(200, { verified: true, reference: "WR-1" }))).toEqual({ verified: true, reference: "WR-1" });
  });
  it("treats a wrong or unknown code as not verified", async () => {
    for (const status of [400, 404, 410, 422]) {
      expect(await confirmPartnerVerification(cfg, { requestId: "r1", code: "000000" }, reply(status))).toEqual({ verified: false, reference: null });
    }
  });
  it("does not treat anything but verified:true as verified", async () => {
    expect((await confirmPartnerVerification(cfg, { requestId: "r1", code: "1" }, reply(200, { verified: "yes" }))).verified).toBe(false);
  });
  it("raises on a partner error while checking", async () => {
    await expect(confirmPartnerVerification(cfg, { requestId: "r1", code: "123456" }, reply(503))).rejects.toBeInstanceOf(PartnerError);
  });
  it("requires the partner to return the same reference", () => {
    expect(partnerReferenceMatches("WR-1", "wr-1")).toBe(true);
    expect(partnerReferenceMatches("WR-1", "WR-2")).toBe(false);
    expect(partnerReferenceMatches("WR-1", null)).toBe(false);
  });
});

describe("request schema and permissions", () => {
  it("rejects an unknown kind", () => {
    expect(createRecordConnectionSchema.safeParse({ kind: "OTHER", reference: "x" }).success).toBe(false);
  });
  it("lets the front desk list requests but only Billing and above decide", () => {
    expect(allowedLevels("GET", "/provider/record-connections")).toContain("CASHIER");
    expect(allowedLevels("PATCH", "/provider/record-connections/:id/decision")).not.toContain("CASHIER");
    expect(allowedLevels("PATCH", "/provider/record-connections/:id/decision")).not.toContain("VIEWER");
    expect(allowedLevels("POST", "/provider/record-connections/:id/revoke")).toContain("BILLING");
  });
});
