import { z } from "zod";

// Files an HMO/insurer claim against an existing invoice. A claim starts in
// DRAFT — it only becomes visible to the payer once explicitly submitted
// (see updateClaimStatusSchema below).
export const createClaimSchema = z.object({
  providerClaimRef: z.string().max(80),
  invoiceId: z.string().min(1),
  payerRef: z.string().max(80),
  amountMinor: z.number().int().min(1),
  currency: z.literal("NGN"),
});

export type CreateClaimInput = z.infer<typeof createClaimSchema>;

export const listClaimsQuerySchema = z.object({
  facilityRef: z.string().max(80).optional(),
  patientRef: z.string().max(100).optional(),
  invoiceId: z.string().optional(),
  payerRef: z.string().max(80).optional(),
  status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

// Drives the claim lifecycle: DRAFT -> SUBMITTED -> (APPROVED |
// PARTIALLY_APPROVED | REJECTED), with REJECTED -> SUBMITTED allowed as a
// resubmission after correction. The route enforces which transitions are
// legal from a claim's current status; this schema only shapes the request.
export const updateClaimStatusSchema = z.object({
  status: z.enum(["SUBMITTED", "APPROVED", "PARTIALLY_APPROVED", "REJECTED"]),
  approvedAmountMinor: z.number().int().min(1).optional(),
  reason: z.string().max(300).optional(),
});

export type UpdateClaimStatusInput = z.infer<typeof updateClaimStatusSchema>;
