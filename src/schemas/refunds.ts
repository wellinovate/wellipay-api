import { z } from "zod";

// Requests a full or partial reversal of an existing SUCCESS payment. The
// payment row is never edited — approving the request instead reverses its
// effect on the invoice (see routes/refunds.ts).
export const createRefundSchema = z.object({
  providerRefundRef: z.string().max(80),
  paymentId: z.string().min(1),
  amountMinor: z.number().int().min(1),
  reason: z.string().min(1).max(300),
  requestedBy: z.string().min(1).max(120),
});

export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export const listRefundsQuerySchema = z.object({
  paymentId: z.string().optional(),
  invoiceId: z.string().optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// A refund can only be decided once — see the PENDING-only guard in the
// route. There is no partial-approval concept here (unlike claims):
// approving settles the refund's full requested amountMinor.
export const decideRefundSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  actor: z.string().min(1).max(120),
  note: z.string().max(300).optional(),
});

export type DecideRefundInput = z.infer<typeof decideRefundSchema>;
