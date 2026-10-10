/**
 * Signed upload URLs for the DEVELOPMENT file-storage stub.
 *
 * A real adapter hands the browser a presigned S3 URL: the browser PUTs the recording straight to
 * the bucket, with no cookie of ours and no custom header, and the signature in the URL is the only
 * authority. The stub works the same way so the browser code is identical in both worlds: the URL it
 * is given names one key, one content type and an expiry, and is signed with a key derived from the
 * server's secret. The route that receives the PUT checks the signature and nothing else.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const subkey = () => createHmac('sha256', config.mfaKey).update('nextwave:dev-storage-upload:v1').digest();

function mac(key: string, contentType: string, exp: number): string {
  return createHmac('sha256', subkey()).update(`PUT\n${key}\n${contentType}\n${exp}`).digest('base64url');
}

export function signUpload(key: string, contentType: string, expiresAt: Date): { exp: number; sig: string } {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return { exp, sig: mac(key, contentType, exp) };
}

export function verifyUpload(key: string, contentType: string, exp: number, sig: string, nowMs = Date.now()): boolean {
  if (!Number.isInteger(exp) || exp * 1000 < nowMs) return false;
  const want = Buffer.from(mac(key, contentType, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
