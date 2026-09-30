import { verifyToken } from "@clerk/backend";
import { env } from "../env.js";

// Verifies a Clerk session token from the separate Patient MobileApp
// (@clerk/clerk-expo on the app side). Used only by POST /patient/link and
// POST /patient/token (src/routes/patientAuth.ts) — every other route in
// this service keeps using the existing OAuth2 client-credentials/JWT auth
// in src/plugins/auth.ts, which has nothing to do with Clerk.
//
// verifyToken() with just secretKey checks the token's signature against
// Clerk's own keys for this Clerk project (a network call to Clerk's JWKS
// endpoint, cached) — no separate issuer/audience check needed, since a
// valid signature already proves it came from this exact Clerk project.

export class ClerkNotConfiguredError extends Error {
  constructor() {
    super("CLERK_SECRET_KEY is not set — the patient mobile app integration is not configured yet.");
    this.name = "ClerkNotConfiguredError";
  }
}

export async function verifyClerkToken(token: string): Promise<{ clerkUserId: string }> {
  if (!env.CLERK_SECRET_KEY) {
    throw new ClerkNotConfiguredError();
  }
  // The lower-level tokens/verify.ts function returns a {data, errors} pair,
  // but the top-level verifyToken() this package actually exports from its
  // index wraps that in withLegacyReturn (see node_modules/@clerk/backend/
  // dist/index.d.ts) — it throws on an invalid token and resolves directly
  // to the JwtPayload on success, matching the SDK doc's try/catch example.
  const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
  return { clerkUserId: payload.sub };
}
