import { describe, it, expect } from "vitest";
import { launchWarnings } from "../src/lib/launchChecks.js";

const live = { NODE_ENV: "production", CORS_ORIGIN: "https://wellipaypro.onrender.com", CLERK_SECRET_KEY: "sk_live_x", PAYSTACK_SECRET_KEY: "sk_live_y", ALLOW_PUBLIC_FRONTEND_TOKEN: "false" };

describe("launchWarnings", () => {
  it("is quiet for a correct live setup and for development", () => {
    expect(launchWarnings(live)).toEqual([]);
    expect(launchWarnings({ ...live, NODE_ENV: "development", CORS_ORIGIN: "*", PAYSTACK_SECRET_KEY: "sk_test_y" })).toEqual([]);
  });
  it("names each risky setting without printing a key", () => {
    const w = launchWarnings({ NODE_ENV: "production", CORS_ORIGIN: "*", CLERK_SECRET_KEY: "sk_test_aaa", PAYSTACK_SECRET_KEY: "sk_test_bbb", ALLOW_PUBLIC_FRONTEND_TOKEN: "true" });
    expect(w).toHaveLength(4);
    const all = w.join(" ");
    expect(all).not.toContain("aaa");
    expect(all).not.toContain("bbb");
  });
});
