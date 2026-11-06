import { describe, it, expect } from "vitest";
import { clerkKeyWarning } from "../src/lib/clerk.js";

describe("clerkKeyWarning", () => {
  it("warns about a test key in production without printing it", () => {
    const w = clerkKeyWarning("sk_test_abc123secret", true);
    expect(w).toContain("sk_test_");
    expect(w).not.toContain("abc123secret");
  });
  it("is quiet for a live key, a missing key, or development", () => {
    expect(clerkKeyWarning("sk_live_abc", true)).toBeUndefined();
    expect(clerkKeyWarning(undefined, true)).toBeUndefined();
    expect(clerkKeyWarning("sk_test_abc", false)).toBeUndefined();
  });
});
