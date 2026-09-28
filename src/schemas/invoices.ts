import { z } from "zod";

// Mirrors components.schemas.CreateInvoice in the OpenAPI contract exactly —
// same field names, same constraints — so the JSON shape needs no translation
// layer for a client generated straight from the .openapi.json.
export const createInvoiceSchema = z.object({
  providerInvoiceRef: z.string().max(80),
  facilityRef: z.string().max(80),
  patientRef: z.string().max(100),
  description: z.string().max(240),
  amountMinor: z.number().int().min(1),
  currency: z.literal("NGN"),
  dueAt: z.string().datetime().optional(),
  metadata: z.record(z.string().max(120)).refine((m) => Object.keys(m).length <= 20, "metadata may have at most 20 properties").optional(),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
