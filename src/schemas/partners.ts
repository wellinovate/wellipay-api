import { z } from "zod";

export const createPartnerSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["LABORATORY", "PHARMACY", "IMAGING", "SPECIALIST", "OTHER"]),
});

export type CreatePartnerInput = z.infer<typeof createPartnerSchema>;

export const listPartnersQuerySchema = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const createReferralSchema = z.object({
  partnerId: z.string().min(1),
  facilityRef: z.string().min(1),
  patientRef: z.string().min(1),
  description: z.string().min(1).max(300),
});

export type CreateReferralInput = z.infer<typeof createReferralSchema>;

export const listReferralsQuerySchema = z.object({
  status: z.enum(["SENT", "COMPLETED"]).optional(),
  partnerId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const updateReferralStatusSchema = z.object({
  status: z.literal("COMPLETED"),
});
