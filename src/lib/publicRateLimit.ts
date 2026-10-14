// Route-level rate limit for public endpoints. @fastify/rate-limit reads
// statusCode off whatever errorResponseBuilder returns, so it must be an Error.
export function publicRateLimit(max: number) {
  return {
    rateLimit: {
      max,
      timeWindow: "1 minute",
      errorResponseBuilder: (_request: unknown, context: { after: string; statusCode: number }) => {
        const err = new Error(`Too many requests. Try again in ${context.after}.`) as Error & { statusCode?: number };
        err.statusCode = context.statusCode;
        return err;
      },
    },
  };
}
