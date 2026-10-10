/**
 * Inbound text messages: the webhook the messaging provider (Twilio) calls when a patient texts
 * the clinic's number.
 *
 *   STOP … (and UNSUBSCRIBE, CANCEL, END, QUIT, STOPALL)  → the number goes on the do-not-text list and
 *        any patient record with it has consent turned OFF; the patient is told ONCE
 *   START, UNSTOP   → the number comes off the list (consent on file is unchanged)
 *   HELP, INFO      → a reply with the clinic's phone number
 *   C               → the patient's next confirmed appointment is marked "confirmed by patient"
 *   anything else   → nothing is sent or stored (what a patient types may be health information)
 *
 * Replies go back as the webhook's own response (TwiML). That is the only way to answer after a
 * STOP — the provider refuses API-initiated sends to a number that opted out — and it keeps the
 * confirmation inside the same request. The wording is in integrations/templates.ts.
 *
 * Security: every request is verified against the provider's signature (HMAC-SHA1 of the public
 * URL plus the sorted form fields, keyed with TWILIO_AUTH_TOKEN). Without a token, production
 * refuses (503) rather than accept anything unsigned; development accepts, so it can be driven by hand.
 * The message BODY is never stored or logged, only the keyword it matched; the phone number is
 * never logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, urlencoded, type Request, type Response } from 'express';
import { config } from '../config.js';
import { basePrisma } from '../lib/prismaBase.js';
import { runAsSystem } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { now } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import { phoneVariants, toE164 } from '../lib/phone.js';
import { liftSuppression, suppressNumber } from '../lib/smsSuppression.js';
import { KEYWORDS, renderTemplate, sanitizeFirstName } from '../integrations/templates.js';

export const smsInboundRouter = Router();

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

type Keyword = 'STOP' | 'START' | 'HELP' | 'CONFIRM' | 'OTHER';

/** Whole-message match, ignoring case and surrounding punctuation/space (carrier rules). */
export function classify(body: string): Keyword {
  const word = body.trim().replace(/^[\s"'.!?,;:]+|[\s"'.!?,;:]+$/g, '').toUpperCase();
  for (const k of ['STOP', 'START', 'HELP', 'CONFIRM'] as const) if ((KEYWORDS[k] as readonly string[]).includes(word)) return k;
  return 'OTHER';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
function twiml(res: Response, reply: string | null) {
  res.status(200).type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${xml(reply)}</Message>` : ''}</Response>`);
}

const clinicPhone = () => config.clinicPhone || '(clinic phone not set)';

smsInboundRouter.post('/sms/inbound', urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  const token = process.env.TWILIO_AUTH_TOKEN ?? '';
  if (!token) {
    if (config.isProduction) {
      logger.warn('sms_inbound_refused', { reason: 'no_auth_token' });
      return res.status(503).json({ error: 'Inbound texts are not configured.' });
    }
  } else if (!validSignature(req, token)) {
    logger.warn('sms_inbound_refused', { reason: 'bad_signature' });
    return res.status(403).type('text').send('Forbidden');
  }

  const from = typeof req.body?.From === 'string' ? req.body.From : '';
  const body = typeof req.body?.Body === 'string' ? req.body.Body : '';
  if (!toE164(from)) return twiml(res, null);          // not a number we could ever have texted
  const keyword = classify(body);
  logger.info('sms_inbound', { keyword });              // the keyword only: never the number or the words

  const at = now();
  const reply = await runAsSystem('sms-inbound', async (): Promise<string | null> => {
    switch (keyword) {
      case 'STOP': {
        const r = await staffTransaction((tx, rec) => suppressNumber(tx, rec, { phone: from, source: 'STOP', at }));
        // Confirm ONCE: only when this STOP changed the number from "may be texted" to "may not".
        return r.changed ? renderTemplate('reply_stop_v2', {}) : null;
      }
      case 'START': {
        const lifted = await staffTransaction((tx, rec) => liftSuppression(tx, rec, from));
        return lifted ? renderTemplate('reply_start_v2', {}) : null;
      }
      case 'HELP':
        return renderTemplate('reply_help_v2', { phone: clinicPhone() });
      case 'CONFIRM':
        return confirmNextAppointment(from, at);
      default:
        return null;
    }
  });
  twiml(res, reply);
});

/** "C": mark the sender's next confirmed appointment as confirmed by them, and thank them. */
async function confirmNextAppointment(from: string, at: Date): Promise<string> {
  const variants = phoneVariants(from);
  // Next confirmed appointment on a patient record with this number, or booked on this number.
  const ids = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT b.id FROM "Booking" b
    JOIN "User" u ON u.id = b."userId"
    LEFT JOIN "Patient" p ON p.id = b."patientId"
    WHERE b.status = 'CONFIRMED' AND b."startTime" > ${at}
      AND (regexp_replace(u.phone, '\\D', '', 'g') = ANY(${variants}) OR p."phoneDigits" = ANY(${variants}))
    ORDER BY b."startTime" ASC LIMIT 1`;
  const id = ids[0]?.id;
  if (!id) return renderTemplate('reply_help_v2', { phone: clinicPhone() });   // nothing upcoming: point them to the clinic

  return staffTransaction(async (tx, rec) => {
    const b = await tx.booking.findUniqueOrThrow({ where: { id }, include: { patient: { select: { firstName: true, preferredName: true } }, user: { select: { name: true } } } });
    if (!b.patientConfirmedAt) {
      await tx.booking.update({ where: { id }, data: { patientConfirmedAt: at } });
      await rec({ action: 'UPDATE', resourceType: 'appointment', resourceId: id, meta: { fields: ['patientConfirmedAt'], via: 'sms_reply' } });
    }
    const first = sanitizeFirstName(b.patient ? (b.patient.preferredName || b.patient.firstName) : (b.user.name.trim().split(/\s+/)[0] ?? ''));
    return renderTemplate('reply_confirmed_v2', { first });
  });
}
