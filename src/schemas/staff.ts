import { z } from "zod";
import { STAFF_ACCESS_LEVELS } from "../lib/permissions.js";
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "../lib/passwordPolicy.js";

// Creates a staff directory entry — an invite record, not an account by
// itself. `role` is a free-text job title; what the person may do comes from
// `accessLevel` (default CASHIER, the least-privileged level that can work).
export const createStaffSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  role: z.string().min(1).max(60),
  branch: z.string().max(80).optional(),
  accessLevel: z.enum(STAFF_ACCESS_LEVELS).default("CASHIER"),
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
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

export const updateStaffAccessLevelSchema = z.object({
  accessLevel: z.enum(STAFF_ACCESS_LEVELS),
});
