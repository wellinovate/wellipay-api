import { z } from "zod";

// Ingests one inbound transaction the bank/gateway reported without a
// providerPaymentRef we could tie to an invoice automatically. In
// production this would arrive from a bank statement feed or a gateway
// webhook; for now the provider's own reconciliation desk (or, for this
// demo, the caller) records it directly.
export const createUnmatchedTransactionSchema = z.object({
  source: z.string().min(1).max(40),
  reference: z.string().max(120).optional(),
  amountMinor: z.number().int().min(1),
  currency: z.string().length(3).default("NGN"),
  receivedAt: z.string().datetime().optional(),
});

export type CreateUnmatchedTransactionInput = z.infer<typeof createUnmatchedTransactionSchema>;

export const listUnmatchedTransactionsQuerySchema = z.object({
  status: z.enum(["UNMATCHED", "MATCHED", "EXCEPTION"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// Matching creates a real Payment against the named invoice — the same
// state change a normal POST /provider/payments makes — and links this
// transaction to it. There's no amount field here: the transaction's own
// amountMinor is what gets paid, since matching means "this exact inbound
// transfer belongs to that invoice," not a partial allocation.
export const matchUnmatchedTransactionSchema = z.object({
  invoiceId: z.string().min(1),
});

export const flagUnmatchedTransactionExceptionSchema = z.object({
  note: z.string().max(300).optional(),
});
