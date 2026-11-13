import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../src/lib/prisma.js';
import { config, type BookingMode } from '../src/config.js';
import { runAppointmentTexts } from '../src/jobs/appointmentTexts.js';
import { TwilioMessaging } from '../src/integrations/twilio.js';
import { smsAllowList } from '../src/integrations/smsAllowList.js';
import { MessagingError } from '../src/integrations/types.js';
import { twilioSignature } from '../src/routes/smsInbound.js';
import { app, auditRows, blob } from './helpers.js';
import { makeClinic, makePatient } from './phase2.js';

/**
 * The staging guard on outbound texts (integrations/smsAllowList.ts). Outside live mode the Twilio adapter texts ONLY the numbers in
 * SMS_ALLOWED_NUMBERS; anyone else is skipped before anything reaches Twilio, and an empty list sends nothing. In live mode the list
 * is ignored. Inbound STOP / START / HELP / C work for any number. The adapter is driven against a local fake Twilio — no network.
 */

const SID = `AC${'b2'.repeat(16)}`;                 // the shape of an account SID, and nothing real
const TOKEN = 'test-twilio-auth-token';
const FROM = '+18665241007';
const CALLBACK = 'https://app.example.test/api/sms/status';

interface Seen { form: Record<string, string> }
let server: http.Server;
let baseUrl = '';
let seen: Seen[] = [];

beforeAll(async () => {
  process.env.TWILIO_AUTH_TOKEN = TOKEN;              // the inbound webhook's signature key
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ form: Object.fromEntries(new URLSearchParams(data)) });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: 'SMfeedfacefeedfacefeedfacefeedface', status: 'queued', error_code: null }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  server.closeAllConnections?.();
  await new Promise((ok) => server.close(ok));
});
afterEach(() => { vi.restoreAllMocks(); seen = []; });

const adapter = (allowedRecipients: ReadonlySet<string> | null) =>
  new TwilioMessaging({ accountSid: SID, authToken: TOKEN, from: FROM, statusCallbackUrl: CALLBACK, baseUrl, allowedRecipients });
const reminder = (to: string) => ({ to, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } });

/** Everything the app writes to its logs while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
  try { return { result: await fn(), text: lines.join('\n') }; } finally { spies.forEach((s) => s.mockRestore()); }
}

let n = 0;
/** A number nobody else uses: 612-555-4xxx. */
const freshNumber = () => { const last4 = String(4000 + ++n + (Date.now() % 500)).padStart(4, '0'); return { e164: `+1612555${last4}`, typed: `(612) 555-${last4}`, digits: `1612555${last4}`, last4 }; };

// ---------------------------------------------------------------------------------------------------
describe('the list, from BOOKING_MODE and SMS_ALLOWED_NUMBERS', () => {
  it('outside live mode: exactly the numbers given; unset or empty is an EMPTY list (send nothing), not "no restriction"', () => {
    for (const mode of ['demo', 'beta', 'coming_soon'] as BookingMode[]) {
      expect([...smsAllowList(mode, '+16125550142, +16125550199 ,')!]).toEqual(['+16125550142', '+16125550199']);
      expect(smsAllowList(mode, undefined)!.size, mode).toBe(0);
      expect(smsAllowList(mode, '')!.size, mode).toBe(0);
      expect(smsAllowList(mode, ' , ')!.size, mode).toBe(0);
    }
  });

  it('in live mode: no restriction (null), whatever the variable holds', () => {
    expect(smsAllowList('live', '+16125550142')).toBeNull();
    expect(smsAllowList('live', undefined)).toBeNull();
    expect(smsAllowList('live', 'not a number')).toBeNull();
  });

  it('refuses a malformed entry at start-up, naming its position — never the value', () => {
    expect(() => smsAllowList('demo', '+16125550142,612-555-0199')).toThrow(/SMS_ALLOWED_NUMBERS entry 2 is not a phone number in E\.164 form/);
    try { smsAllowList('demo', '+16125550142,612-555-0199'); } catch (e) { expect(String(e)).not.toContain('555-0199'); }
    expect(() => smsAllowList('demo', '16125550142')).toThrow(/entry 1/);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the Twilio adapter', () => {
  it('sends to an allow-listed number', async () => {
    const ok = freshNumber();
    const { providerMessageId } = await adapter(new Set([ok.e164])).sendSms(reminder(ok.e164));
    expect(providerMessageId).toBe('SMfeedfacefeedfacefeedfacefeedface');
    expect(seen.map((s) => s.form.To)).toEqual([ok.e164]);
  });

  it('skips any other number before anything reaches Twilio — "not allow-listed" in the log, and no number or words', async () => {
    const ok = freshNumber();
    const other = freshNumber();
    const { text } = await logged(async () => {
      await expect(adapter(new Set([ok.e164])).sendSms(reminder(other.e164))).rejects.toMatchObject({ failure: 'not_allow_listed' });
    });
    expect(seen).toHaveLength(0);
    expect(text).toContain('twilio_message_skipped');
    expect(text).toContain('not allow-listed');
    for (const leak of [other.e164, other.last4, ok.last4, 'Ingrid', 'Reminder for']) expect(text, leak).not.toContain(leak);
  });

  it('with an empty list sends nothing at all', async () => {
    const empty = adapter(new Set());
    for (const num of [freshNumber(), freshNumber(), freshNumber()]) {
      const err = await empty.sendSms(reminder(num.e164)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MessagingError);
      expect((err as MessagingError).failure).toBe('not_allow_listed');
    }
    expect(seen).toHaveLength(0);
  });

  it('with no restriction (live mode) sends to anyone', async () => {
    const a = freshNumber();
    const b = freshNumber();
    await adapter(null).sendSms(reminder(a.e164));
    await adapter(null).sendSms(reminder(b.e164));
    expect(seen.map((s) => s.form.To)).toEqual([a.e164, b.e164]);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('built from the environment', () => {
  const env = (list?: string) => ({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, ...(list === undefined ? {} : { SMS_ALLOWED_NUMBERS: list }) }) as NodeJS.ProcessEnv;
  const listOf = (m: TwilioMessaging) => (m as unknown as { o: { allowedRecipients: ReadonlySet<string> | null } }).o.allowedRecipients;
  const withMode = async <T>(mode: BookingMode, fn: () => Promise<T> | T): Promise<T> => {
    const saved = config.bookingMode;
    (config as { bookingMode: BookingMode }).bookingMode = mode;
    try { return await fn(); } finally { (config as { bookingMode: BookingMode }).bookingMode = saved; }
  };

  it('outside live mode carries the list — and with the variable unset, an empty one; the count is logged, never the numbers', async () => {
    const ok = freshNumber();
    const { text } = await logged(() => withMode('demo', () => {
      expect([...listOf(TwilioMessaging.fromEnv(env(ok.e164)))!]).toEqual([ok.e164]);
      expect(listOf(TwilioMessaging.fromEnv(env()))!.size).toBe(0);
    }));
    expect(text).toContain('sms_allow_list_active');
    expect(text).not.toContain(ok.last4);
    // An empty list refuses before any request is built, so this proves "nothing at all" without a network call.
    await withMode('demo', () => expect(TwilioMessaging.fromEnv(env()).sendSms(reminder(ok.e164))).rejects.toMatchObject({ failure: 'not_allow_listed' }));
  });

  it('in live mode ignores the list (no restriction), and says so when one is set', async () => {
    const ok = freshNumber();
    const { text } = await logged(() => withMode('live', () => {
      expect(listOf(TwilioMessaging.fromEnv(env(ok.e164)))).toBeNull();
      expect(listOf(TwilioMessaging.fromEnv(env()))).toBeNull();
    }));
    expect(text).toContain('sms_allow_list_ignored');
    expect(text).not.toContain(ok.last4);
  });

  it('refuses to start on a malformed entry outside live mode', async () => {
    await withMode('demo', () => expect(() => TwilioMessaging.fromEnv(env('+16125550142,not-a-number'))).toThrow(/entry 2/));
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the text job through the guarded adapter', () => {
  // 2038, so the job's pass reaches almost nothing the other files left behind.
  const NOW = new Date('2038-03-01T17:00:00Z');                                           // Mon 11:00 CST, inside sending hours
  const START = new Date('2038-03-03T16:00:00Z');                                         // Wed 10:00 CST: a confirmation, no reminder yet
  async function appointment(phone: { typed: string }, firstName: string) {
    const clinic = await makeClinic({ weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const patient = await makePatient({ phone: phone.typed, smsOptIn: true, firstName });
    const user = await prisma.user.create({ data: { name: 'c', email: '', phone: '6125550000' } });
    const booking = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: START, endTime: new Date(START.getTime() + 1_800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id },
    });
    return { patient, booking };
  }

  it('texts the allow-listed patient, skips the other for good — consent and the do-not-text list untouched, ids only in the log', async () => {
    const listed = freshNumber();
    const other = freshNumber();
    const a = await appointment(listed, 'Astrid');
    const b = await appointment(other, 'Birgit');
    const guarded = adapter(new Set([listed.e164]));

    const { text } = await logged(async () => {
      await runAppointmentTexts({ messaging: guarded, now: NOW });
      await runAppointmentTexts({ messaging: guarded, now: new Date(NOW.getTime() + 3 * 3_600_000) });   // a later pass: not retried
    });

    expect(seen.map((s) => s.form.To).filter((to) => to === listed.e164 || to === other.e164)).toEqual([listed.e164]);
    expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: a.booking.id } })).toMatchObject({ status: 'SENT', failureCode: null });
    const skipped = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.booking.id } });
    expect(skipped).toMatchObject({ status: 'SKIPPED', failureCode: 'not_allow_listed', nextAttemptAt: null, providerMessageId: null, attempts: 1 });
    expect(await prisma.messageLog.count({ where: { bookingId: b.booking.id } })).toBe(1);

    // Not an opt-out: consent stays on and the number is not suppressed.
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: b.patient.id } })).smsOptIn).toBe(true);
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: other.digits } })).toBe(0);

    // The log says why, by ids; never the number or the name. The audit row carries the outcome, not the number.
    expect(text).toContain('sms_skipped');
    expect(text).toContain('not allow-listed');
    expect(text).toContain(skipped.id);
    for (const leak of [other.e164, other.last4, other.typed, 'Birgit']) expect(text, leak).not.toContain(leak);
    const audit = await auditRows({ resourceType: 'message', resourceId: skipped.id });
    expect(blob(audit)).toContain('skipped');
    expect(blob(audit)).not.toContain(other.last4);
  });
});

// ---------------------------------------------------------------------------------------------------
describe('inbound texts are not affected', () => {
  const URL_ = 'http://localhost:4000/api/sms/inbound';
  const post = (from: string, body: string) => {
    const params = { From: from, To: '+16125550999', Body: body, MessageSid: `SM${Math.random().toString(16).slice(2)}` };
    return request(app).post('/api/sms/inbound').type('form').set('X-Twilio-Signature', twilioSignature(TOKEN, URL_, params)).send(params);
  };
  const replyOf = (res: request.Response) => /<Message>([\s\S]*)<\/Message>/.exec(res.text)?.[1] ?? null;

  it('STOP, START, HELP and C work for a number that is on no allow-list, outside live mode', async () => {
    expect(config.bookingMode).not.toBe('live');
    const saved = process.env.SMS_ALLOWED_NUMBERS;
    process.env.SMS_ALLOWED_NUMBERS = '+16125550142';                                      // some other number
    try {
      const num = freshNumber();
      const { booking } = await appointment(num);

      const help = await post(num.e164, 'HELP');
      expect(help.status).toBe(200);
      expect(replyOf(help)).toBeTruthy();

      const c = await post(num.e164, 'C');
      expect(c.status).toBe(200);
      expect(replyOf(c)).toBeTruthy();
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).patientConfirmedAt).not.toBeNull();

      const stop = await post(num.e164, 'STOP');
      expect(stop.status).toBe(200);
      expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(1);

      const start = await post(num.e164, 'START');
      expect(start.status).toBe(200);
      expect(await prisma.smsSuppression.count({ where: { phoneDigits: num.digits } })).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.SMS_ALLOWED_NUMBERS; else process.env.SMS_ALLOWED_NUMBERS = saved;
    }
  });

  async function appointment(phone: { typed: string }) {
    const clinic = await makeClinic({ weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const patient = await makePatient({ phone: phone.typed, smsOptIn: true });
    const user = await prisma.user.create({ data: { name: 'c', email: '', phone: '6125550000' } });
    const start = new Date('2038-04-07T15:00:00Z');
    const booking = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id },
    });
    return { booking };
  }
});
