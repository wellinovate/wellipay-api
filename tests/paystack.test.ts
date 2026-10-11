import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPaystackSignature, mapPaystackChannel, initializeTransaction, PaystackError } from "../src/lib/paystack.js";

const secret = "sk_test_example";
const body = JSON.stringify({ event: "charge.success", data: { reference: "wp_1", amount: 5000 } });
const sign = (b: string, s = secret) => createHmac("sha512", s).update(b).digest("hex");

describe("verifyPaystackSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyPaystackSignature(secret, body, sign(body))).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyPaystackSignature(secret, body.replace("5000", "1"), sign(body))).toBe(false);
  });
  it("rejects a signature made with another key", () => {
    expect(verifyPaystackSignature(secret, body, sign(body, "other"))).toBe(false);
  });
  it("rejects a missing or wrong-length header", () => {
    expect(verifyPaystackSignature(secret, body, undefined)).toBe(false);
    expect(verifyPaystackSignature(secret, body, "abc")).toBe(false);
  });
});

describe("mapPaystackChannel", () => {
  it("maps known channels and defaults to card", () => {
    expect(mapPaystackChannel("bank_transfer")).toBe("bank_transfer");
    expect(mapPaystackChannel("bank")).toBe("bank_transfer");
    expect(mapPaystackChannel("ussd")).toBe("ussd");
    expect(mapPaystackChannel("card")).toBe("card");
    expect(mapPaystackChannel("qr")).toBe("card");
  });
});

describe("initializeTransaction", () => {
  const ok = (data: unknown, status = 200) => (async () => new Response(JSON.stringify(data), { status })) as unknown as typeof fetch;

  it("sends kobo, NGN and the reference, and returns the checkout URL", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x" } }));
    }) as unknown as typeof fetch;
    const result = await initializeTransaction(secret, { email: "a@b.com", amountMinor: 48150, reference: "wp_1" }, fake);
    expect(result.authorizationUrl).toBe("https://checkout.paystack.com/x");
    expect(sent!.url).toBe("https://api.paystack.co/transaction/initialize");
    const payload = JSON.parse(sent!.init.body as string);
    expect(payload).toMatchObject({ amount: 48150, currency: "NGN", reference: "wp_1", email: "a@b.com" });
    expect((sent!.init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${secret}`);
  });

  it("throws PaystackError with Paystack's message on failure", async () => {
    await expect(
      initializeTransaction(secret, { email: "a@b.com", amountMinor: 100, reference: "r" }, ok({ status: false, message: "Invalid key" }, 401))
    ).rejects.toThrow(new PaystackError("Invalid key"));
  });
});
