/**
 * The inactivity policy, as pure functions of the clock.
 *
 * The server is the authority — it revokes a session after 15 minutes without a
 * person's activity regardless of what any client does. This mirrors that policy
 * so the user gets a warning at 14 minutes instead of a surprise at 15.
 *
 * Kept separate from React so the boundaries are unit-tested rather than
 * discovered in production.
 */

export const WARN_AFTER_MS = 14 * 60_000;
export const SIGN_OUT_AFTER_MS = 15 * 60_000;
export const PING_EVERY_MS = 60_000;

export type IdlePhase = 'active' | 'warning' | 'expired';

export function idlePhase(now: number, lastInput: number): IdlePhase {
  const idle = now - lastInput;
  if (idle >= SIGN_OUT_AFTER_MS) return 'expired';
  if (idle >= WARN_AFTER_MS) return 'warning';
  return 'active';
}

export function secondsUntilSignOut(now: number, lastInput: number): number {
  return Math.max(0, Math.ceil((SIGN_OUT_AFTER_MS - (now - lastInput)) / 1000));
}

/** Tell the server a person is here — but only if they were, and not too often. */
export function shouldPing(now: number, lastInput: number, lastPing: number): boolean {
  return lastInput > lastPing && now - lastPing >= PING_EVERY_MS;
}
