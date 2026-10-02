import { z } from "zod";

// Only claims with a decision (an approved amount) have anything to
// reconcile — DRAFT/SUBMITTED/REJECTED claims are excluded by the route
// itself, not this schema.
export const patientListReconciliationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const listReconciliationQuerySchema = z.object({
  facilityRef: z.string().optional(),
  patientRef: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
