import { z } from "zod";

// No pagination here deliberately: an "episode" groups a handful of a
// patient's own invoices (see the comment on episodes.ts), so the full
// set is always small — unlike the flat invoice/claim lists elsewhere.
export const patientListEpisodesQuerySchema = z.object({});

export const listEpisodesQuerySchema = z.object({
  patientRef: z.string().optional(),
  facilityRef: z.string().optional(),
});
