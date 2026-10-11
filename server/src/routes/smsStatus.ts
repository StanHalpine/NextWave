/**
 * Delivery status callbacks: the webhook Twilio calls as each text we sent moves through queued → sent → delivered (or
 * undelivered / failed). Every message is sent with StatusCallback = {APP_BASE_URL}/api/sms/status (integrations/twilio.ts), so
 * there is nothing to configure in the Twilio console for it.
 *
 *   POST /api/sms/status      form-encoded: MessageSid, MessageStatus, ErrorCode (when it failed), and more we ignore
 *
 * Verified exactly like the inbound webhook (lib/twilioWebhook.ts: the same signature, the same refusal when production has no
 * token). Answers 200 with no body, which is all Twilio asks.
 *
 * What it does with one:
 *   • finds our MessageLog row by the provider's message id (an unknown id is ignored: 200, nothing written);
 *   • records the delivery status and the provider's numeric error code on it — and only moves FORWARD. Callbacks are not
 *     guaranteed to arrive in order and are sometimes repeated, so a late "sent" after "delivered", or a duplicate, changes nothing
 *     (a compare-and-swap on the stored status; a duplicate writes no audit row);
 *   • on error 21610 (the recipient opted out) puts the number on the do-not-text list and turns consent off for every patient
 *     record that has it, audited — the same thing the text job does when Twilio refuses the send itself.
 *
 * Logged: the message SID, the status and the numeric code. Never the body, never a number: the `To` field Twilio sends is used
 * (for 21610 only) and dropped.
 */
import { Router, urlencoded } from 'express';
import { logger } from '../lib/logger.js';
import { runAsSystem } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { prisma } from '../lib/prisma.js';
import { staffTransaction } from '../lib/staffTx.js';
import { toE164 } from '../lib/phone.js';
import { suppressNumber } from '../lib/smsSuppression.js';
import { checkTwilioRequest } from '../lib/twilioWebhook.js';
import { OPTED_OUT_CODE } from '../integrations/twilio.js';

export const smsStatusRouter = Router();

/** How far a message has got. A status only ever replaces a LOWER one. */
export const DELIVERY_RANK: Readonly<Record<string, number>> = { accepted: 1, scheduled: 1, queued: 1, sending: 2, sent: 3, delivered: 4, undelivered: 4, failed: 4 };
const below = (status: string) => Object.entries(DELIVERY_RANK).filter(([, r]) => r < DELIVERY_RANK[status]!).map(([k]) => k);

const SID = /^[A-Za-z0-9-]{8,64}$/;
const WORD = /^[a-z_]{1,24}$/;
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

smsStatusRouter.post('/sms/status', urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
  const check = checkTwilioRequest(req);
  if (check === 'not_configured') {
    logger.warn('sms_status_refused', { reason: 'no_auth_token' });
    return res.status(503).json({ error: 'Status callbacks are not configured.' });
  }
  if (check === 'bad_signature') {
    logger.warn('sms_status_refused', { reason: 'bad_signature' });
    return res.status(403).type('text').send('Forbidden');
  }

  const sid = text(req.body?.MessageSid) || text(req.body?.SmsSid);
  const status = (text(req.body?.MessageStatus) || text(req.body?.SmsStatus)).toLowerCase();
  const code = /^\d{3,6}$/.test(text(req.body?.ErrorCode)) ? Number(text(req.body.ErrorCode)) : null;
  const to = text(req.body?.To);
  if (!SID.test(sid) || !WORD.test(status)) return res.status(400).type('text').send('Bad request');
  if (DELIVERY_RANK[status] === undefined) {
    logger.info('sms_status_ignored', { providerMessageId: sid, status });           // a status we do not track (e.g. "read")
    return res.status(200).end();
  }

  const row = await prisma.messageLog.findFirst({ where: { providerMessageId: sid }, orderBy: { queuedAt: 'desc' }, select: { id: true, bookingId: true } });
  if (!row) {
    logger.info('sms_status_unknown_message', { providerMessageId: sid, status });
    return res.status(200).end();
  }

  const at = now();
  const applied = await runAsSystem('sms-status', () => staffTransaction(async (tx, rec) => {
    // Compare-and-swap: only a status that is further along than the stored one is written, so a late, repeated or racing callback is a no-op.
    const swap = await tx.messageLog.updateMany({
      where: { id: row.id, OR: [{ deliveryStatus: null }, { deliveryStatus: { in: below(status) } }] },
      data: { deliveryStatus: status, deliveryUpdatedAt: at, ...(code !== null ? { providerErrorCode: code } : {}) },
    });
    if (swap.count !== 1) return false;
    await rec({ action: 'UPDATE', resourceType: 'message', resourceId: row.id, meta: { to: status, outcome: 'delivery_status', ...(code !== null ? { errorCode: code } : {}) } });

    if (code === OPTED_OUT_CODE && (status === 'failed' || status === 'undelivered')) {
      // The recipient opted out: do-not-text list, consent off on every patient record with the number, audited (suppressNumber does both).
      // Twilio's own `To` is the number that opted out; failing that, the number on the booking.
      const b = to && toE164(to) ? null : await tx.booking.findUnique({ where: { id: row.bookingId }, select: { patient: { select: { phone: true } }, user: { select: { phone: true } } } });
      const phone = to && toE164(to) ? to : (b?.patient?.phone ?? b?.user.phone ?? null);
      if (phone) await suppressNumber(tx, rec, { phone, source: 'PROVIDER', at });
      else logger.warn('sms_status_opt_out_unresolved', { providerMessageId: sid });
    }
    return true;
  }));

  logger.info('sms_status', { providerMessageId: sid, status, errorCode: code, applied });
  res.status(200).end();
});
