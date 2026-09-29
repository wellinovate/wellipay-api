import { z } from "zod";

// Splits an invoice's remaining balance into equal monthly installments,
// starting one month from now by default. See the PaymentPlan model's
// comment for what's a real rule vs. an invented placeholder (even split,
// monthly-only, no interest).
export const createPaymentPlanSchema = z.object({
  invoiceId: z.string().min(1),
  installmentCount: z.number().int().min(2).max(24),
  startAt: z.string().datetime().optional(),
});

export type CreatePaymentPlanInput = z.infer<typeof createPaymentPlanSchema>;

export const listPaymentPlansQuerySchema = z.object({
  status: z.enum(["ACTIVE", "COMPLETED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// Records one installment as paid. There's no partial-installment payment —
// same "this exact amount, in full" semantics as reconciliation matching —
// so there's no amount field; the installment's own amountMinor is what
// gets paid.
export const payInstallmentSchema = z.object({
  channel: z.string().min(1).max(40).default("cash"),
  reference: z.string().max(120).optional(),
});
