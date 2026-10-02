import { z } from "zod";

// Shared fields for creating an HMO policy card, whichever side is
// entering it (patient self-reporting their card in the app, or provider
// staff recording it during registration/verification).
const hmoPolicyFieldsSchema = z.object({
  provider: z.string().min(1).max(120),
  policyNo: z.string().min(1).max(60),
  enrolleeName: z.string().min(1).max(120),
  planTier: z.string().min(1).max(60),
  coPayPercent: z.number().int().min(0).max(100),
  annualLimitMinor: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
  expiryDate: z.string().datetime().optional(),
});

// Patient self-service: POST /patient/hmo-policies. patientRef comes from
// the caller's token, never the body — same rule as
// POST /patient/financial-consents.
export const patientCreateHmoPolicySchema = hmoPolicyFieldsSchema;
export type PatientCreateHmoPolicyInput = z.infer<typeof patientCreateHmoPolicySchema>;

// Provider/staff: POST /provider/hmo-policies. Staff record which patient
// the card belongs to explicitly, since they're entering it on the
// patient's behalf (at the desk, from a photographed card, etc).
export const providerCreateHmoPolicySchema = hmoPolicyFieldsSchema.extend({
  patientRef: z.string().min(1),
});
export type ProviderCreateHmoPolicyInput = z.infer<typeof providerCreateHmoPolicySchema>;

export const listHmoPoliciesQuerySchema = z.object({
  patientRef: z.string().optional(),
  status: z.enum(["ACTIVE", "PENDING", "EXPIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const patientListHmoPoliciesQuerySchema = z.object({
  status: z.enum(["ACTIVE", "PENDING", "EXPIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// Staff-only adjustments: deactivate/expire a card, correct its co-pay or
// limit, or move usedAmountMinor when a claim settles against it (manual
// for now — see the schema comment on HmoPolicy about automatic write-back
// being a follow-up).
export const updateHmoPolicySchema = z
  .object({
    status: z.enum(["ACTIVE", "PENDING", "EXPIRED"]).optional(),
    coPayPercent: z.number().int().min(0).max(100).optional(),
    annualLimitMinor: z.number().int().min(0).optional(),
    usedAmountMinor: z.number().int().min(0).optional(),
    expiryDate: z.string().datetime().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });
export type UpdateHmoPolicyInput = z.infer<typeof updateHmoPolicySchema>;
