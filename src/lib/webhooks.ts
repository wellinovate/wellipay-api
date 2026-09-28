import { createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { env } from "../env.js";

export type TransactionClient = Prisma.TransactionClient;

// Implements the contract's webhook rules exactly:
//   "HMAC-SHA256 over the exact raw request body with a timestamped
//   signature header. Reject stale timestamps, compare signatures in
//   constant time, and deduplicate event IDs. Retry transient non-2xx
//   deliveries with bounded exponential backoff; dead-letter after the
//   agreed retry window."
//
// Sending side lives here. The provider backend receiving these events
// should use verifySignature() with its own copy of the shared secret —
// this module is written so that function can be lifted into a receiver
// unchanged.

const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, timestamp: number, rawBody: string): string {
  const base = `${timestamp}.${rawBody}`;
  const digest = createHmac("sha256", secret).update(base).digest("hex");
  return `sha256=${digest}`;
}

export function verifySignature(secret: string, timestamp: number, rawBody: string, signatureHeader: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = signPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Queues a ProviderEvent in the same transaction as the state change that caused it. */
export function queueEvent(
  tx: TransactionClient,
  params: { tenantId: string; eventType: string; resourceRef: string; data: Record<string, unknown> }
) {
  return tx.outboxEvent.create({
    data: {
      tenantId: params.tenantId,
      eventType: params.eventType,
      resourceRef: params.resourceRef,
      data: params.data,
    },
  });
}

function backoffSeconds(attempt: number): number {
  // 1, 2, 4, 8, 16, 32, 64, 128... capped at ~30 min
  return Math.min(30 * 60, 2 ** attempt);
}

/**
 * Delivers one pending outbox event to every active webhook endpoint for its
 * tenant. Call this from a worker loop (see src/worker.ts). Not wired to any
 * HTTP route — outbound delivery is infrastructure, not a request handler.
 */
export async function deliverPendingEvents(prisma: PrismaClient, fetchImpl: typeof fetch = fetch): Promise<number> {
  const due = await prisma.outboxEvent.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
    take: 25,
    orderBy: { occurredAt: "asc" },
  });

  let delivered = 0;
  for (const event of due) {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId: event.tenantId, active: true } });
    if (endpoints.length === 0) {
      // No receiver registered yet — leave PENDING; a registered endpoint
      // will pick it up on the next poll once configured. Avoid dead-lettering
      // solely for "nobody's listening yet."
      continue;
    }

    const envelope = {
      eventId: event.eventId,
      eventType: event.eventType,
      occurredAt: event.occurredAt.toISOString(),
      tenantRef: event.tenantId,
      resourceRef: event.resourceRef,
      data: event.data,
    };
    const rawBody = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    let allOk = true;
    for (const endpoint of endpoints) {
      const signature = signPayload(endpoint.secret, timestamp, rawBody);
      try {
        const res = await fetchImpl(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-WelliPay-Timestamp": String(timestamp),
            "X-WelliPay-Signature": signature,
          },
          body: rawBody,
        });
        if (!(res.status === 204 || (res.status >= 200 && res.status < 300))) allOk = false;
      } catch {
        allOk = false;
      }
    }

    if (allOk) {
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
      delivered++;
    } else {
      const attempts = event.attempts + 1;
      const dead = attempts >= env.WEBHOOK_MAX_ATTEMPTS;
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          status: dead ? "DEAD_LETTERED" : "PENDING",
          nextAttemptAt: new Date(Date.now() + backoffSeconds(attempts) * 1000),
          lastError: "One or more webhook endpoints returned a non-2xx status or timed out.",
        },
      });
    }
  }
  return delivered;
}
