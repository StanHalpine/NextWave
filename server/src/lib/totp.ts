/**
 * TOTP (RFC 6238) multi-factor authentication, via otplib.
 *
 * Seeds are generated here and encrypted by the caller (lib/crypto.ts) before
 * they touch the database. Replay is blocked by recording the highest accepted
 * time-step and refusing anything at or below it — without that, a code
 * shoulder-surfed or intercepted within its 30-second window could be reused.
 */

import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import { randomToken, sha256Hex } from './crypto.js';

const ISSUER = 'NextWave Wellness';

export function newTotpSecret(): string {
  return generateSecret();
}

export function totpUri(accountEmail: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: accountEmail, secret });
}

export type TotpResult = { ok: true; timeStep: number } | { ok: false };

/**
 * @param lastStep highest time-step previously accepted for this account; codes
 *                 at or before it are rejected as replays.
 */
export function verifyTotp(secret: string, token: string, lastStep: number | null): TotpResult {
  const clean = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return { ok: false };
  // epochTolerance 30s = accept the adjacent step either side, to absorb a
  // phone clock that is slightly off. No wider.
  const r = verifySync({
    secret,
    token: clean,
    epochTolerance: 30,
    ...(lastStep != null ? { afterTimeStep: lastStep } : {}),
  });
  // The result type is a union with HOTP, which has no timeStep; TOTP always does.
  const step = (r as { timeStep?: number }).timeStep;
  return r.valid && typeof step === 'number' ? { ok: true, timeStep: step } : { ok: false };
}

/** Test/support helper: the code an authenticator would currently show. */
export function currentTotp(secret: string): string {
  return generateSync({ secret });
}

// ---- recovery codes ---------------------------------------------------------

const RECOVERY_COUNT = 10;

/**
 * One-time codes for a lost phone. Shown ONCE at enrolment; only their hashes
 * are stored. 40 bits each, grouped for readability (xxxxx-xxxxx). That is
 * plenty because each is single-use and verification is rate limited.
 */
export function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_COUNT }, () => {
    const raw = randomToken(8).replace(/[-_]/g, '').toLowerCase().slice(0, 10).padEnd(10, '0');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code: string): string {
  return sha256Hex(code.trim().toLowerCase().replace(/\s+/g, ''));
}
