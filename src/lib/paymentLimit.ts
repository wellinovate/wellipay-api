// A payment cannot be more than what is still owed on the invoice.
// Returns a message when it is, or null when the payment can be recorded.
export function paymentProblem(amountMinor: bigint, invoiceAmountMinor: bigint, paidMinor: bigint, status: string): string | null {
  if (status === "CANCELLED") return "This invoice is cancelled.";
  const balance = invoiceAmountMinor - paidMinor;
  if (balance <= 0n) return "This invoice is already paid in full.";
  if (amountMinor > balance) return `The payment is more than the balance. ${balance.toString()} kobo is still owed.`;
  return null;
}
