import { z } from "zod";

export const PROVIDER_TYPES = ["HOSPITAL", "DIAGNOSTIC_LAB", "PHARMACY", "INDEPENDENT_PRACTITIONER"] as const;

const nigerianPhone = /^(\+234|0)[789][01]\d{8}$/;

export const createApplicationSchema = z.object({
  businessName: z.string().trim().min(2).max(160),
  providerType: z.enum(PROVIDER_TYPES),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(160),
  contactPhone: z.string().trim().regex(nigerianPhone, "Phone must be a Nigerian number, such as 08012345678."),
  address: z.string().trim().max(240).optional(),
  // Facility or pharmacy registration number. Reviewed by hand.
  licenseNumber: z.string().trim().max(80).optional(),
  bankCode: z.string().trim().regex(/^\d{3,6}$/, "bankCode must be the bank's numeric code."),
  accountNumber: z.string().trim().regex(/^\d{10}$/, "Account number must be 10 digits."),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
