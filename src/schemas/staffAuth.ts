import { z } from "zod";

export const staffLoginSchema = z.object({
  email: z.string().email().max(160),
  password: z.string().min(1).max(200),
});
