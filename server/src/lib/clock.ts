/**
 * The application's notion of "now" for NEW (Phase 2+) code.
 *
 * Walk-ins and appointment texts depend on the current time, which makes them
 * impossible to test deterministically against the wall clock (a test run at 3 a.m.
 * on a Sunday would find the clinic closed). Code that needs the time calls now()
 * so tests can pin it. In production now() is exactly `new Date()`.
 *
 * The existing booking engine is deliberately NOT routed through this — it keeps
 * its own `new Date()` — so it is untouched and behaves identically.
 */

let pinned: Date | null = null;

export function now(): Date {
  return pinned ? new Date(pinned.getTime()) : new Date();
}

/** Test-only. Throws outside NODE_ENV=test so it can never skew production time. */
export function setClockForTests(at: Date | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setClockForTests is only available under NODE_ENV=test');
  pinned = at;
}
