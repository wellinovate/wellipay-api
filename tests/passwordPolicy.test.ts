import { describe, it, expect } from "vitest";
import { passwordProblem } from "../src/lib/passwordPolicy.js";

describe("passwordProblem", () => {
  it("accepts a long unrelated passphrase", () => {
    expect(passwordProblem("copper-lantern-orbit-seven", "a@b.ng")).toBeNull();
  });
  it("rejects short passwords", () => {
    expect(passwordProblem("Short1!x")).toMatch(/at least 12/);
  });
  it("rejects the guessable ones seen in practice", () => {
    expect(passwordProblem("WelliPass123456")).not.toBeNull();
    expect(passwordProblem("Password12345678")).not.toBeNull();
  });
  it("rejects a repeated character", () => {
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).not.toBeNull();
  });
  it("rejects a password containing the email name", () => {
    expect(passwordProblem("my-talk2jaywin-secret", "talk2jaywin@gmail.com")).toMatch(/email name/);
  });
});
