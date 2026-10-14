import { z } from "zod";

export const createPatientRecordSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(160).optional(),
  facilityRef: z.string().trim().min(1).max(120).optional(),
  // Optional. When left out the API assigns one.
  patientRef: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/, "patientRef may use letters, digits, dot, dash and underscore.").optional(),
});

export type CreatePatientRecordInput = z.infer<typeof createPatientRecordSchema>;

export const listPatientRecordsQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
