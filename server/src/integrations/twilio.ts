/**
 * The real text-message provider: Twilio, behind the same `Messaging` interface the local stub implements.
 *
 * WHEN IT IS USED — only when BOTH TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set and NODE_ENV is not "test"
 * (twilioSendingConfigured). Otherwise the app stays on the stub, which sends nothing. One of the two alone leaves it on
 * the stub (and says so in the log, naming the variable that is missing — never a value).
 *
 * WHAT IT SENDS — POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json, form-encoded, HTTP Basic with the
 * account SID and auth token. Parameters: To, From (TWILIO_FROM_NUMBER, default the registered toll-free number), Body (the
 * rendered template — renderTemplate() enforces "first name, day, time and nothing else"), and StatusCallback
 * ({APP_BASE_URL}/api/sms/status), so Twilio reports delivery to routes/smsStatus.ts.
 *
 * WHAT IT NEVER DOES — log or store a message body, a recipient number, or Twilio's error text (which can echo the number).
 * Log lines carry the message SID, the status, a numeric error code and the template id. A failure leaves here as a CATEGORY
 * (MessagingError) plus the numeric code; the text job decides what to do with it.
 *
 *   21610                              the recipient opted out    → 'opted_out' (the job turns consent off and audits it)
 *   21211 21214 21217 21401 21612 21614 not a number that can receive texts → 'invalid_recipient' (no retry)
 *   network, timeout, 429, 5xx, 21611  → 'transient' (retried with backoff)
 *   401 / 403                          → 'transient', and an ERROR in the log: the credentials are wrong or revoked; the text is
 *                                        retried for a while in case they are fixed, then fails
 *   any other 4xx                      → 'rejected' (no retry)
 *
 * ONE LIMIT, stated plainly: if Twilio accepts a message but the reply is lost (a timeout after the request was sent), the retry
 * sends it a second time. The API has no idempotency key for messages; the window is the request timeout.
 */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { renderTemplate } from './templates.js';
import { MessagingError, type Messaging, type MessagingFailure } from './types.js';

export const OPTED_OUT_CODE = 21610;
const INVALID_RECIPIENT_CODES = new Set([21211, 21214, 21217, 21401, 21612, 21614]);
const TRANSIENT_CODES = new Set([21611, 20429]);

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** E.164 sender (the registered toll-free number). */
  from: string;
  /** Where Twilio reports status: {APP_BASE_URL}/api/sms/status. */
  statusCallbackUrl: string;
  /** Tests point this at a local fake. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** True only with BOTH credentials set and outside the test run: the one rule for "send for real". */
export function twilioSendingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.TWILIO_ACCOUNT_SID ?? '').trim() && !!(env.TWILIO_AUTH_TOKEN ?? '').trim() && env.NODE_ENV !== 'test';
}

/** Which of the two credentials is missing, when exactly one is set — for a warning that names the variable, not a value. */
export function twilioMissingCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  const sid = !!(env.TWILIO_ACCOUNT_SID ?? '').trim();
  const token = !!(env.TWILIO_AUTH_TOKEN ?? '').trim();
  if (sid === token) return null;
  return sid ? 'TWILIO_AUTH_TOKEN' : 'TWILIO_ACCOUNT_SID';
}

/** Why a status-callback address would be refused by Twilio (or by us), or null when it is fine. */
export function statusCallbackProblem(url: string, requireHttps: boolean): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'APP_BASE_URL is not a valid address.'; }
  if (requireHttps && u.protocol !== 'https:') return 'APP_BASE_URL must be an https:// address for Twilio status callbacks.';
  if (u.hostname.includes('_')) return 'APP_BASE_URL has an underscore in its host name, which Twilio refuses in a callback address.';
  return null;
}

export class TwilioMessaging implements Messaging {
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: TwilioOptions) {
    // A pasted auth token (32 hex, no "AC") or a stray space is caught here, at start-up, rather than as a 401 on the first text.
    if (!/^AC[0-9a-fA-F]{32}$/.test(o.accountSid)) throw new Error('Refusing to start: TWILIO_ACCOUNT_SID must be a Twilio account SID ("AC" followed by 32 hex characters).');
    if (!o.authToken) throw new Error('Refusing to start: TWILIO_AUTH_TOKEN is empty.');
    this.auth = `Basic ${Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64')}`;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** From the environment, as the app builds it at start-up. Refuses to build a callback address Twilio would reject. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TwilioMessaging {
    const statusCallbackUrl = `${config.appBaseUrl}/api/sms/status`;
    const problem = statusCallbackProblem(statusCallbackUrl, config.isProduction);
    if (problem) throw new Error(`Refusing to start: ${problem}`);
    return new TwilioMessaging({
      accountSid: (env.TWILIO_ACCOUNT_SID ?? '').trim(), authToken: (env.TWILIO_AUTH_TOKEN ?? '').trim(),
      from: config.twilioFromNumber, statusCallbackUrl,
    });
  }

  async sendSms(input: { to: string; templateId: string; variables: Record<string, string> }): Promise<{ providerMessageId: string }> {
    const body = renderTemplate(input.templateId, input.variables);          // throws on anything but the allowed three fields
    const form = new URLSearchParams({ To: input.to, From: this.o.from, Body: body, StatusCallback: this.o.statusCallbackUrl });
    const url = `${this.o.baseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${this.o.accountSid}/Messages.json`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch {
      // A network error or a timeout. Its message can contain the address we called; say only that it happened.
      logger.warn('twilio_request_failed', { templateId: input.templateId, reason: 'network_or_timeout' });
      throw new MessagingError('transient');
    }

    const payload = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) throw this.refusal(res.status, payload, input.templateId);

    const sid = typeof payload?.sid === 'string' ? payload.sid : '';
    if (!/^[A-Za-z0-9]{10,64}$/.test(sid)) {
      // Accepted, but we cannot tell which message it was. Do not retry: that could send it twice.
      logger.error('twilio_response_unreadable', new MessagingError('rejected'), { templateId: input.templateId, httpStatus: res.status });
      throw new MessagingError('rejected');
    }
    // A message can be accepted and already failed (error_code set); treat that exactly like a refusal.
    const code = typeof payload?.error_code === 'number' ? payload.error_code : null;
    const status = typeof payload?.status === 'string' ? payload.status : 'unknown';
    if (code !== null && (status === 'failed' || status === 'undelivered')) {
      logger.info('twilio_message_failed_on_create', { providerMessageId: sid, status, errorCode: code, templateId: input.templateId });
      throw new MessagingError(this.categoryFor(code), code);
    }
    logger.info('twilio_message_accepted', { providerMessageId: sid, status, templateId: input.templateId });
    return { providerMessageId: sid };
  }

  private categoryFor(code: number): MessagingFailure {
    if (code === OPTED_OUT_CODE) return 'opted_out';
    if (INVALID_RECIPIENT_CODES.has(code)) return 'invalid_recipient';
    if (TRANSIENT_CODES.has(code)) return 'transient';
    return 'rejected';
  }

  private refusal(httpStatus: number, payload: Record<string, unknown> | null, templateId: string): MessagingError {
    const code = typeof payload?.code === 'number' ? payload.code : undefined;
    if (httpStatus === 401 || httpStatus === 403) {
      logger.error('twilio_credentials_rejected', new MessagingError('transient', code), { httpStatus, errorCode: code ?? null, templateId });
      return new MessagingError('transient', code);
    }
    if (httpStatus === 429 || httpStatus >= 500) {
      logger.warn('twilio_unavailable', { httpStatus, errorCode: code ?? null, templateId });
      return new MessagingError('transient', code);
    }
    const failure = code === undefined ? 'rejected' : this.categoryFor(code);
    logger.info('twilio_message_refused', { httpStatus, errorCode: code ?? null, category: failure, templateId });
    return new MessagingError(failure, code);
  }
}
