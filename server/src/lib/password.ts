/**
 * Password hashing and policy.
 *
 * Argon2id, parameters at the OWASP-recommended minimum for the algorithm
 * (19 MiB, 2 passes, 1 lane). @node-rs/argon2 ships prebuilt binaries, so no
 * native compiler is needed on Render or in CI.
 */

import { hash, verify, Algorithm } from '@node-rs/argon2';

const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false; // a malformed stored hash must read as "wrong password", not a 500
  }
}

let dummy: Promise<string> | null = null;

/**
 * Verify against a throwaway hash. Called when the email does not exist so an
 * unknown account takes as long to reject as a wrong password — otherwise
 * response time tells an attacker which emails are registered.
 */
export async function burnVerify(plain: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password-just-burning-time');
  await verifyPassword(await dummy, plain);
}

export const MIN_PASSWORD_LENGTH = 12;

// The most common choices that still clear a 12-character floor. Not exhaustive
// — a length rule plus this plus "not your email" is the NIST 800-63B shape:
// block known-bad, don't impose composition rules.
const COMMON = new Set([
  'password1234', 'password12345', 'passw0rd1234', 'qwertyuiop12', 'qwerty123456',
  '123456789012', '1234567890123', '111111111111', 'iloveyou1234', 'letmein12345',
  'welcome12345', 'administrator', 'admin1234567', 'changeme1234', 'nextwave1234',
  'nextwave12345', 'wellness1234', 'wellness12345', 'chiropractic1',
]);

/** Returns a user-facing reason the password is unacceptable, or null if fine. */
export function validatePassword(plain: string, ctx: { email?: string } = {}): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (plain.length > 128) return 'Use at most 128 characters.';
  const lower = plain.toLowerCase();
  if (COMMON.has(lower)) return 'That password is too common. Choose something less guessable.';
  if (/^(.)\1+$/.test(plain)) return 'Choose a password that is not one repeated character.';
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (ctx.email && (lower === ctx.email.toLowerCase() || (local && local.length >= 4 && lower.includes(local)))) {
    return 'Your password should not contain your email address.';
  }
  return null;
}
