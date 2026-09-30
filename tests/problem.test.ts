import { describe, it, expect, vi } from "vitest";
import { sendProblem, problems } from "../src/lib/problem.js";

// A fake FastifyReply that just records what was called on it, so these
// tests check the actual RFC 9457 shape without spinning up a server.
function fakeReply() {
  const calls: { code?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
  const reply: any = {
    request: { id: "req-test-1" },
    code(status: number) {
      calls.code = status;
      return reply;
    },
    header(name: string, value: string) {
      calls.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      calls.body = body;
      return reply;
    },
  };
  return { reply, calls };
}

describe("sendProblem", () => {
  it("sends the RFC 9457 content-type and shape", () => {
    const { reply, calls } = fakeReply();
    sendProblem(reply, problems.badRequest("Amount must be positive.", "invalid_amount"));

    expect(calls.code).toBe(400);
    expect(calls.headers["content-type"]).toBe("application/problem+json");
    expect(calls.body).toMatchObject({
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "Amount must be positive.",
      code: "invalid_amount",
      correlationId: "req-test-1",
    });
  });

  it("falls back to the request id when no correlationId is given", () => {
    const { reply, calls } = fakeReply();
    sendProblem(reply, { status: 500, title: "Internal Server Error" });
    expect((calls.body as any).correlationId).toBe("req-test-1");
  });
});

describe("problems factory", () => {
  it.each([
    ["badRequest", problems.badRequest("x"), 400, "Bad Request"],
    ["unauthorized", problems.unauthorized(), 401, "Unauthorized"],
    ["forbidden", problems.forbidden(), 403, "Forbidden"],
    ["notFound", problems.notFound(), 404, "Not Found"],
    ["conflict", problems.conflict("x"), 409, "Conflict"],
    ["unprocessable", problems.unprocessable("x"), 422, "Unprocessable Entity"],
    ["rateLimited", problems.rateLimited(), 429, "Too Many Requests"],
  ])("%s has status %i and title %s", (_name, problem, status, title) => {
    expect(problem.status).toBe(status);
    expect(problem.title).toBe(title);
  });

  it("unauthorized/forbidden/notFound/rateLimited have sane defaults without arguments", () => {
    expect(problems.unauthorized().detail).toMatch(/token/i);
    expect(problems.forbidden().detail).toMatch(/scope|tenant/i);
    expect(problems.notFound().detail).toMatch(/not found/i);
    expect(problems.rateLimited().detail).toMatch(/rate limit/i);
  });
});
