import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { canSeeCost } from "../src/lib/costAccess.js";
import { isControlledClass, collectorIdProblem, registerCsv, appendRegisterEntry } from "../src/lib/controlledRegister.js";
import { detectImageType, imageProblem, MAX_IMAGE_BYTES } from "../src/lib/prescriptionImages.js";
import { trackingUrlFor, templateProblem, courierEventProblem, newCourierSecret } from "../src/lib/courier.js";
import { noticeMessage } from "../src/lib/pharmacyNoticeText.js";
import { signPayload, verifySignature } from "../src/lib/webhooks.js";
import { courierSchema, courierEventSchema, registerQuery, imageUploadSchema, deliverySchema, dispenseSchema } from "../src/schemas/pharmacyOrders.js";
import { ROUTE_RULES } from "../src/lib/permissions.js";

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(200, 1)]);

describe("cost visibility", () => {
  it("shows cost to admin and finance only", () => {
    expect(canSeeCost({ staff: { level: "ADMIN" } })).toBe(true);
    expect(canSeeCost({ staff: { level: "FINANCE" } })).toBe(true);
    for (const level of ["BILLING", "CASHIER", "VIEWER"]) expect(canSeeCost({ staff: { level } })).toBe(false);
  });
  it("hides cost from a token with no staff member", () => {
    expect(canSeeCost({})).toBe(false);
    expect(canSeeCost(undefined)).toBe(false);
  });
});

describe("controlled-drug register", () => {
  it("covers only the controlled class", () => {
    expect(isControlledClass("CONTROLLED")).toBe(true);
    expect(isControlledClass("PRESCRIPTION_ONLY")).toBe(false);
    expect(isControlledClass("OTC")).toBe(false);
  });
  it("needs the collector's ID for a controlled pickup", () => {
    expect(collectorIdProblem("PICKUP", true, undefined)).toMatch(/ID/);
    expect(collectorIdProblem("PICKUP", true, "NIN 1234")).toBeNull();
    expect(collectorIdProblem("DELIVERY", true, undefined)).toBeNull();
    expect(collectorIdProblem("PICKUP", false, undefined)).toBeNull();
  });
  it("records the balance after the change, inside the caller's transaction", async () => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      stockBatch: { aggregate: async () => ({ _sum: { quantityOnHand: 17 } }) },
      controlledRegisterEntry: { create: async (a: { data: Record<string, unknown> }) => { created.push(a.data); return a.data; } },
    };
    await appendRegisterEntry(tx, { tenantId: "t", productId: "p", productName: "Morphine 10mg", batchNo: "B1", kind: "DISPENSE", quantity: -3, actor: "Ada", patientName: "Bola", reason: undefined as unknown as null });
    expect(created[0]).toMatchObject({ balanceAfter: 17, quantity: -3, kind: "DISPENSE", patientName: "Bola" });
    expect("reason" in (created[0] as object)).toBe(false);
  });
  it("treats no stock as a zero balance", async () => {
    let seen: Record<string, unknown> = {};
    const tx = { stockBatch: { aggregate: async () => ({ _sum: { quantityOnHand: null } }) }, controlledRegisterEntry: { create: async (a: { data: Record<string, unknown> }) => (seen = a.data) } };
    await appendRegisterEntry(tx, { tenantId: "t", productId: "p", productName: "X", batchNo: "B", kind: "WRITE_OFF", quantity: -1, actor: "a" });
    expect(seen.balanceAfter).toBe(0);
  });
  it("exports CSV and neutralises formulas", () => {
    const csv = registerCsv([{ createdAt: new Date("2026-10-15T10:00:00Z"), productName: "=cmd|' /C calc'!A0", batchNo: "B,1", kind: "DISPENSE", quantity: -2, balanceAfter: 8, patientName: "Ada \"A\" Obi", patientRef: "P1", prescriberName: null, prescriberLicenceNo: null, recipientName: null, recipientId: null, supplierName: null, reason: null, actor: "PH" }]);
    const [head, row] = csv.trim().split("\n");
    expect(head).toContain("Medicine");
    expect(row).toContain("\"'=cmd|' /C calc'!A0\"".replace(/^"|"$/g, "")) ;
    expect(row).toContain('"B,1"');
    expect(row).toContain('"Ada ""A"" Obi"');
  });
});

describe("prescription photos", () => {
  it("reads the type from the bytes", () => {
    expect(detectImageType(jpeg)).toBe("image/jpeg");
    expect(detectImageType(png)).toBe("image/png");
    expect(detectImageType(webp)).toBe("image/webp");
    expect(detectImageType(Buffer.from("<html>"))).toBeNull();
  });
  it("accepts a good photo", () => {
    const r = imageProblem(jpeg.toString("base64"), "image/jpeg", 0);
    expect("bytes" in r && r.type).toBe("image/jpeg");
  });
  it("refuses a mismatch, a disguised file, bad data and a full prescription", () => {
    expect(imageProblem(png.toString("base64"), "image/jpeg", 0)).toHaveProperty("problem");
    expect(imageProblem(Buffer.from("<script>alert(1)</script>").toString("base64"), "image/jpeg", 0)).toHaveProperty("problem");
    expect(imageProblem("not base64!!", "image/png", 0)).toHaveProperty("problem");
    expect(imageProblem(jpeg.toString("base64"), "image/jpeg", 3)).toHaveProperty("problem");
  });
  it("refuses a photo over the size limit", () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(imageProblem(big.toString("base64"), "image/jpeg", 0)).toMatchObject({ problem: expect.stringMatching(/4 MB/) });
  });
  it("validates the upload body", () => {
    expect(imageUploadSchema.safeParse({ contentType: "image/gif", dataBase64: "A".repeat(200) }).success).toBe(false);
    expect(imageUploadSchema.safeParse({ contentType: "image/png", dataBase64: "A".repeat(200) }).success).toBe(true);
  });
});

describe("couriers", () => {
  it("builds a tracking link", () => {
    expect(trackingUrlFor("https://track.example/t/{ref}", "AB 12")).toBe("https://track.example/t/AB%2012");
    expect(trackingUrlFor("https://track.example/t/{ref}", undefined)).toBeNull();
    expect(trackingUrlFor("javascript:alert({ref})", "x")).toBeNull();
  });
  it("checks the link template", () => {
    expect(templateProblem(undefined)).toBeNull();
    expect(templateProblem("http://x/{ref}")).toMatch(/https/);
    expect(templateProblem("https://x/track")).toMatch(/\{ref\}/);
    expect(templateProblem("https://x/{ref}")).toBeNull();
  });
  it("makes distinct secrets", () => {
    expect(newCourierSecret()).not.toBe(newCourierSecret());
    expect(newCourierSecret()).toMatch(/^cs_[0-9a-f]{48}$/);
  });
  it("needs the patient's code before a partner can close an order", () => {
    expect(courierEventProblem({ trackingRef: "x", status: "DELIVERED", recipientName: "Ada" })).toMatch(/proof code/);
    expect(courierEventProblem({ trackingRef: "x", status: "DELIVERED", proofCode: "123456" })).toMatch(/name/);
    expect(courierEventProblem({ trackingRef: "x", status: "DELIVERED", proofCode: "123456", recipientName: "Ada" })).toBeNull();
    expect(courierEventProblem({ trackingRef: "x", status: "FAILED" })).toMatch(/reason/);
    expect(courierEventProblem({ trackingRef: "x", status: "OUT_FOR_DELIVERY" })).toBeNull();
  });
  it("verifies a signed partner report and refuses a wrong secret or an old one", () => {
    const body = JSON.stringify({ trackingRef: "T1", status: "OUT_FOR_DELIVERY" });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload("secret", ts, body);
    expect(sig).toBe(`sha256=${createHmac("sha256", "secret").update(`${ts}.${body}`).digest("hex")}`);
    expect(verifySignature("secret", ts, body, sig)).toBe(true);
    expect(verifySignature("other", ts, body, sig)).toBe(false);
    expect(verifySignature("secret", ts - 3600, body, signPayload("secret", ts - 3600, body))).toBe(false);
  });
  it("validates schemas", () => {
    expect(courierSchema.parse({ name: "Tunde" }).kind).toBe("OWN_RIDER");
    expect(courierEventSchema.safeParse({ trackingRef: "T", status: "DELIVERED", proofCode: "12" }).success).toBe(false);
    expect(deliverySchema.safeParse({ action: "dispatch", courierId: "c1", trackingRef: "T1" }).success).toBe(true);
    expect(dispenseSchema.safeParse({ handedToName: "Ada", collectorId: "NIN 123" }).success).toBe(true);
  });
});

describe("order text messages", () => {
  it("says a pickup is ready", () => expect(noticeMessage({ pharmacy: "MedPlus", event: "READY", fulfilment: "PICKUP" })).toMatch(/ready for pickup/));
  it("sends nothing for a delivery that is only packed", () => expect(noticeMessage({ pharmacy: "MedPlus", event: "READY", fulfilment: "DELIVERY" })).toBeNull());
  it("points to the app for the code and never prints it", () => {
    const m = noticeMessage({ pharmacy: "MedPlus", event: "DISPATCHED", fulfilment: "DELIVERY", courierName: "Tunde", trackingUrl: "https://t/1" })!;
    expect(m).toContain("Tunde");
    expect(m).toContain("https://t/1");
    expect(m).toMatch(/app for your delivery code/);
    expect(m).not.toMatch(/\d{6}/);
  });
});

describe("register query and rules", () => {
  it("defaults and limits", () => {
    expect(registerQuery.parse({}).limit).toBe(200);
    expect(registerQuery.safeParse({ from: "15-10-2026" }).success).toBe(false);
    expect(registerQuery.safeParse({ limit: "9999" }).success).toBe(false);
  });
  it("has no write route on the register", () => {
    const writes = ROUTE_RULES.filter((r) => r[1].includes("controlled-register") && r[0] !== "GET");
    expect(writes).toEqual([]);
  });
  it("keeps viewers from the write routes", () => {
    for (const [m, p, levels] of ROUTE_RULES) if (p.includes("couriers") && m !== "GET") expect(levels).not.toContain("VIEWER");
  });
});
