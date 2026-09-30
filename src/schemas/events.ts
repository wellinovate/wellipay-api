import { z } from "zod";

// Read-only view over the existing OutboxEvent table (see webhooks.ts /
// schema.prisma) — these rows already exist to drive outbound webhook
// delivery; this just exposes the same event log to the provider frontend
// as an in-app notification feed. No new write path, no new model.
export const listEventsQuerySchema = z.object({
  eventType: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
