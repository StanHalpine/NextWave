/**
 * Verifying that a request to one of our webhooks really came from Twilio. Shared by the inbound-message webhook
 * (routes/smsInbound.ts) and the status-callback webhook (routes/smsStatus.ts), so both check exactly the same way.
 *
 * Twilio signs each request: HMAC-SHA1, keyed with TWILIO_AUTH_TOKEN, of the exact public URL it called plus every form field
 * name and value sorted by name, base64-encoded, in the X-Twilio-Signature header. The URL is ours (APP_BASE_URL + the path), so
 * the one Twilio is given must match it character for character.
 *
 * Without a token, production REFUSES (a webhook that accepts anything unsigned is a way in); development accepts, so it can be
 * driven by hand.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';

/** Twilio's request signature for `url` and the form `params`. Exported for tests. */
export function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', token).update(data).digest('base64');
}

function validSignature(req: Request, token: string): boolean {
  const given = req.get('x-twilio-signature');
  if (!given) return false;
  const params = Object.fromEntries(Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  const expected = twilioSignature(token, `${config.appBaseUrl}${req.originalUrl}`, params);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type WebhookCheck =
  | 'ok'
  /** Production with no TWILIO_AUTH_TOKEN: refuse everything (503). */
  | 'not_configured'
  | 'bad_signature';

export function checkTwilioRequest(req: Request): WebhookCheck {
  const token = process.env.TWILIO_AUTH_TOKEN ?? '';
  if (!token) return config.isProduction ? 'not_configured' : 'ok';
  return validSignature(req, token) ? 'ok' : 'bad_signature';
}
