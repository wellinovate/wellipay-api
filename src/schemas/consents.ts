import { z } from "zod";

export const financialConsentRequestSchema = z.object({
  providerConsentRef: z.string().min(1),
  facilityRef: z.string().min(1),
  patientRef: z.string().min(1),
  invoiceId: z.string().min(1),
  estimateRevision: z.string().min(1),
  policyVersion: z.string().min(1),
  acceptedAt: z.string().datetime(),
  actorRef: z.string().optional(),
  payerSplit: z
    .array(
      z.object({
        payerType: z.enum(["PATIENT", "HMO", "INSURANCE", "FAMILY", "FINANCING", "CORPORATE"]),
        payerRef: z.string().optional(),
        amountMinor: z.number().int().min(0),
        currency: z.literal("NGN"),
      })
    )
    .min(1)
    .max(10),
});

export type FinancialConsentRequestInput = z.infer<typeof financialConsentRequestSchema>;
