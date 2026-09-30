import { describe, it, expect, vi } from "vitest";
import { checkIdempotency, storeIdempotentResponse } from "../src/lib/idempotency.js";

// checkIdempotency/storeIdempotentResponse are the only thing standing
// between a flaky client retry and a patient being charged twice. These
// tests use a fake Prisma client (an in-memory Map) instead of a real
// database — this sandbox has no network path to Postgres — but the
// validation branches and the "same key, same body vs. different body"
// logic are exercised exactly as the real route handlers use them.

function fakeReply() {
  const state: { code?: number; body?: unknown } = {};
  const reply: any = {
    request: { id: "req-idem-1" },
    code(status: number) {
      state.code = status;
      return reply;
    },
    header() {
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  };
  return { reply, state };
}

function fakeRequest(overrides: { key?: string; body?: unknown; tenantId?: string | undefined } = {}) {
  return {
    headers: { "idempotency-key": overrides.key ?? "a".repeat(20) },
    body: overrides.body ?? { amountMinor: 48150 },
    auth: overrides.tenantId === undefined ? undefined : { tenantId: overrides.tenantId },
  } as any;
}

function fakePrisma() {
  const store = new Map<string, any>();
  return {
    idempotencyRecord: {
      async findUnique({ where }: any) {
        const { tenantId, route, key } = where.tenantId_route_key;
        return store.get(`${tenantId}:${route}:${key}`) ?? null;
      },
      async create({ data }: any) {
        store.set(`${data.tenantId}:${data.route}:${data.key}`, {
          ...data,
          responseBody: data.responseBody,
        });
        return data;
      },
    },
  } as any;
}

describe("checkIdempotency", () => {
  it("rejects with 401 when request.auth is missing (auth plugin didn't run)", async () => {
    const { reply, state } = fakeReply();
    const result = await checkIdempotency(fakePrisma(), fakeRequest({ tenantId: undefined }), reply, "POST /provider/payments");
    expect(result).toBeUndefined();
    expect(state.code).toBe(401);
  });

  it("rejects a missing Idempotency-Key header", async () => {
    const { reply, state } = fakeReply();
    const request = fakeRequest({ tenantId: "t1" });
    delete request.headers["idempotency-key"];
    const result = await checkIdempotency(fakePrisma(), request, reply, "POST /provider/payments");
    expect(result).toBeUndefined();
    expect(state.code).toBe(400);
  });

  it("rejects a key shorter than 16 characters", async () => {
    const { reply, state } = fakeReply();
    const result = await checkIdempotency(fakePrisma(), fakeRequest({ tenantId: "t1", key: "short" }), reply, "POST /provider/payments");
    expect(result).toBeUndefined();
    expect(state.code).toBe(400);
  });

  it("rejects a key longer than 128 characters", async () => {
    const { reply, state } = fakeReply();
    const result = await checkIdempotency(fakePrisma(), fakeRequest({ tenantId: "t1", key: "x".repeat(129) }), reply, "POST /provider/payments");
    expect(result).toBeUndefined();
    expect(state.code).toBe(400);
  });

  it("returns a fresh (non-replayed) context on first use of a key", async () => {
    const { reply } = fakeReply();
    const result = await checkIdempotency(fakePrisma(), fakeRequest({ tenantId: "t1" }), reply, "POST /provider/payments");
    expect(result?.replayed).toBe(false);
  });

  it("replays the stored response byte-for-byte on an exact repeat (same key, same body)", async () => {
    const prisma = fakePrisma();
    const key = "b".repeat(20);

    const first = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key }), fakeReply().reply, "POST /provider/payments");
    await storeIdempotentResponse(prisma, first!, 201, { paymentId: "pay_1", amountMinor: 48150 });

    const { reply: replayReply, state: replayState } = fakeReply();
    const second = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key }), replayReply, "POST /provider/payments");

    expect(second?.replayed).toBe(true);
    expect(replayState.code).toBe(201);
    expect(replayState.body).toEqual({ paymentId: "pay_1", amountMinor: 48150 });
  });

  it("rejects reusing a key with a different request body — the real bug this guards against", async () => {
    const prisma = fakePrisma();
    const key = "c".repeat(20);

    const first = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key, body: { amountMinor: 48150 } }), fakeReply().reply, "POST /provider/payments");
    await storeIdempotentResponse(prisma, first!, 201, { paymentId: "pay_1" });

    const { reply: secondReply, state } = fakeReply();
    const second = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key, body: { amountMinor: 999999 } }), secondReply, "POST /provider/payments");

    expect(second).toBeUndefined();
    expect(state.code).toBe(409);
  });

  it("scopes replay to the same tenant and route — a key reused by a different tenant or route is a fresh request, not a conflict", async () => {
    const prisma = fakePrisma();
    const key = "d".repeat(20);

    const first = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key }), fakeReply().reply, "POST /provider/payments");
    await storeIdempotentResponse(prisma, first!, 201, { paymentId: "pay_1" });

    const otherTenant = await checkIdempotency(prisma, fakeRequest({ tenantId: "t2", key }), fakeReply().reply, "POST /provider/payments");
    expect(otherTenant?.replayed).toBe(false);

    const otherRoute = await checkIdempotency(prisma, fakeRequest({ tenantId: "t1", key }), fakeReply().reply, "POST /provider/refunds");
    expect(otherRoute?.replayed).toBe(false);
  });
});
