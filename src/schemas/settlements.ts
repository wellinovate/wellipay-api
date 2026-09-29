import { z } from "zod";

// Batches every successful, not-yet-settled Payment at one facility into a
// settlement run. See the Settlement model's comment: there's no real
// gateway/bank payout behind this, so this is a batching record, not proof
// money moved.
export const createSettlementSchema = z.object({
  facilityRef: z.string().min(1).max(80),
});

export type CreateSettlementInput = z.infer<typeof createSettlementSchema>;

export const listSettlementsQuerySchema = z.object({
  status: z.enum(["PENDING", "SETTLED"]).optional(),
  facilityRef: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
