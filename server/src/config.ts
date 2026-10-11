import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { logger } from './lib/logger.js';
import { DEFAULT_SMS_FROM_NUMBER, PUBLISHED_CLINIC_PHONE, isE164 } from './clinicContact.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function flag(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'on', 'yes'].includes(v.toLowerCase());
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((x) => x.trim()).filter(Boolean);
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Refuse to run in production against a database connection that is not
 * encrypted in transit. TLS is assumed at the load balancer for the web tier,
 * but the app-to-database hop is its own network path and is the one that
 * carries every PHI value — so it is checked here, not assumed.
 *
 * The URL is parsed but never echoed: the error says what is wrong, not what
 * the connection string contains (it holds the database password).
 */
function assertDatabaseTls(url: string): void {
  if (!isProduction) return;
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    throw new Error('Refusing to start: DATABASE_URL is not a valid URL.');
  }
  const mode = (params.get('sslmode') ?? '').toLowerCase();
  const ok = ['require', 'verify-ca', 'verify-full'].includes(mode) || params.get('ssl') === 'true';
  if (!ok) {
    throw new Error(
      'Refusing to start: NODE_ENV=production but DATABASE_URL does not require TLS. '
      + 'Add ?sslmode=require (or verify-full) to the connection string.',
    );
  }
}

/** A whole number and nothing else: "1.5", "30days" and "thirty" are errors, not 1, 30 and NaN. */
function strictInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new Error(`Refusing to start: ${name} must be a whole number of days from 1 to 3650.`);
  return Number(raw);
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

/**
 * What this deployment actually is, which drives what a patient sees.
 *
 *   coming_soon — the practice has not opened. The booking flow is hidden
 *                 behind an explanatory page; staff can still reach it with
 *                 ?preview=<PREVIEW_KEY> to test against real configuration.
 *   demo        — fixtures only, nothing booked is a real appointment.
 *   beta        — real patients, real bookings, front desk confirms each one.
 *   live        — normal operation, no banner.
 *
 * Config rather than markup so promoting a deployment is an env change, and
 * so a test instance can never silently claim to be the real thing.
 */
export type BookingMode = 'coming_soon' | 'demo' | 'beta' | 'live';

const MODES: BookingMode[] = ['coming_soon', 'demo', 'beta', 'live'];

function mode(): BookingMode {
  const v = (process.env.BOOKING_MODE ?? 'demo').toLowerCase() as BookingMode;
  if (MODES.includes(v)) return v;
  throw new Error(`BOOKING_MODE must be one of ${MODES.join(', ')} — got "${v}"`);
}

/** 32-byte key for encrypting TOTP secrets at rest. See lib/crypto.ts. */
function mfaKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (run `npm run gen-secrets`).');
    }
    return key;
  }
  // No hard-coded fallback, ever: a default key in source is a published key.
  if (isProduction) throw new Error('Refusing to start: MFA_ENCRYPTION_KEY is not set.');
  // Development only: a random per-process key. Authenticator enrolments made
  // against it do not survive a restart, which is the safe way to fail.
  logger.warn('mfa_key_missing_using_throwaway', { note: 'MFA enrolments will not survive a restart' });
  return randomBytes(32);
}

const databaseUrl = required('DATABASE_URL');
assertDatabaseTls(databaseUrl);

export const config = {
  isProduction,
  port: int('PORT', 4000),
  databaseUrl,
  bookingMode: mode(),
  /** Lets staff open the real booking flow while the public sees coming-soon. */
  previewKey: process.env.PREVIEW_KEY ?? '',
  /** Shown on the coming-soon page. Free text, e.g. "November". */
  openingWhen: process.env.OPENING_WHEN ?? '',
  clinicTimezone: process.env.CLINIC_TIMEZONE ?? 'America/Chicago',
  holdTtlMinutes: int('HOLD_TTL_MINUTES', 10),

  /**
   * The old shared HTTP Basic gate over the staff surface. RETIRED by default —
   * individual logins replace it. Kept behind a flag so it can be switched back
   * on during cutover without a deploy of different code.
   */
  basicAuthGate: flag('BASIC_AUTH_GATE', false),

  /** Public origin of this app. Used to build one-time setup links. */
  appBaseUrl: process.env.APP_BASE_URL
    ?? (isProduction ? '' : `http://localhost:${int('PORT', 4000)}`),

  /** Origins allowed to call the PUBLIC (cookie-less) API cross-origin. */
  corsOrigins: list('CORS_ORIGINS', [
    'https://nextwave-wellness.com',
    'https://www.nextwave-wellness.com',
  ]),

  /**
   * Roles for which TOTP is mandatory at sign-in. Providers joined admins at the Phase 4 gate, since
   * they now read and write clinical notes. (Clinical documentation additionally checks the
   * authenticator itself, whatever this says — see middleware/clinical.ts.)
   */
  mfaRequiredRoles: list('MFA_REQUIRED_ROLES', ['ADMIN', 'PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE']),
  mfaKey: mfaKey(),

  /**
   * Run scheduled jobs (appointment texts) on a timer inside the web process. Off by
   * default: production should use an external scheduler (`npm run jobs:run`), which
   * keeps working when the web process sleeps or restarts. See jobs/scheduler.ts.
   */
  jobsInProcess: flag('JOBS_IN_PROCESS', false),
  jobsIntervalMin: Math.max(1, int('JOBS_INTERVAL_MIN', 5)),

  /**
   * The clinic's phone number, given to a patient who texts HELP. CLINIC_PHONE overrides the number
   * published on the website (src/clinicContact.ts). A getter, so a change to the environment is
   * seen without a restart — which is what lets tests set it.
   */
  get clinicPhone(): string { return (process.env.CLINIC_PHONE ?? '').trim() || PUBLISHED_CLINIC_PHONE || ''; },

  /**
   * The number appointment texts are sent from (the registered toll-free number). TWILIO_FROM_NUMBER
   * overrides it; a value that is not E.164 stops the app at start-up rather than at the first text.
   */
  get twilioFromNumber(): string { return (process.env.TWILIO_FROM_NUMBER ?? '').trim() || DEFAULT_SMS_FROM_NUMBER; },

  /**
   * The AI scribe records visits and sends the audio and transcripts through FileStorage and AiScribe.
   * While either is the local STUB (which writes to the server's own unencrypted disk) the scribe is
   * switched OFF in production, so real patient audio can never land there. This lifts that, for a
   * staging deployment that holds only fake patients. Never set it where real patients are seen.
   */
  allowStubIntegrations: flag('ALLOW_STUB_INTEGRATIONS', false),

  /**
   * How long after a note is SIGNED its visit's raw audio is kept before the retention job deletes it
   * (jobs/audioRetention.ts). The transcript and the AI draft stay with the encounter. A whole number of
   * days, 1 or more; anything else stops the app at start-up rather than silently keeping or losing audio.
   */
  audioRetentionDays: strictInt('AUDIO_RETENTION_DAYS', 30),

  /** Booking grid granularity. Slots start on multiples of this. */
  slotGranularityMin: 15,

  /** How far ahead the public booking flow may look. */
  maxAdvanceDays: 90,
};

if (isProduction && !config.appBaseUrl.startsWith('https://')) {
  throw new Error('Refusing to start: APP_BASE_URL must be set to the https:// origin in production.');
}

// Real text messaging is switched on by giving the app the provider's auth token (it also
// verifies the inbound STOP/HELP webhook). A HELP reply must tell the patient how to reach the
// clinic, so refuse to run that way without the phone number.
if (!Number.isInteger(config.audioRetentionDays) || config.audioRetentionDays < 1 || config.audioRetentionDays > 3650) {
  throw new Error('Refusing to start: AUDIO_RETENTION_DAYS must be a whole number of days from 1 to 3650.');
}
if (!isE164(config.twilioFromNumber)) {
  throw new Error('Refusing to start: TWILIO_FROM_NUMBER must be a phone number in E.164 form, such as +18665241007.');
}
if (isProduction && process.env.TWILIO_AUTH_TOKEN && !config.clinicPhone) {
  throw new Error('Refusing to start: CLINIC_PHONE is not set. The text-message HELP reply must give the clinic\'s phone number.');
}
