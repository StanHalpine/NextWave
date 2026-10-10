import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '../src/lib/prisma.js';
import { runAppointmentTexts } from '../src/jobs/appointmentTexts.js';
import { MessagingError, type Messaging } from '../src/integrations/types.js';
import { SMS_CONSENT_LABEL } from '../src/integrations/templates.js';
import { resetRateWindows } from '../src/lib/rateWindow.js';
import { app, auditRows, makeAccount, signInFully, uniqueEmail } from './helpers.js';

/** Noon clinic time, two days before an appointment: inside sending hours whatever the real time of day, and well before the start. */
const jobNow = (start: Date) => slotAt('12:00', DateTime.fromJSDate(start, { zone: 'America/Chicago' }).minus({ days: 2 }).toFormat('yyyy-MM-dd'));
import { DateTime } from 'luxon';
import { futureTuesday, makeClinic, makePatient, patch, slotAt } from './phase2.js';

const LABEL = 'Text me appointment confirmations and reminders. Msg & data rates may apply. Reply STOP to opt out.';

beforeEach(() => resetRateWindows());

/** A booking made the way the public does: availability → hold → booking request. Returns its id. */
async function publicBooking(clinic: Awaited<ReturnType<typeof makeClinic>>, phone = '(612) 555-0177', name = 'Online Visitor') {
  const date = futureTuesday(3);
  const av = await request(app).get(`/api/availability?serviceId=${clinic.service.id}&date=${date}`);
  const slot = av.body.slots[Math.floor(Math.random() * av.body.slots.length)];
  const hold = await request(app).post('/api/holds').send({ serviceId: clinic.service.id, start: slot.start });
  expect(hold.status).toBe(201);
  const holdId = hold.body.holdId ?? hold.body.id ?? hold.body.hold?.id;
  const b = await request(app).post('/api/bookings').send({ holdId, name, email: uniqueEmail('online'), phone });
  expect(b.status).toBe(201);
  return { id: b.body.bookingId as string, start: new Date(b.body.start) };
}

function fakeMessaging(behave?: (n: number) => void) {
  const calls: Array<{ to: string; templateId: string; variables: Record<string, string> }> = [];
  const m: Messaging = { async sendSms(i) { calls.push(i); behave?.(calls.length); return { providerMessageId: `fake-${calls.length}` }; } };
  return { m, calls };
}

describe('the consent wording', () => {
  it('is exactly what the owner specified, served from one place', async () => {
    expect(SMS_CONSENT_LABEL).toBe(LABEL);
    const r = await request(app).get('/api/sms/consent-label');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ label: LABEL });
  });

  it('is on the public page as a checkbox that is UNCHECKED by default and filled from the server', () => {
    const html = readFileSync(path.resolve('public', 'index.html'), 'utf8');
    const tag = html.match(/<input[^>]*id="sms-consent"[^>]*>/)![0];
    expect(tag).toContain('type="checkbox"');
    expect(tag).not.toMatch(/\bchecked\b/);
    expect(html).toContain('id="sms-consent-label"');
    expect(html).not.toContain(LABEL);                               // never hard-coded on the page: the server's words are shown
    const js = readFileSync(path.resolve('public', 'booking.js'), 'utf8');
    expect(js).toContain('/api/sms/consent-label');
    expect(js).toContain("/sms-consent'");                          // and sent back with the tick
  });

  it('sits in a card titled "Appointment notifications" that links to the SMS terms and the privacy policy', () => {
    const html = readFileSync(path.resolve('public', 'index.html'), 'utf8');
    const card = html.match(/<div class="consent-card"[\s\S]*?<\/div>/)![0];
    expect(card).toContain('id="sms-consent-row"');
    expect(card).toContain('hidden');                                                       // hidden until the wording has loaded
    expect(card).toMatch(/<h3[^>]*>Appointment notifications<\/h3>/);
    expect(card).toContain('href="https://nextwave-wellness.com/sms-terms.html"');
    expect(card).toContain('href="https://nextwave-wellness.com/privacy.html"');
    // The links are OUTSIDE the label that is stored with the tick, so they cannot change what was consented to.
    const label = card.match(/<label class="consent">[\s\S]*?<\/label>/)![0];
    expect(label).not.toContain('href');
    expect(html.indexOf('consent-card')).toBeLessThan(html.indexOf('id="submit-btn"'));
  });
});

describe('recording consent on a public booking', () => {
  it('stores the time and the exact words, atomically with an audit row, only once', async () => {
    const clinic = await makeClinic();
    const { id } = await publicBooking(clinic);
    const before = Date.now();
    const r = await request(app).post(`/api/bookings/${id}/sms-consent`).send({ label: LABEL });
    expect(r.status).toBe(200);
    const row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.smsConsentLabel).toBe(LABEL);
    expect(row.smsConsentAt!.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(row.smsConsentAt!.getTime()).toBeLessThanOrEqual(Date.now() + 2000);

    // (The public booking flow audits its own hold → request update; pick out the consent row.)
    const consentRows = async () => (await auditRows({ resourceType: 'appointment', resourceId: id, action: 'UPDATE' }, 2)).filter((r) => JSON.stringify(r.meta).includes('smsConsent'));
    const rows = await consentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBeNull();                        // anonymous: the row says so
    expect(JSON.stringify(rows[0]!.meta)).toContain('public_widget');

    const again = await request(app).post(`/api/bookings/${id}/sms-consent`).send({ label: LABEL });
    expect(again.status).toBe(200);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).smsConsentAt!.getTime()).toBe(row.smsConsentAt!.getTime());
    expect(await consentRows()).toHaveLength(1);                       // a repeat writes nothing
  });

  it('records NOTHING when the box was not ticked (no request is made), and refuses words the server did not issue', async () => {
    const clinic = await makeClinic();
    const { id } = await publicBooking(clinic);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).smsConsentAt).toBeNull();

    const forged = await request(app).post(`/api/bookings/${id}/sms-consent`).send({ label: 'Yes, text me anything.' });
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe('stale_label');
    expect((await request(app).post(`/api/bookings/${id}/sms-consent`).send({})).status).toBe(400);
    expect((await request(app).post(`/api/bookings/${id}/sms-consent`).send({ label: LABEL, extra: 1 })).status).toBe(400);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).smsConsentAt).toBeNull();
  });

  it('works only for a live request made in the last 30 minutes — not an unknown, old, or cancelled booking', async () => {
    const clinic = await makeClinic();
    expect((await request(app).post('/api/bookings/not-a-booking/sms-consent').send({ label: LABEL })).status).toBe(404);

    const old = await publicBooking(clinic);
    await prisma.booking.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    expect((await request(app).post(`/api/bookings/${old.id}/sms-consent`).send({ label: LABEL })).status).toBe(404);

    const cancelled = await publicBooking(clinic);
    await prisma.booking.update({ where: { id: cancelled.id }, data: { status: 'CANCELLED' } });
    expect((await request(app).post(`/api/bookings/${cancelled.id}/sms-consent`).send({ label: LABEL })).status).toBe(404);
  });

  it('is rate limited per address', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await request(app).post(`/api/bookings/nope-${i}/sms-consent`).send({ label: LABEL })).status;
    expect(last).toBe(429);
  });

  it('does not change what the booking route accepts or returns', async () => {
    const clinic = await makeClinic();
    const { id } = await publicBooking(clinic);
    const status = await request(app).get(`/api/bookings/${id}`);
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain('smsConsent');       // consent is not echoed to the public
  });
});

describe('texting a booking that carries its own consent', () => {
  async function confirmed(clinic: Awaited<ReturnType<typeof makeClinic>>, over: { phone?: string; name?: string; consent?: boolean } = {}) {
    const { id, start } = await publicBooking(clinic, over.phone ?? '(612) 555-0188', over.name ?? 'Maren Holloway');
    if (over.consent !== false) await request(app).post(`/api/bookings/${id}/sms-consent`).send({ label: LABEL });
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    expect((await patch(fd, `/api/bookings/${id}`, { status: 'CONFIRMED' })).status).toBe(200);
    return { id, start, fd };
  }
  it('texts an UNLINKED online booking whose checkbox was ticked — to the number typed on the form, by first name', async () => {
    const clinic = await makeClinic();
    const { id, start } = await confirmed(clinic);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: jobNow(start) });
    const mine = calls.filter((c) => c.to === '+16125550188');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ templateId: 'appt_confirmation_v2' });
    expect(mine[0]!.variables.first).toBe('Maren');                        // first word of the name, sanitised
    expect(Object.keys(mine[0]!.variables).sort()).toEqual(['day', 'first', 'time']);

    const log = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: id } });
    expect(log).toMatchObject({ status: 'SENT', patientId: null, kind: 'CONFIRMATION' });
  });

  it('does NOT text an online booking whose box was left unticked', async () => {
    const clinic = await makeClinic();
    const { start } = await confirmed(clinic, { phone: '(612) 555-0189', consent: false });
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: jobNow(start) });
    expect(calls.filter((c) => c.to === '+16125550189')).toHaveLength(0);
  });

  it('does not text a number that said STOP after consenting — and does again once NEWER consent exists', async () => {
    const clinic = await makeClinic();
    const first = await confirmed(clinic, { phone: '(612) 555-0190' });
    const consentAt = (await prisma.booking.findUniqueOrThrow({ where: { id: first.id } })).smsConsentAt!;
    await prisma.smsSuppression.create({ data: { phoneDigits: '16125550190', suppressedAt: new Date(consentAt.getTime() + 1), source: 'STOP' } });

    const stopped = fakeMessaging();
    await runAppointmentTexts({ messaging: stopped.m, now: jobNow(first.start) });
    expect(stopped.calls.filter((c) => c.to === '+16125550190')).toHaveLength(0);

    // A newer tick on a new booking from the same number (spelled differently) overrides the older STOP.
    await new Promise((r) => setTimeout(r, 25));
    const second = await confirmed(clinic, { phone: '612.555.0190' });
    const after = fakeMessaging();
    await runAppointmentTexts({ messaging: after.m, now: jobNow(new Date(Math.min(first.start.getTime(), second.start.getTime()))) });
    const mine = after.calls.filter((c) => c.to === '+16125550190');
    expect(mine.length).toBeGreaterThan(0);
    // …but only the NEW booking is texted; the old tick is still older than the STOP.
    expect(await prisma.messageLog.count({ where: { bookingId: first.id } })).toBe(0);
    expect(await prisma.messageLog.count({ where: { bookingId: second.id } })).toBe(1);
  });

  it('treats two spellings of one number as one: a patient whose phone was typed with a leading 1 is suppressed by a STOP from 10 digits', async () => {
    const patient = await makePatient({ phone: '16125550191', smsOptIn: true });
    const clinic = await makeClinic();
    const start = slotAt('10:00', futureTuesday(2));
    const user = await prisma.user.create({ data: { name: 'x', email: '', phone: '000' } });
    await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
        startTime: start, endTime: new Date(start.getTime() + 1800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id },
    });
    await prisma.smsSuppression.create({ data: { phoneDigits: '16125550191', suppressedAt: new Date(), source: 'STOP' } });
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: jobNow(start) });
    expect(calls.filter((c) => c.to === '+16125550191')).toHaveLength(0);
  });

  it('a provider "opted out" failure puts the number on the list, so it is never retried or re-texted', async () => {
    const clinic = await makeClinic();
    const { id, start } = await confirmed(clinic, { phone: '(612) 555-0192' });
    const { m, calls } = fakeMessaging(() => { throw new MessagingError('opted_out'); });
    await runAppointmentTexts({ messaging: m, now: jobNow(start) });
    expect(calls.filter((c) => c.to === '+16125550192')).toHaveLength(1);
    expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: id } })).toMatchObject({ status: 'FAILED', failureCode: 'opted_out' });
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: '16125550192' } })).toMatchObject({ source: 'PROVIDER' });
    const again = fakeMessaging();
    await runAppointmentTexts({ messaging: again.m, now: new Date(jobNow(start).getTime() + 3_600_000) });
    expect(again.calls.filter((c) => c.to === '+16125550192')).toHaveLength(0);
  });

  it('shows staff where consent came from', async () => {
    const clinic = await makeClinic();
    const { id, fd } = await confirmed(clinic, { phone: '(612) 555-0193' });
    const r = await fd.agent.get(`/api/schedule/appointments/${id}`);
    expect(r.body.appointment.patient.texts).toBe('online');
    expect(r.body.appointment.patient.linked).toBe(false);
  });
});
