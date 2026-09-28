// Amounts are always integer minor units (kobo for NGN) end to end — never
// a float. See "Amounts are integer minor units" in the contract doc.
// BigInt is used at the Prisma/DB layer because Postgres bigint round-trips
// as BigInt in the JS client; these helpers convert at the JSON boundary,
// where a number is safe for any realistic invoice amount (< 2^53).

export function toMinorNumber(value: bigint): number {
  return Number(value);
}

export function toMinorBigInt(value: number): bigint {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("amountMinor must be a non-negative integer");
  }
  return BigInt(value);
}
