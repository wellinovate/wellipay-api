import { z } from "zod";

export const createRecordConnectionSchema = z.object({
  kind: z.enum(["WELLIRECORD", "EXTERNAL_SYSTEM", "PROVIDER_PATIENT_NUMBER"]),
  // Required for EXTERNAL_SYSTEM. WELLIRECORD uses the "wellirecord" integration when none is named.
  integrationKey: z.string().trim().min(2).max(31).optional(),
  reference: z.string().trim().min(1).max(80),
});
export type CreateRecordConnectionInput = z.infer<typeof createRecordConnectionSchema>;

export const confirmRecordConnectionSchema = z.object({
  code: z.string().trim().min(1).max(12),
});

export const recordConnectionDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(300).optional(),
});
export type RecordConnectionDecisionInput = z.infer<typeof recordConnectionDecisionSchema>;

export const providerRevokeSchema = z.object({
  note: z.string().trim().max(300).optional(),
});

export const providerConnectionsQuerySchema = z.object({
  status: z.enum(["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVOKED", "EXPIRED"]).optional(),
  kind: z.enum(["WELLIRECORD", "EXTERNAL_SYSTEM", "PROVIDER_PATIENT_NUMBER"]).optional(),
});
