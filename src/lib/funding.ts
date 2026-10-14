export interface ContributionLike {
  id: string;
  amountMinor: bigint;
  status: string;
}

// After one contribution is paid, works out how much of a funding request is
// covered. The request is FUNDED once every pledge is paid, otherwise OPEN.
// `paidId` counts as paid even if its row still reads PENDING.
export function fundingTotals(contributions: ContributionLike[], paidId: string, paidAmountMinor: bigint) {
  const totalPledged = contributions.reduce((sum, c) => sum + c.amountMinor, 0n);
  const totalPaid = contributions.reduce(
    (sum, c) => sum + (c.id === paidId ? paidAmountMinor : c.status === "PAID" ? c.amountMinor : 0n),
    0n
  );
  return { totalPledged, totalPaid, status: totalPaid >= totalPledged ? ("FUNDED" as const) : ("OPEN" as const) };
}
