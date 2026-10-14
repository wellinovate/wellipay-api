export const MIN_TOPUP_MINOR = 10_000n; // 100 naira
export const MAX_TOPUP_MINOR = 50_000_000n; // 500,000 naira
export const MAX_BALANCE_MINOR = 200_000_000n; // 2,000,000 naira

// Why a top-up cannot go ahead, or null.
export function topUpProblem(amount: bigint, balance: bigint): string | null {
  if (amount < MIN_TOPUP_MINOR) return "The smallest top-up is ₦100.";
  if (amount > MAX_TOPUP_MINOR) return "The largest single top-up is ₦500,000.";
  if (balance + amount > MAX_BALANCE_MINOR) return "A wallet cannot hold more than ₦2,000,000.";
  return null;
}

// Why a wallet payment cannot go ahead, or null. `outstanding` is the bill's balance.
export function walletPayProblem(amount: bigint, balance: bigint, outstanding: bigint): string | null {
  if (outstanding <= 0n) return "This bill has nothing left to pay.";
  if (amount < 100n) return "The smallest payment is 100 kobo.";
  if (amount > outstanding) return "The amount is more than the balance of the bill.";
  if (amount > balance) return "Your wallet balance is too low.";
  return null;
}

export function walletView(balanceMinor: bigint) {
  return { balanceMinor: Number(balanceMinor), currency: "NGN", maxTopUpMinor: Number(MAX_TOPUP_MINOR), minTopUpMinor: Number(MIN_TOPUP_MINOR) };
}
