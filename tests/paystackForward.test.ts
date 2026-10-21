import { describe, it, expect } from "vitest";
import { forwardPaystackEvent, isForwardedReference } from "../src/lib/paystackForward.js";

describe("isForwardedReference", () => {
  it("matches booking and pharmacy references only", () => {
    expect(isForwardedReference("wr-65f0c1")).toBe(true);
    expect(isForwardedReference("wo-65f0c1-ab12cd")).toBe(true);
    expect(isForwardedReference("wp_123")).toBe(false);
    expect(isForwardedReference("topup_1")).toBe(false);
    expect(isForwardedReference(undefined)).toBe(false);
  });
});

describe("forwardPaystackEvent", () => {
  it("sends the raw body and signature unchanged", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const raw = '{"event":"charge.success","data":{"reference":"wr-1"}}';
    expect(await forwardPaystackEvent("https://x.test/hook", raw, "sig123", fake)).toBe(true);
    expect(seen!.url).toBe("https://x.test/hook");
    expect(seen!.init.body).toBe(raw);
    expect((seen!.init.headers as Record<string, string>)["x-paystack-signature"]).toBe("sig123");
  });
  it("returns false on a non-2xx answer or a network error", async () => {
    const bad = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await forwardPaystackEvent("https://x.test", "{}", "s", bad)).toBe(false);
    expect(await forwardPaystackEvent("https://x.test", "{}", "s", boom)).toBe(false);
  });
});
