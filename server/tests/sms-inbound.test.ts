import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { classify, twilioSignature } from '../src/routes/smsInbound.js';
import { renderTemplate, REPLIES } from '../src/integrations/templates.js';
import { runAppointmentTexts } from '../src/jobs/appointmentTexts.js';
import type { Messaging } from '../src/integrations/types.js';
import { app, auditRows, blob } from './helpers.js';
import { makeClinic, makePatient, slotAt } from './phase2.js';

const TOKEN = 'test-twilio-auth-token';
const PHONE = '(612) 555-0100';
const URL_ = 'http://localhost:4000/api/sms/inbound';   // APP_BASE_URL in the test environment + the route

let n = 0;
/** A number nobody else in this file uses: 612-555-2xxx. */
const freshNumber = () => { const last4 = String(2000 + ++n + (Date.now() % 500)).padStart(4, '0'); return { e164: `+1612555${last4}`, typed: `(612) 555-${last4}`, digits: `1612555${last4}` }; };

beforeAll(() => { process.env.TWILIO_AUTH_TOKEN = TOKEN; process.env.CLINIC_PHONE = PHONE; });
afterAll(() => { delete process.env.TWILIO_AUTH_TOKEN; delete process.env.CLINIC_PHONE; });

function post(from: string, body: string, opts: { sign?: boolean; token?: string; extra?: Record<string, string> } = {}) {
  const params = { From: from, To: '+16125550999', Body: body, MessageSid: `SM${Math.random().toString(16).slice(2)}`, ...(opts.extra ?? {}) };
  const r = request(app).post('/api/sms/inbound').type('form');
  if (opts.sign !== false) r.set('X-Twilio-Signature', twilioSignature(opts.token ?? TOKEN, URL_, params));
  return r.send(params);
}
const replyOf = (res: request.Response) => /<Message>([\s\S]*)<\/Message>/.exec(res.text)?.[1] ?? null;
const unxml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

describe('keywords', () => {
  it('match the whole message, ignoring case and surrounding punctuation — and nothing longer', () => {
    for (const w of ['STOP', 'stop', ' Stop. ', '"STOP"', 'UNSUBSCRIBE', 'cancel', 'End', 'QUIT', 'stopall']) expect(classify(w), w).toBe('STOP');
    for (const w of ['start', 'UNSTOP']) expect(classify(w), w).toBe('START');
    for (const w of ['help', 'INFO', 'Help!']) expect(classify(w), w).toBe('HELP');
    for (const w of ['C', 'c', ' c. ']) expect(classify(w), w).toBe('CONFIRM');
    for (const w of ['stop texting me please', 'Please stop by tomorrow', 'cancel my appointment', 'CC', 'yes', '', 'help me with my knee']) expect(classify(w), w).toBe('OTHER');
  });
});

describe('the webhook is signed', () => {
  it('refuses a request with no signature, a wrong one, or a body changed after signing — and acts on none of them', async () => {
    const num = freshNumber();
    expect((await post(num.e164, 'STOP', { sign: false })).status).toBe(403);
    expect((await post(num.e164, 'STOP', { token: 'not-the-token' })).status).toBe(403);
    // Signed for one body, sent with another.
    const params = { From: num.e164, To: '+16125550999', Body: 'HELP' };
    const sig = twilioSignature(TOKEN, URL_, params);
    const tampered = await request(app).post('/api/sms/inbound').type('form').set('X-Twilio-Signature', sig).send({ ...params, Body: 'STOP' });
    expect(tampered.status).toBe(403);
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(0);
  });

  it('accepts a correct signature, and answers in TwiML', async () => {
    const r = await post(freshNumber().e164, 'whatever');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/xml/);
    expect(r.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('in production with no token configured, refuses everything (503) rather than trust an unsigned request', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    (config as { isProduction: boolean }).isProduction = true;
    try {
      const num = freshNumber();
      const r = await post(num.e164, 'STOP', { sign: false });
      expect(r.status).toBe(503);
      expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(0);
    } finally {
      (config as { isProduction: boolean }).isProduction = false;
      process.env.TWILIO_AUTH_TOKEN = TOKEN;
    }
  });

  it('in development with no token, accepts an unsigned request so it can be driven by hand', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    try { expect((await post(freshNumber().e164, 'HELP', { sign: false })).status).toBe(200); }
    finally { process.env.TWILIO_AUTH_TOKEN = TOKEN; }
  });

  it('ignores a message from something that is not a phone number', async () => {
    const r = await post('not-a-number', 'STOP');
    expect(r.status).toBe(200);
    expect(replyOf(r)).toBeNull();
  });
});

describe('STOP', () => {
  it('puts the number on the list, turns off every patient record with it, tells the patient once, and audits without the number', async () => {
    const num = freshNumber();
    const a = await makePatient({ phone: num.typed, smsOptIn: true });
    const b = await makePatient({ phone: num.digits, smsOptIn: true });            // the same number typed with a leading 1
    const other = await makePatient({ phone: freshNumber().typed, smsOptIn: true });

    const first = await post(num.e164, 'STOP');
    expect(first.status).toBe(200);
    expect(unxml(replyOf(first)!)).toBe(REPLIES.reply_stop_v2.text);
    expect(first.text).toContain('You&apos;re unsubscribed');                          // the apostrophe is escaped for XML
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: num.digits } })).toMatchObject({ source: 'STOP' });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: a.id } })).smsOptIn).toBe(false);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: b.id } })).smsOptIn).toBe(false);
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: other.id } })).smsOptIn).toBe(true);   // someone else's number: untouched

    const second = await post(num.e164, 'stop');                                     // texting it again: no second confirmation
    expect(replyOf(second)).toBeNull();

    const rows = await auditRows({ resourceType: 'patient', resourceId: a.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('texted_stop');
    const consentRows = await auditRows({ resourceType: 'sms_consent' }, 1);
    expect(blob(consentRows)).not.toContain(num.digits.slice(4));
    expect(rows[0]!.actorRoles).toBe('system:sms-inbound');
  });

  it('is confirmed again when the patient re-consented after the earlier STOP and then stops again', async () => {
    const num = freshNumber();
    const p = await makePatient({ phone: num.typed, smsOptIn: true });
    await post(num.e164, 'STOP');
    await new Promise((r) => setTimeout(r, 20));
    await prisma.patient.update({ where: { id: p.id }, data: { smsOptIn: true, smsOptInAt: new Date() } });   // staff recorded fresh consent
    const again = await post(num.e164, 'STOP');
    expect(unxml(replyOf(again)!)).toBe(REPLIES.reply_stop_v2.text);
  });

  it('is not triggered by a sentence that merely contains the word', async () => {
    const num = freshNumber();
    await makePatient({ phone: num.typed, smsOptIn: true });
    const r = await post(num.e164, 'Please stop by my place tomorrow');
    expect(replyOf(r)).toBeNull();
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(0);
  });
});

describe('START and HELP', () => {
  it('START takes the number off the list and says so; a START from a number that never opted out is silent', async () => {
    const num = freshNumber();
    await post(num.e164, 'STOP');
    const r = await post(num.e164, 'START');
    expect(unxml(replyOf(r)!)).toBe(REPLIES.reply_start_v2.text);
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(0);
    expect(replyOf(await post(freshNumber().e164, 'START'))).toBeNull();
  });

  it('HELP replies with the clinic phone number', async () => {
    const r = await post(freshNumber().e164, 'HELP');
    expect(unxml(replyOf(r)!)).toBe(renderTemplate('reply_help_v2', { phone: PHONE }));
    expect(unxml(replyOf(r)!)).toContain(PHONE);
  });
});

describe('C — the patient confirms', () => {
  async function appointmentFor(patientId: string | null, phoneForContact: string) {
    const clinic = await makeClinic();
    const start = slotAt('10:00', '2030-03-05');                       // far in the future, a Tuesday
    const user = await prisma.user.create({ data: { name: 'Maren Holloway', email: '', phone: phoneForContact } });
    return prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
        startTime: start, endTime: new Date(start.getTime() + 1800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId },
    });
  }

  it('marks the next confirmed appointment on that number as confirmed by the patient, thanks them, and audits it', async () => {
    const num = freshNumber();
    const p = await makePatient({ phone: num.typed, firstName: 'Ingrid' });
    const b = await appointmentFor(p.id, '000');
    const r = await post(num.e164, 'C');
    expect(unxml(replyOf(r)!)).toBe('NextWave Wellness: Thanks Ingrid, your appointment is confirmed.');
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.patientConfirmedAt).not.toBeNull();
    const rows = await auditRows({ resourceType: 'appointment', resourceId: b.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('sms_reply');

    const first = row.patientConfirmedAt!.getTime();
    await post(num.e164, 'c');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).patientConfirmedAt!.getTime()).toBe(first);   // the first reply counts
  });

  it('works for an online booking nobody has linked, matched on the number typed on the form', async () => {
    const num = freshNumber();
    const b = await appointmentFor(null, `612-555-${num.digits.slice(-4)}`);
    const r = await post(num.e164, 'C');
    expect(unxml(replyOf(r)!)).toContain('Thanks Maren');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).patientConfirmedAt).not.toBeNull();
  });

  it('with nothing upcoming, points the patient to the clinic and changes nothing', async () => {
    const r = await post(freshNumber().e164, 'C');
    expect(unxml(replyOf(r)!)).toBe(renderTemplate('reply_help_v2', { phone: PHONE }));
  });

  it('ignores a cancelled appointment', async () => {
    const num = freshNumber();
    const p = await makePatient({ phone: num.typed });
    const b = await appointmentFor(p.id, '000');
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
    await post(num.e164, 'C');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).patientConfirmedAt).toBeNull();
  });
});

describe('what is never kept', () => {
  it('writes neither the sender\'s number nor the words they sent to the logs, whatever they sent', async () => {
    const num = freshNumber();
    const secret = 'my knee surgery went badly and I take lisinopril';
    const seen: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')); }));
    try {
      await post(num.e164, secret);
      await post(num.e164, 'STOP');
      await post(num.e164, 'HELP');
    } finally { spies.forEach((s) => s.mockRestore()); }
    const out = seen.join('\n');
    expect(out).toContain('sms_inbound');
    expect(out).not.toContain(num.digits.slice(4));
    expect(out).not.toContain('lisinopril');
    expect(out).not.toContain('knee');
  });
});

describe('end to end: STOP stops the job, START lets it resume', () => {
  it('a booking-level consent is suppressed by STOP and revives after START; a patient-level one needs staff to re-record', async () => {
    const clinic = await makeClinic();
    const start = slotAt('10:00', '2030-03-12');
    const patNum = freshNumber();
    const bookNum = freshNumber();
    const patient = await makePatient({ phone: patNum.typed, smsOptIn: true });
    const mk = async (patientId: string | null, phone: string, consent: boolean, minutes: number) => {
      const user = await prisma.user.create({ data: { name: 'Maren Holloway', email: '', phone } });
      const s = new Date(start.getTime() + minutes * 60_000);
      return prisma.booking.create({
        data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: s, endTime: new Date(s.getTime() + 1800_000),
          status: 'CONFIRMED', source: 'FRONT_DESK', patientId, smsConsentAt: consent ? new Date(Date.now() - 60_000) : null, smsConsentLabel: consent ? 'x' : null },
      });
    };
    await mk(patient.id, '000', false, 0);          // patient-level consent
    await mk(null, bookNum.typed, true, 60);        // booking-level consent

    const calls: string[] = [];
    const m: Messaging = { async sendSms(i) { calls.push(i.to); return { providerMessageId: 'x' }; } };
    const run = () => runAppointmentTexts({ messaging: m, now: slotAt('12:00', '2030-03-10') });

    await post(patNum.e164, 'STOP');
    await post(bookNum.e164, 'STOP');
    await run();
    expect(calls).not.toContain(patNum.e164);
    expect(calls).not.toContain(bookNum.e164);

    await post(patNum.e164, 'START');
    await post(bookNum.e164, 'START');
    await run();
    expect(calls).toContain(bookNum.e164);          // their own tick is still on the booking → texts resume
    expect(calls).not.toContain(patNum.e164);       // STOP turned the patient's consent OFF; only staff can turn it back on
  });
});
