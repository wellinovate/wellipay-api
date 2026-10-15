import { describe, it, expect } from "vitest";
import { approvalStep } from "../src/lib/refundApproval.js";
import { setRefundLimitSchema } from "../src/schemas/account.js";
import { allowedLevels } from "../src/lib/permissions.js";

const base = { limitMinor: 100000n, amountMinor: 250000n, firstApprovedBy: null as string | null, requestedBy: "Tunde [s9]", actor: "Ada [s1]", decision: "APPROVED" as const };

describe("approvalStep", () => {
  it("needs one approver when no limit is set", () => {
    expect(approvalStep({ ...base, limitMinor: null })).toEqual({ kind: "FINAL" });
  });
  it("needs one approver at or below the limit", () => {
    expect(approvalStep({ ...base, amountMinor: 100000n })).toEqual({ kind: "FINAL" });
    expect(approvalStep({ ...base, amountMinor: 99999n })).toEqual({ kind: "FINAL" });
  });
  it("records a first approval above the limit", () => {
    expect(approvalStep(base)).toEqual({ kind: "FIRST" });
  });
  it("blocks the same person from giving the second approval", () => {
    const step = approvalStep({ ...base, firstApprovedBy: "Ada [s1]" });
    expect(step.kind).toBe("BLOCKED");
    if (step.kind === "BLOCKED") expect(step.code).toBe("second_approver_required");
  });
  it("accepts a different person as the second approver", () => {
    expect(approvalStep({ ...base, firstApprovedBy: "Ada [s1]", actor: "Bola [s2]" })).toEqual({ kind: "FINAL" });
  });
  it("blocks the requester from approving, at any amount and with no limit", () => {
    for (const limitMinor of [null, 100000n]) {
      const step = approvalStep({ ...base, limitMinor, requestedBy: "Ada [s1]" });
      expect(step.kind).toBe("BLOCKED");
      if (step.kind === "BLOCKED") expect(step.code).toBe("requester_cannot_approve");
    }
  });
  it("blocks the requester from giving the second approval too", () => {
    expect(approvalStep({ ...base, firstApprovedBy: "Bola [s2]", requestedBy: "Ada [s1]" }).kind).toBe("BLOCKED");
  });
  it("lets the requester reject their own request", () => {
    expect(approvalStep({ ...base, decision: "REJECTED", requestedBy: "Ada [s1]" })).toEqual({ kind: "FINAL" });
  });
  it("needs one person to reject, whatever the amount", () => {
    expect(approvalStep({ ...base, decision: "REJECTED" })).toEqual({ kind: "FINAL" });
  });
});

describe("refund limit input", () => {
  it("accepts a whole number of kobo or null", () => {
    expect(setRefundLimitSchema.safeParse({ limitMinor: 5000000 }).success).toBe(true);
    expect(setRefundLimitSchema.safeParse({ limitMinor: null }).success).toBe(true);
  });
  it("rejects zero, negatives, fractions and a missing field", () => {
    for (const v of [0, -1, 10.5, undefined]) expect(setRefundLimitSchema.safeParse({ limitMinor: v }).success).toBe(false);
  });
});

describe("account route access", () => {
  it("lets Finance read and only Admin change the limit", () => {
    expect(allowedLevels("GET", "/provider/account")).toEqual(["ADMIN", "FINANCE"]);
    expect(allowedLevels("PATCH", "/provider/account/refund-limit")).toEqual(["ADMIN"]);
    expect(allowedLevels("GET", "/provider/integrations/status")).toEqual(["ADMIN"]);
  });
});
