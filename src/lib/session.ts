// Renewing a staff token keeps a person signed in while they work. A token
// that has already expired cannot be renewed, so 15 minutes without a request
// still signs them out. The original sign-in time is carried forward, so a
// stolen token cannot be renewed forever.
export const TOKEN_SECONDS = 900;

export interface Renewal {
  allowed: boolean;
  // Lifetime for the new token, never longer than what is left of the session.
  expiresInSeconds: number;
}

export function planRenewal(sessionStartSeconds: number, nowSeconds: number, maxHours: number): Renewal {
  const remaining = sessionStartSeconds + maxHours * 3600 - nowSeconds;
  if (remaining <= 0) return { allowed: false, expiresInSeconds: 0 };
  return { allowed: true, expiresInSeconds: Math.min(TOKEN_SECONDS, Math.floor(remaining)) };
}
