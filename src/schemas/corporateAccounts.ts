import { z } from "zod";

const name = z.string().trim().min(2).max(120);

export const createCorporateAccountSchema = z.object({
  name,
  contactName: z.string().trim().min(2).max(120).optional(),
  email: z.string().trim().email().max(160).optional(),
  phone: z.string().trim().max(30).optional(),
});

export const updateCorporateAccountSchema = z
  .object({
    name: name.optional(),
    contactName: z.string().trim().min(2).max(120).nullable().optional(),
    email: z.string().trim().email().max(160).nullable().optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Send at least one field to change.");
