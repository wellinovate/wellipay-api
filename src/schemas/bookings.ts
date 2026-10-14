import { z } from "zod";

export const createBookingSchema = z
  .object({
    patientRef: z.string().trim().min(1).max(100),
    type: z.enum(["CENTRE_VISIT", "HOME_COLLECTION"]),
    scheduledAt: z.string().datetime(),
    address: z.string().trim().min(5).max(240).optional(),
    notes: z.string().trim().max(500).optional(),
    invoiceId: z.string().min(1).optional(),
  })
  .refine((v) => v.type !== "HOME_COLLECTION" || !!v.address, {
    message: "A home collection needs an address.",
    path: ["address"],
  });

export const updateBookingSchema = z
  .object({
    status: z.enum(["SAMPLE_COLLECTED", "PROCESSING", "READY", "CANCELLED"]).optional(),
    scheduledAt: z.string().datetime().optional(),
    address: z.string().trim().min(5).max(240).optional(),
    notes: z.string().trim().max(500).optional(),
    invoiceId: z.string().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");

export const listBookingsQuerySchema = z.object({
  status: z.enum(["BOOKED", "SAMPLE_COLLECTED", "PROCESSING", "READY", "CANCELLED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
