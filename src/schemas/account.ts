import { z } from "zod";

// null removes the limit, so one approver is enough again.
export const setRefundLimitSchema = z.object({
  limitMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type SetRefundLimitInput = z.infer<typeof setRefundLimitSchema>;
