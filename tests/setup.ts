// src/env.ts parses process.env at import time and calls process.exit(1) if
// anything required is missing — that would kill the whole test worker, not
// just fail an assertion. This file runs before any test file (see
// vitest.config.ts's setupFiles) and fills in offline-safe values for
// anything not already set, so importing env.ts (directly, or transitively
// through src/lib/tokens.ts) never touches a real database or secret.
//
// These are fake values for a test process — never real credentials, and
// never used for anything that connects to an actual database.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/wellipay_test_unused";
process.env.TOKEN_SIGNING_SECRET ??= "test-only-signing-secret-at-least-32-characters-long";
process.env.TOKEN_ISSUER ??= "https://api.wellipay.internal";
process.env.TOKEN_AUDIENCE ??= "wellipay-integration-service";
process.env.FRONTEND_CLIENT_ID ??= "test-client-id";
process.env.FRONTEND_CLIENT_SECRET ??= "test-client-secret";
process.env.WEBHOOK_MAX_ATTEMPTS ??= "8";
