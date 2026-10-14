import { z } from "zod";

export const createFamilyFundingRequestSchema = z.object({
  providerRequestRef: z.string().max(80),
  invoiceId: z.string().min(1),
  patientRef: z.string().min(1),
  facilityRef: z.string().min(1),
  currency: z.literal("NGN"),
  expiresAt: z.string().datetime().optional(),
  contributions: z
    .array(z.object({ sponsorRef: z.string().max(100), amountMinor: z.number().int().min(1) }))
    .min(1)
    .max(20),
});

export type CreateFamilyFundingRequestInput = z.infer<typeof createFamilyFundingRequestSchema>;

export const listFamilyFundingQuerySchema = z.object({
  invoiceId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
