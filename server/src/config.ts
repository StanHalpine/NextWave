import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

/**
 * Published clinic hours, from contact.html. Keys are ISO weekdays
 * (1 = Monday … 7 = Sunday); a missing key means closed.
 *
 * These bound availability independently of staff shifts — a provider rostered
 * past close still produces no slots after close.
 */
export const CLINIC_HOURS: Record<number, { open: string; close: string }> = {
  1: { open: '07:00', close: '19:00' },
  2: { open: '07:00', close: '19:00' },
  3: { open: '07:00', close: '19:00' },
  4: { open: '07:00', close: '19:00' },
  5: { open: '07:00', close: '19:00' },
  6: { open: '08:00', close: '14:00' },
  // 7 (Sunday) — closed.
};

export const config = {
  port: int('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  clinicTimezone: process.env.CLINIC_TIMEZONE ?? 'America/Chicago',
  holdTtlMinutes: int('HOLD_TTL_MINUTES', 10),
  frontDeskToken: process.env.FRONT_DESK_TOKEN ?? '',

  /** Booking grid granularity. Slots start on multiples of this. */
  slotGranularityMin: 15,

  /** How far ahead the public booking flow may look. */
  maxAdvanceDays: 90,
};
