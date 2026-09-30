import { describe, it, expect } from "vitest";
import { toMinorBigInt, toMinorNumber } from "../src/lib/money.js";

// Money bugs are the worst kind here — this is the boundary between the
// JSON amounts the frontend sends and the bigint the database stores. A
// wrong conversion either under- or over-charges someone.
describe("toMinorBigInt", () => {
  it("converts a non-negative integer to a bigint", () => {
    expect(toMinorBigInt(485000)).toBe(485000n);
    expect(toMinorBigInt(0)).toBe(0n);
  });

  it("rejects a non-integer amount", () => {
    expect(() => toMinorBigInt(485000.5)).toThrow(/non-negative integer/);
  });

  it("rejects a negative amount", () => {
    expect(() => toMinorBigInt(-1)).toThrow(/non-negative integer/);
  });

  it("rejects NaN", () => {
    expect(() => toMinorBigInt(Number.NaN)).toThrow();
  });
});

describe("toMinorNumber", () => {
  it("converts a bigint back to a number", () => {
    expect(toMinorNumber(485000n)).toBe(485000);
    expect(toMinorNumber(0n)).toBe(0);
  });

  it("round-trips through both directions", () => {
    const amounts = [0, 1, 100, 48150, 12_000_000];
    for (const amount of amounts) {
      expect(toMinorNumber(toMinorBigInt(amount))).toBe(amount);
    }
  });
});
