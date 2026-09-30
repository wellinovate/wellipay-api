import { z } from "zod";

// Records that a named lender covered an invoice's remaining balance
// upfront. See FinancingRecord's model comment: there's no real lender
// integration behind this — it's a fact the facility enters, not a credit
// check or disbursement callback.
export const createFinancingRecordSchema = z.object({
  invoiceId: z.string().min(1),
  lenderName: z.string().min(1).max(120),
  termMonths: z.number().int().min(1).max(60).optional(),
});

export type CreateFinancingRecordInput = z.infer<typeof createFinancingRecordSchema>;

export const listFinancingRecordsQuerySchema = z.object({
  invoiceId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
