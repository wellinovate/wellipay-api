export type SettlementState = "AWAITING" | "PROCESSING" | "SETTLED" | "FAILED";

// Paystack's payout status -> the state shown against each payment.
export function mapGatewaySettlementStatus(status: string | null | undefined): Exclude<SettlementState, "AWAITING"> {
  const s = (status ?? "").toLowerCase();
  if (s === "success" || s === "settled" || s === "paid") return "SETTLED";
  if (s === "failed" || s === "reversed") return "FAILED";
  return "PROCESSING";
}

export interface SettlementRow {
  amountMinor: bigint;
  feesMinor: bigint | null;
  settlementStatus: string;
}

// What the provider takes home from one payment: the amount less Paystack's fee.
export function netMinor(row: { amountMinor: bigint; feesMinor: bigint | null }): bigint {
  const net = row.amountMinor - (row.feesMinor ?? 0n);
  return net > 0n ? net : 0n;
}

export interface SettlementSummary {
  awaitingMinor: number;
  processingMinor: number;
  settledMinor: number;
  failedMinor: number;
  feesMinor: number;
}

// Totals of successful payments by where the money is. Amounts are net of fees.
export function settlementSummary(rows: SettlementRow[]): SettlementSummary {
  const out = { awaiting: 0n, processing: 0n, settled: 0n, failed: 0n, fees: 0n };
  for (const r of rows) {
    const net = netMinor(r);
    out.fees += r.feesMinor ?? 0n;
    if (r.settlementStatus === "SETTLED") out.settled += net;
    else if (r.settlementStatus === "PROCESSING") out.processing += net;
    else if (r.settlementStatus === "FAILED") out.failed += net;
    else out.awaiting += net;
  }
  return {
    awaitingMinor: Number(out.awaiting),
    processingMinor: Number(out.processing),
    settledMinor: Number(out.settled),
    failedMinor: Number(out.failed),
    feesMinor: Number(out.fees),
  };
}

// Which of our references appear in a payout, and at what state. Settled wins
// over processing, so a later page cannot move a payment backwards.
const RANK: Record<string, number> = { AWAITING: 0, PROCESSING: 1, FAILED: 2, SETTLED: 3 };

export function shouldAdvance(current: string, next: string): boolean {
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
}
