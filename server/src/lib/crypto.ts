/**
 * Small, boring primitives. Nothing here invents cryptography — it wraps
 * node:crypto's AES-256-GCM and SHA-256 behind names that say what they are for.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** URL/cookie-safe random token. 32 bytes = 256 bits of entropy by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash for LOOKUP of high-entropy random tokens (session cookies, setup links,
 * recovery codes). SHA-256 is correct here — and a slow password hash would be
 * wrong — because the input is 256 random bits, not a human-chosen secret, so
 * there is nothing to brute-force. Storing only the hash means a database read
 * cannot be replayed as a login.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const VERSION = 'v1';

/**
 * Encrypt a small secret (a TOTP seed) for storage. AES-256-GCM, fresh random
 * 96-bit IV per call, authenticated — a tampered ciphertext fails to decrypt
 * rather than yielding garbage. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 *
 * Reversible by necessity: a TOTP seed must be recoverable to verify codes, so
 * unlike a password it cannot be hashed. The key lives in the environment
 * (MFA_ENCRYPTION_KEY), never in the database it protects.
 */
export function encryptSecret(plain: string, key: Buffer = config.mfaKey): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(blob: string, key: Buffer = config.mfaKey): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== VERSION || !iv || !tag || !ct) throw new Error('Unrecognised secret format.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
