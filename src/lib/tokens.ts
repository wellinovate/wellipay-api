import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

// Minimal in-house OAuth2 client-credentials token issuer.
//
// The contract's open-decisions list names "token issuer/audience,
// scopes, signing-key rotation" as things to confirm with a real IdP
// before production (technical-schedule-draft.md, section 3). This gets
// the whole request/response loop working end to end now, with the token
// shape (sub = clientId, tenantId, scopes) chosen so swapping in a real
// OIDC provider later only touches this file and the verifyToken() call
// site in plugins/auth.ts — nothing in the route handlers changes.

const secret = new TextEncoder().encode(env.TOKEN_SIGNING_SECRET);
const issuer = env.TOKEN_ISSUER;
const audience = env.TOKEN_AUDIENCE;

export interface AccessTokenClaims {
  sub: string; // clientId, staff id, or patient account id depending on issuer route
  tenantId: string;
  scopes: string[];
  // Set only for a patient-scoped token (POST /patient/token). Its presence
  // is what src/plugins/patientAuth.ts's requirePatientScope() checks to
  // reject a staff/provider token on a /patient/* route and vice versa —
  // scopes alone aren't enough since nothing stops the same scope string
  // space from colliding later.
  patientRef?: string;
}

export async function issueAccessToken(claims: AccessTokenClaims, expiresInSeconds = 900): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({
    tenantId: claims.tenantId,
    scopes: claims.scopes,
    ...(claims.patientRef ? { patientRef: claims.patientRef } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(secret);
  return { token, expiresIn: expiresInSeconds };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer, audience });
  const tenantId = payload["tenantId"];
  const scopes = payload["scopes"];
  const patientRef = payload["patientRef"];
  if (typeof payload.sub !== "string" || typeof tenantId !== "string" || !Array.isArray(scopes)) {
    throw new Error("Malformed access token claims");
  }
  if (patientRef !== undefined && typeof patientRef !== "string") {
    throw new Error("Malformed access token claims");
  }
  return {
    sub: payload.sub,
    tenantId,
    scopes: scopes as string[],
    // exactOptionalPropertyTypes forbids assigning `patientRef: undefined`
    // directly — omit the key entirely rather than set it to undefined.
    ...(patientRef !== undefined ? { patientRef } : {}),
  };
}
