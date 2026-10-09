/**
 * Public (cookie-less) pieces of text-message consent, used by the booking widget.
 *
 *   GET  /api/sms/consent-label            the exact words to put next to the checkbox
 *   POST /api/bookings/:id/sms-consent     record that the person who made THIS booking ticked it
 *
 * The widget renders the label the server gives it and sends it back; the server stores that
 * exact string with the time, and refuses any wording it did not issue. This is a separate
 * endpoint (not a field on POST /api/bookings) so the booking route — the race-proven code
 * the owner asked not to be touched — is not edited.
 *
 * Who can call it: anyone holding the booking id, which only the person who booked receives
 * (and which is a random UUID). To keep that capability short-lived it works only for a request
 * or confirmed appointment created in the last 30 minutes, and only once (a repeat is a no-op).
 */
import { Router } from 'express';
import { z } from 'zod';
import { basePrisma } from '../lib/prismaBase.js';
import { auditInTx } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { withinLimit } from '../lib/rateWindow.js';
import { ACCEPTED_SMS_CONSENT_LABELS, SMS_CONSENT_LABEL } from '../integrations/templates.js';

export const smsPublicRouter = Router();

export const CONSENT_WINDOW_MS = 30 * 60_000;
const PER_HOUR = 30;

smsPublicRouter.get('/sms/consent-label', (_req, res) => {
  res.json({ label: SMS_CONSENT_LABEL });
});

const body = z.object({ label: z.string().max(400) }).strict();

smsPublicRouter.post('/bookings/:id/sms-consent', async (req, res) => {
  if (!withinLimit(`sms-consent:${req.ip ?? 'unknown'}`, PER_HOUR, 3_600_000)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  const parsed = body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Send the consent wording that was shown.' });
  if (!ACCEPTED_SMS_CONSENT_LABELS.includes(parsed.data.label)) {
    // Not something this server issued: refuse rather than store words nobody saw.
    return res.status(400).json({ error: 'That consent wording is out of date. Please reload the page.', code: 'stale_label' });
  }

  const t = now();
  const out = await basePrisma.$transaction(async (tx) => {
    const b = await tx.booking.findUnique({ where: { id: req.params.id ?? '' }, select: { id: true, status: true, createdAt: true, smsConsentAt: true } });
    if (!b || (b.status !== 'PENDING_REVIEW' && b.status !== 'CONFIRMED') || t.getTime() - b.createdAt.getTime() > CONSENT_WINDOW_MS) {
      return { status: 404 as const };
    }
    if (b.smsConsentAt) return { status: 200 as const, consentAt: b.smsConsentAt }; // already recorded: idempotent
    const updated = await tx.booking.update({ where: { id: b.id }, data: { smsConsentAt: t, smsConsentLabel: parsed.data.label }, select: { smsConsentAt: true } });
    // Atomic with the change; no actor (anonymous) — the row says so.
    await auditInTx(tx, { action: 'UPDATE', resourceType: 'appointment', resourceId: b.id, meta: { fields: ['smsConsent'], via: 'public_widget' } });
    return { status: 200 as const, consentAt: updated.smsConsentAt };
  });
  if (out.status === 404) return res.status(404).json({ error: 'We could not find that request.' });
  res.json({ ok: true, consentAt: out.consentAt });
});
