import { describe, it, expect, vi } from "vitest";
import { signPayload, verifySignature, deliverPendingEvents } from "../src/lib/webhooks.js";

describe("signPayload / verifySignature", () => {
  const secret = "whsec_test_secret";

  it("verifies a signature it just produced", () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ eventId: "evt_1", data: { amountMinor: 48150 } });
    const sig = signPayload(secret, now, body);
    expect(verifySignature(secret, now, body, sig, now)).toBe(true);
  });

  it("rejects a tampered body — this is the whole point of signing", () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ amountMinor: 48150 });
    const sig = signPayload(secret, now, body);
    const tamperedBody = JSON.stringify({ amountMinor: 9999999 });
    expect(verifySignature(secret, now, tamperedBody, sig, now)).toBe(false);
  });

  it("rejects a signature from the wrong secret", () => {
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ x: 1 });
    const sig = signPayload("a-different-secret", now, body);
    expect(verifySignature(secret, now, body, sig, now)).toBe(false);
  });

  it("rejects a stale timestamp outside the 300s tolerance", () => {
    const eventTime = Math.floor(Date.now() / 1000) - 1000; // ~16.7 min ago
    const body = JSON.stringify({ x: 1 });
    const sig = signPayload(secret, eventTime, body);
    const receivedNow = eventTime + 1000;
    expect(verifySignature(secret, eventTime, body, sig, receivedNow)).toBe(false);
  });

  it("accepts a timestamp just inside the tolerance and rejects just outside it", () => {
    const body = JSON.stringify({ x: 1 });
    const eventTime = 1_000_000;
    const sig = signPayload(secret, eventTime, body);
    expect(verifySignature(secret, eventTime, body, sig, eventTime + 300)).toBe(true);
    expect(verifySignature(secret, eventTime, body, sig, eventTime + 301)).toBe(false);
  });
});

// Fake Prisma: just enough of outboxEvent/webhookEndpoint to drive
// deliverPendingEvents without a real database. update() records what was
// written so assertions can check the resulting status/attempts/backoff.
function fakePrisma(opts: { events: any[]; endpointsByTenant: Record<string, any[]> }) {
  const updates: any[] = [];
  return {
    _updates: updates,
    outboxEvent: {
      findMany: vi.fn(async () => opts.events),
      update: vi.fn(async ({ where, data }: any) => {
        updates.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
    webhookEndpoint: {
      findMany: vi.fn(async ({ where }: any) => opts.endpointsByTenant[where.tenantId] ?? []),
    },
  } as any;
}

function baseEvent(overrides: Partial<any> = {}) {
  return {
    id: "evt_row_1",
    eventId: "evt_1",
    tenantId: "tenant_1",
    eventType: "payment.recorded",
    occurredAt: new Date(),
    resourceRef: "pay_1",
    data: { amountMinor: 48150 },
    attempts: 0,
    status: "PENDING",
    ...overrides,
  };
}

describe("deliverPendingEvents", () => {
  it("leaves an event PENDING (not dead-lettered) when no endpoint is registered yet", async () => {
    const prisma = fakePrisma({ events: [baseEvent()], endpointsByTenant: {} });
    const delivered = await deliverPendingEvents(prisma);
    expect(delivered).toBe(0);
    expect(prisma.outboxEvent.update).not.toHaveBeenCalled();
  });

  it("marks an event DELIVERED when every active endpoint responds 2xx, and signs the request correctly", async () => {
    const prisma = fakePrisma({
      events: [baseEvent()],
      endpointsByTenant: { tenant_1: [{ url: "https://receiver.example/hook", secret: "whsec_abc", active: true }] },
    });
    let capturedHeaders: any;
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return { status: 200 } as Response;
    });

    const delivered = await deliverPendingEvents(prisma, fetchImpl as any);

    expect(delivered).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const timestamp = Number(capturedHeaders["X-WelliPay-Timestamp"]);
    expect(verifySignature("whsec_abc", timestamp, capturedBody!, capturedHeaders["X-WelliPay-Signature"])).toBe(true);

    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt_row_1" }, data: expect.objectContaining({ status: "DELIVERED" }) })
    );
  });

  it("also treats 204 as a successful delivery", async () => {
    const prisma = fakePrisma({
      events: [baseEvent()],
      endpointsByTenant: { tenant_1: [{ url: "https://receiver.example/hook", secret: "s", active: true }] },
    });
    const fetchImpl = vi.fn(async () => ({ status: 204 } as Response));
    const delivered = await deliverPendingEvents(prisma, fetchImpl as any);
    expect(delivered).toBe(1);
  });

  it("retries with exponential backoff on a non-2xx response, without dead-lettering before the attempt cap", async () => {
    const prisma = fakePrisma({
      events: [baseEvent({ attempts: 0 })],
      endpointsByTenant: { tenant_1: [{ url: "https://receiver.example/hook", secret: "s", active: true }] },
    });
    const fetchImpl = vi.fn(async () => ({ status: 500 } as Response));
    const before = Date.now();

    const delivered = await deliverPendingEvents(prisma, fetchImpl as any);

    expect(delivered).toBe(0);
    const update = prisma._updates[0];
    expect(update.data.status).toBe("PENDING");
    expect(update.data.attempts).toBe(1);
    // backoffSeconds(1) === 2s
    const nextAttemptMs = update.data.nextAttemptAt.getTime();
    expect(nextAttemptMs).toBeGreaterThanOrEqual(before + 1900);
    expect(nextAttemptMs).toBeLessThanOrEqual(before + 2600);
  });

  it("dead-letters once attempts reach WEBHOOK_MAX_ATTEMPTS", async () => {
    // WEBHOOK_MAX_ATTEMPTS=8 per tests/setup.ts — this event has already
    // failed 7 times, so this failure should push it to attempts=8 and flip
    // it to DEAD_LETTERED instead of scheduling another retry.
    const prisma = fakePrisma({
      events: [baseEvent({ attempts: 7 })],
      endpointsByTenant: { tenant_1: [{ url: "https://receiver.example/hook", secret: "s", active: true }] },
    });
    const fetchImpl = vi.fn(async () => ({ status: 500 } as Response));

    await deliverPendingEvents(prisma, fetchImpl as any);

    const update = prisma._updates[0];
    expect(update.data.attempts).toBe(8);
    expect(update.data.status).toBe("DEAD_LETTERED");
  });

  it("requires every active endpoint to succeed — one failing among several counts as a failed delivery", async () => {
    const prisma = fakePrisma({
      events: [baseEvent()],
      endpointsByTenant: {
        tenant_1: [
          { url: "https://a.example/hook", secret: "s1", active: true },
          { url: "https://b.example/hook", secret: "s2", active: true },
        ],
      },
    });
    const fetchImpl = vi.fn(async (url: string) => (url.includes("a.example") ? { status: 200 } : { status: 503 })) as any;

    const delivered = await deliverPendingEvents(prisma, fetchImpl);

    expect(delivered).toBe(0);
    expect(prisma._updates[0].data.status).toBe("PENDING");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("treats a network error (fetch throwing) the same as a non-2xx response", async () => {
    const prisma = fakePrisma({
      events: [baseEvent()],
      endpointsByTenant: { tenant_1: [{ url: "https://receiver.example/hook", secret: "s", active: true }] },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const delivered = await deliverPendingEvents(prisma, fetchImpl as any);
    expect(delivered).toBe(0);
    expect(prisma._updates[0].data.status).toBe("PENDING");
    expect(prisma._updates[0].data.attempts).toBe(1);
  });

  it("only queries events that are PENDING and due (nextAttemptAt <= now)", async () => {
    const prisma = fakePrisma({ events: [], endpointsByTenant: {} });
    await deliverPendingEvents(prisma);
    const arg = prisma.outboxEvent.findMany.mock.calls[0][0];
    expect(arg.where.status).toBe("PENDING");
    expect(arg.where.nextAttemptAt.lte).toBeInstanceOf(Date);
  });
});
