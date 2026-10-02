import { z } from "zod";

// Patient requests a pre-authorization for a planned procedure against one
// of their own HMO policies. hmoPolicyId must belong to the caller — the
// route checks that, this schema just validates shape.
export const patientCreatePreAuthSchema = z.object({
  hmoPolicyId: z.string().min(1),
  facilityRef: z.string().min(1),
  procedure: z.string().min(1).max(200),
  estimatedCostMinor: z.number().int().min(1),
});
export type PatientCreatePreAuthInput = z.infer<typeof patientCreatePreAuthSchema>;

export const patientListPreAuthQuerySchema = z.object({
  status: z.enum(["APPROVED", "IN_REVIEW", "DECLINED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const listPreAuthQuerySchema = z.object({
  patientRef: z.string().optional(),
  hmoPolicyId: z.string().optional(),
  status: z.enum(["APPROVED", "IN_REVIEW", "DECLINED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

// Staff-only override — e.g. a human reviewer at the HMO or facility
// deciding a case the automatic stand-in flagged IN_REVIEW, once that
// exists. Today every request is auto-APPROVED (see the schema comment on
// PreAuthorization), so this exists for when a real payer integration
// lands.
export const updatePreAuthSchema = z
  .object({
    status: z.enum(["APPROVED", "IN_REVIEW", "DECLINED"]).optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });
export type UpdatePreAuthInput = z.infer<typeof updatePreAuthSchema>;
