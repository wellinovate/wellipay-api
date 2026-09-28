import { z } from "zod";

// There is no Patient model in this service — per the schema's own data
// rules, patientRef is an opaque reference and no PII (name, phone, HMO
// plan, ...) is ever stored here. This endpoint derives a patient list from
// the invoices already on file: one row per distinct patientRef seen for
// the tenant, with aggregate billing activity. A caller that needs the
// human-facing identity behind a patientRef resolves it against whichever
// system issued that reference (e.g. WelliRecord) — not this API.
export const listPatientsQuerySchema = z.object({
  facilityRef: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
