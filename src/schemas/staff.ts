import { z } from "zod";

// Creates a staff directory entry — an invite record, not an account by
// itself. `role` stays a free-text label; there's still no per-role
// permission enforcement, only per-staff identity (see PATCH .../password
// and POST /staff/login below).
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

// Admin action (requires the write scope, same as invite/deactivate) that
// sets or resets a staff member's login password. There's no "forgot
// password" email flow yet — a manager sets it here, in person or over a
// trusted channel, and tells the staff member.
export const setStaffPasswordSchema = z.object({
  password: z.string().min(8).max(200),
});
