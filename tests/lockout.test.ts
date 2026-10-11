import { describe, it, expect } from "vitest";
import { afterFailure, isLocked, minutesRemaining, MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES, clearedState } from "../src/lib/lockout.js";

const now = new Date("2026-10-11T22:00:00Z");

describe("login lockout", () => {
  it("counts failures without locking before the limit", () => {
    let state = clearedState;
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      state = afterFailure(state, now);
      expect(state.failedLoginCount).toBe(i);
      expect(isLocked(state, now)).toBe(false);
    }
  });

  it("locks on the Nth failure for the lockout window", () => {
    let state = clearedState;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) state = afterFailure(state, now);
    expect(isLocked(state, now)).toBe(true);
    expect(minutesRemaining(state, now)).toBe(LOCKOUT_MINUTES);
  });

  it("unlocks after the window and starts a fresh count", () => {
    let state = clearedState;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) state = afterFailure(state, now);
    const later = new Date(now.getTime() + (LOCKOUT_MINUTES + 1) * 60000);
    expect(isLocked(state, later)).toBe(false);
    const next = afterFailure(state, later);
    expect(next.failedLoginCount).toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it("reports at least one minute remaining while locked", () => {
    const state = { failedLoginCount: 5, lockedUntil: new Date(now.getTime() + 5000) };
    expect(minutesRemaining(state, now)).toBe(1);
  });
});
