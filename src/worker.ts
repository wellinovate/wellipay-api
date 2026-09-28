import type { FastifyBaseLogger } from "fastify";
import { prisma } from "./lib/prisma.js";
import { deliverPendingEvents } from "./lib/webhooks.js";

const POLL_INTERVAL_MS = 5000;

/**
 * In-process outbox poller. Fine for a single instance; if this service
 * scales to multiple replicas, move this to a dedicated worker process (or
 * a Render Cron Job / Background Worker) so events aren't attempted
 * redundantly by every replica. The DB-level uniqueness on eventId plus the
 * status column makes that safe either way — worst case is a wasted HTTP
 * call, never a duplicate delivery the receiver can't detect (eventId
 * dedup is required on the receiving side per the contract).
 */
export function startWebhookWorker(log: FastifyBaseLogger): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const delivered = await deliverPendingEvents(prisma);
      if (delivered > 0) log.info({ delivered }, "Webhook events delivered");
    } catch (err) {
      log.error({ err }, "Webhook delivery tick failed");
    } finally {
      if (!stopped) setTimeout(tick, POLL_INTERVAL_MS);
    }
  };

  void tick();
  return () => {
    stopped = true;
  };
}
