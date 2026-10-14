import { describe, it, expect, vi } from "vitest";
import { normalizeNgPhone, sendSms, SmsError, reminderCooldownProblem } from "../src/lib/sms.js";
import { visibleToPatient } from "../src/lib/patientResults.js";

describe("normalizeNgPhone", () => {
  it("handles a local number", () => expect(normalizeNgPhone("0803 123 4567")).toBe("2348031234567"));
  it("handles +234", () => expect(normalizeNgPhone("+234 803 123 4567")).toBe("2348031234567"));
  it("handles 234 without plus", () => expect(normalizeNgPhone("2348031234567")).toBe("2348031234567"));
  it("rejects a short number", () => expect(normalizeNgPhone("0803123")).toBeNull());
  it("rejects a placeholder", () => expect(normalizeNgPhone("—")).toBeNull());
  it("rejects empty", () => expect(normalizeNgPhone(null)).toBeNull());
});

describe("sendSms", () => {
  const cfg = { apiKey: "k", senderId: "N-Alert", channel: "dnd" as const };
  it("posts the message", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await sendSms(cfg, "2348031234567", "Hello there", f as unknown as typeof fetch);
    const body = JSON.parse((f.mock.calls[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ to: "2348031234567", sms: "Hello there", from: "N-Alert", channel: "dnd", type: "plain" });
  });
  it("throws SmsError on a refusal", async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: "Insufficient balance" }) });
    await expect(sendSms(cfg, "2348031234567", "Hello there", f as unknown as typeof fetch)).rejects.toThrow(SmsError);
  });
  it("throws SmsError when unreachable", async () => {
    const f = vi.fn().mockRejectedValue(new Error("down"));
    await expect(sendSms(cfg, "2348031234567", "Hello there", f as unknown as typeof fetch)).rejects.toThrow(SmsError);
  });
});

describe("reminderCooldownProblem", () => {
  const now = new Date("2026-10-14T10:00:00Z");
  it("allows a first reminder", () => expect(reminderCooldownProblem(null, now)).toBeNull());
  it("blocks within 15 minutes", () => expect(reminderCooldownProblem(new Date("2026-10-14T09:50:00Z"), now)).not.toBeNull());
  it("allows after 15 minutes", () => expect(reminderCooldownProblem(new Date("2026-10-14T09:40:00Z"), now)).toBeNull());
});

describe("visibleToPatient", () => {
  const digital = new Set(["a"]);
  it("shows a ready digital result", () => expect(visibleToPatient({ status: "READY", serviceItemId: "a" }, digital)).toBe(true));
  it("hides a pending result", () => expect(visibleToPatient({ status: "PENDING", serviceItemId: "a" }, digital)).toBe(false));
  it("hides a non-digital test", () => expect(visibleToPatient({ status: "READY", serviceItemId: "b" }, digital)).toBe(false));
  it("hides a result with no linked test", () => expect(visibleToPatient({ status: "READY", serviceItemId: null }, digital)).toBe(false));
});
