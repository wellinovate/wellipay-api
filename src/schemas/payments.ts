import { z } from "zod";

// Records one payment collection event against an existing invoice. Not part
// of the original OpenAPI contract (which only ever asked for a running
// paidAmountMinor on the invoice) — added so the provider frontend has a real
// transaction log to show instead of a mock one. Field names follow the same
// conventions as createInvoiceSchema.
export const createPaymentSchema = z.object({
  providerPaymentRef: z.string().max(80),
  invoiceId: z.string().min(1),
  channel: z.enum(["card", "bank_transfer", "ussd", "cash", "hmo_direct", "wellipass"]),
  reference: z.string().max(120).optional(),
  amountMinor: z.number().int().min(1),
  currency: z.literal("NGN"),
  occurredAt: z.string().datetime().optional(),
  // Set when this payment is a family sponsor settling their pledged share
  // of a family-funding request (see POST /provider/family-funding-requests).
  // Without this, a sponsor's payment updated the invoice but had no way to
  // mark their FundingContribution paid or advance the request's
  // fundedAmountMinor — the two ledgers silently drifted apart.
  fundingContributionId: z.string().min(1).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsQuerySchema = z.object({
  facilityRef: z.string().max(80).optional(),
  patientRef: z.string().max(100).optional(),
  invoiceId: z.string().optional(),
  status: z.enum(["SUCCESS", "FAILED", "PENDING"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
