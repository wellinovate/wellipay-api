// Login lockout. After MAX_FAILED_ATTEMPTS wrong passwords in a row an
// account is locked for LOCKOUT_MINUTES. A success clears the count. A
// failure after a lock has expired starts a fresh count instead of locking
// again at once.
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function minutesRemaining(state: LockoutState, now: Date): number {
  if (!isLocked(state, now) || !state.lockedUntil) return 0;
  return Math.max(1, Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 60000));
}

// The state after one more wrong password.
export function afterFailure(state: LockoutState, now: Date): LockoutState {
  const lockExpired = state.lockedUntil !== null && !isLocked(state, now);
  const count = (lockExpired ? 0 : state.failedLoginCount) + 1;
  if (count >= MAX_FAILED_ATTEMPTS) {
    return { failedLoginCount: count, lockedUntil: new Date(now.getTime() + LOCKOUT_MINUTES * 60000) };
  }
  return { failedLoginCount: count, lockedUntil: null };
}

export const clearedState: LockoutState = { failedLoginCount: 0, lockedUntil: null };
