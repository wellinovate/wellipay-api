import { z } from "zod";

// Creates a staff directory entry — an invite record, not an account. See
// the Staff model's comment: there's no per-staff login here, so `role` is
// a free-text label the caller supplies rather than a fixed enum enforced
// against any endpoint.
export const createStaffSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  role: z.string().min(1).max(60),
  branch: z.string().max(80).optional(),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const listStaffQuerySchema = z.object({
  status: z.enum(["ACTIVE", "DEACTIVATED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

export const updateStaffStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DEACTIVATED"]),
});
