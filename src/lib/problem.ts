import type { FastifyReply } from "fastify";

// RFC 9457 application/problem+json, as required by
// wellipaypro/docs/mobile-app-integration.md's "Error handling" section.

export interface ProblemInit {
  status: number;
  title: string;
  detail?: string | undefined;
  code?: string | undefined;
  correlationId?: string | undefined;
  type?: string | undefined;
}

export function sendProblem(reply: FastifyReply, problem: ProblemInit): FastifyReply {
  return reply
    .code(problem.status)
    .header("content-type", "application/problem+json")
    .send({
      type: problem.type ?? "about:blank",
      title: problem.title,
      status: problem.status,
      detail: problem.detail,
      code: problem.code,
      correlationId: problem.correlationId ?? reply.request.id,
    });
}

export const problems = {
  badRequest: (detail: string, code = "bad_request") => ({ status: 400, title: "Bad Request", detail, code }),
  unauthorized: (detail = "Missing or invalid token.", code = "unauthorized") => ({ status: 401, title: "Unauthorized", detail, code }),
  forbidden: (detail = "Insufficient scope or resource is outside the credential tenant.", code = "forbidden") => ({ status: 403, title: "Forbidden", detail, code }),
  notFound: (detail = "Resource not found within the authenticated tenant.", code = "not_found") => ({ status: 404, title: "Not Found", detail, code }),
  conflict: (detail: string, code = "conflict") => ({ status: 409, title: "Conflict", detail, code }),
  unprocessable: (detail: string, code = "unprocessable") => ({ status: 422, title: "Unprocessable Entity", detail, code }),
  rateLimited: (detail = "Rate limit exceeded.", code = "rate_limited") => ({ status: 429, title: "Too Many Requests", detail, code }),
  serviceUnavailable: (detail: string, code = "service_unavailable") => ({ status: 503, title: "Service Unavailable", detail, code }),
} as const;
