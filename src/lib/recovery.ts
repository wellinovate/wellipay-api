// A payment made through Paystack for a provider that has a subaccount settles
// to the provider. Paystack takes a refund from the platform's own balance, not
// from the subaccount, so after the refund the provider owes the platform.
export function refundIsRecoverable(providerPaymentRef: string, subaccountCode: string | null | undefined): boolean {
  return providerPaymentRef.startsWith("paystack_") && !!subaccountCode;
}
