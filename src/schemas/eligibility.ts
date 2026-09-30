import { z } from "zod";

export const eligibilityCheckRequestSchema = z.object({
  providerRequestRef: z.string().min(1),
  facilityRef: z.string().min(1),
  patientRef: z.string().min(1),
  payerRef: z.string().min(1),
  serviceCodes: z.array(z.string().max(80)).min(1).max(100),
  requestedAt: z.string().datetime(),
  amount: z.object({ amountMinor: z.number().int().min(0), currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
});

export type EligibilityCheckRequestInput = z.infer<typeof eligibilityCheckRequestSchema>;

export const listEligibilityChecksQuerySchema = z.object({
  facilityRef: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
