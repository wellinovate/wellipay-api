import { toMinorNumber } from "./money.js";

type TenantTerms = {
  planName: string | null;
  planMonthlyFeeMinor: bigint | null;
  platformFeePercent: { toString(): string } | null;
  planStartedAt: Date | null;
};

// What WelliPay actually holds about a provider's commercial terms. Fields stay
// null when nothing was recorded. The fee falls back to the platform default,
// and says so, because that default is what Paystack applies to new providers.
export function serializeSubscription(t: TenantTerms, defaultFeePercent: number) {
  const agreed = t.platformFeePercent === null ? null : Number(t.platformFeePercent.toString());
  return {
    planName: t.planName,
    monthlyFeeMinor: t.planMonthlyFeeMinor === null ? null : toMinorNumber(t.planMonthlyFeeMinor),
    startedAt: t.planStartedAt ? t.planStartedAt.toISOString() : null,
    platformFeePercent: agreed ?? defaultFeePercent,
    platformFeeSource: agreed === null ? "default" : "agreed",
  };
}
