import { z } from "zod";

export const createWebhookEndpointSchema = z.object({
  url: z.string().url().max(500),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;
