import { z } from "zod";

// Pagination shape shared by every /patient/* list route. No facilityRef
// filter here (unlike the matching /provider/* list schemas) — a patient
// token is already scoped to exactly one patientRef, so there is nothing
// left for the caller to narrow by.
export const patientListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const patientListInvoicesQuerySchema = patientListQuerySchema.extend({
  status: z.enum(["OPEN", "PARTIALLY_PAID", "PAID", "CANCELLED"]).optional(),
});

// The one patient-initiated write this MVP allows. Per
// wellipaypro/docs/mobile-app-integration.md, payment/contribution state
// stays provider/processor-authoritative — a patient can never mark
// something paid. Accepting a cost estimate is different: it's the
// patient's own decision, and provider staff have already communicated
// the invoiceId/estimateRevision/policyVersion/payerSplit to them (by
// phone, in person, or in a future provider-side "propose estimate" flow
// not built yet). This route just records that the patient, not staff,
// was the one who accepted it — facilityRef and patientRef are taken from
// the invoice and the caller's token, never from the request body.
export const patientAcceptConsentSchema = z.object({
  providerConsentRef: z.string().min(1),
  invoiceId: z.string().min(1),
  estimateRevision: z.string().min(1),
  policyVersion: z.string().min(1),
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

export type PatientAcceptConsentInput = z.infer<typeof patientAcceptConsentSchema>;
