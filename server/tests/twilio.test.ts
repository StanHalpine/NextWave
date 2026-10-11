import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../src/lib/prisma.js';
import { config } from '../src/config.js';
import { runAppointmentTexts } from '../src/jobs/appointmentTexts.js';
import { StubMessaging } from '../src/integrations/stubs.js';
import { TwilioMessaging, statusCallbackProblem, twilioMissingCredential, twilioSendingConfigured } from '../src/integrations/twilio.js';
import { getIntegrations, integrationStatuses, loadIntegrations } from '../src/integrations/index.js';
import { MessagingError } from '../src/integrations/types.js';
import { renderTemplate } from '../src/integrations/templates.js';
import { toE164 } from '../src/lib/phone.js';
import { twilioSignature } from '../src/routes/smsInbound.js';
import { app, auditRows, blob, makeAccount, signInFully } from './helpers.js';
import { makeClinic, makePatient } from './phase2.js';

/**
 * The Twilio adapter, tested against a REAL local HTTP server standing in for Twilio (so the actual request — path, auth header,
 * form encoding — is what is checked), and the status-callback webhook. No network, no credentials.
 */

const SID = `AC${'a1'.repeat(16)}`;                 // the shape of an account SID, and nothing real
const TOKEN = 'test-twilio-auth-token';
const FROM = '+18665241007';
const CALLBACK = 'https://app.example.test/api/sms/status';

// ---- a fake Twilio ----------------------------------------------------------------------------------
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; form: Record<string, string> }
type Reply = { status: number; body?: unknown; raw?: string; hang?: boolean };
let server: http.Server;
let baseUrl = '';
let seen: Seen[] = [];
let reply: (n: number) => Reply = () => ({ status: 201, body: { sid: 'SM0123456789abcdef0123456789abcdef', status: 'queued', error_code: null } });

beforeAll(async () => {
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, form: Object.fromEntries(new URLSearchParams(data)) });
      const r = reply(seen.length);
      if (r.hang) return;                                  // never answers: a timeout
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.raw ?? JSON.stringify(r.body ?? {}));
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
afterEach(() => { vi.restoreAllMocks(); seen = []; reply = () => ({ status: 201, body: { sid: 'SM0123456789abcdef0123456789abcdef', status: 'queued', error_code: null } }); });

const adapter = (over: Partial<ConstructorParameters<typeof TwilioMessaging>[0]> = {}) =>
  new TwilioMessaging({ accountSid: SID, authToken: TOKEN, from: FROM, statusCallbackUrl: CALLBACK, baseUrl, ...over });

/** Everything the app writes to its logs while `fn` runs. */
async function logged<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
  try { return { result: await fn(), text: lines.join('\n') }; } finally { spies.forEach((s) => s.mockRestore()); }
}

let n = 0;
const freshNumber = () => { const last4 = String(9100 + ++n + (Date.now() % 600)).padStart(4, '0'); return { e164: `+1612555${last4}`, typed: `(612) 555-${last4}`, digits: `1612555${last4}`, last4 }; };
const unxml = (s: string) => s.replace(/&amp;/g, '&');

// ---------------------------------------------------------------------------------------------------
describe('sending: what goes over the wire', () => {
  it('POSTs to the account\'s Messages endpoint with basic auth and exactly To, From, Body and StatusCallback', async () => {
    const num = freshNumber();
    const { providerMessageId } = await adapter().sendSms({ to: num.e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } });
    expect(providerMessageId).toBe('SM0123456789abcdef0123456789abcdef');

    expect(seen).toHaveLength(1);
    const r = seen[0]!;
    expect([r.method, r.url]).toEqual(['POST', `/2010-04-01/Accounts/${SID}/Messages.json`]);
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(r.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
    expect(r.form).toEqual({
      To: num.e164, From: FROM, StatusCallback: CALLBACK,
      Body: 'NextWave Wellness: Reminder for Ingrid: see you tomorrow at 8:00 AM. Reply STOP to opt out.',
    });
    expect(r.form.Body).toBe(renderTemplate('appt_reminder_24h_v3', { first: 'Ingrid', time: '8:00 AM' }));
  });

  it('refuses a template given anything but its own placeholders, before anything is sent', async () => {
    const num = freshNumber();
    await expect(adapter().sendSms({ to: num.e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM', service: 'Spinal X-Rays' } })).rejects.toThrow(/takes exactly/);
    expect(seen).toHaveLength(0);
  });

  it('logs the message id, status and template — never the number, the words, or the token', async () => {
    const num = freshNumber();
    const { text } = await logged(() => adapter().sendSms({ to: num.e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } }));
    expect(text).toContain('twilio_message_accepted');
    expect(text).toContain('SM0123456789abcdef0123456789abcdef');
    expect(text).toContain('appt_reminder_24h_v3');
    for (const secret of [num.last4, num.e164, 'Ingrid', 'see you tomorrow', TOKEN, 'Reminder for']) expect(text, secret).not.toContain(secret);
  });
});

describe('sending: what a failure becomes', () => {
  const NAME_AND_NUMBER = 'The \'To\' number +16125559876 (Ingrid Holloway) is not a valid phone number';
  const cases: Array<[string, Reply, string, number | undefined]> = [
    ['opted out (21610)', { status: 400, body: { code: 21610, message: NAME_AND_NUMBER, status: 400 } }, 'opted_out', 21610],
    ['not a valid number (21211)', { status: 400, body: { code: 21211, message: NAME_AND_NUMBER, status: 400 } }, 'invalid_recipient', 21211],
    ['not a mobile number (21614)', { status: 400, body: { code: 21614, message: NAME_AND_NUMBER } }, 'invalid_recipient', 21614],
    ['permission for the region (21408)', { status: 400, body: { code: 21408, message: NAME_AND_NUMBER } }, 'rejected', 21408],
    ['queue full (21611)', { status: 400, body: { code: 21611, message: NAME_AND_NUMBER } }, 'transient', 21611],
    ['an unreadable 400', { status: 400, raw: `<html>${NAME_AND_NUMBER}</html>` }, 'rejected', undefined],
    ['rate limited (429)', { status: 429, body: { code: 20429, message: NAME_AND_NUMBER } }, 'transient', 20429],
    ['Twilio is down (500)', { status: 500, raw: NAME_AND_NUMBER }, 'transient', undefined],
    ['Twilio is down (503)', { status: 503, body: { message: NAME_AND_NUMBER } }, 'transient', undefined],
    ['credentials refused (401)', { status: 401, body: { code: 20003, message: NAME_AND_NUMBER } }, 'transient', 20003],
    ['accepted, then already failed with 21610', { status: 201, body: { sid: 'SM0123456789abcdef0123456789abcdef', status: 'failed', error_code: 21610 } }, 'opted_out', 21610],
    ['accepted but unreadable (no id)', { status: 201, body: { status: 'queued' } }, 'rejected', undefined],
  ];
  it.each(cases)('%s → %s', async (_name, r, failure, code) => {
    reply = () => r;
    const num = freshNumber();
    const { result, text } = await logged(() => adapter().sendSms({ to: num.e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } }).catch((e) => e));
    expect(result).toBeInstanceOf(MessagingError);
    expect((result as MessagingError).failure).toBe(failure);
    expect((result as MessagingError).providerCode).toBe(code);
    // Twilio's message echoed a number and a name. Neither is on the error, and neither reached a log.
    for (const leak of ['Holloway', 'Ingrid', '6125559876', num.last4]) {
      expect(String((result as Error).message) + JSON.stringify(result) + text, leak).not.toContain(leak);
    }
  });

  it('a refused credential is a loud error in the log (and the text is retried), not a quiet failure', async () => {
    reply = () => ({ status: 401, body: { code: 20003 } });
    const { text } = await logged(() => adapter().sendSms({ to: freshNumber().e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } }).catch(() => null));
    expect(text).toContain('twilio_credentials_rejected');
    expect(text).toContain('"level":"error"');
  });

  it('a network failure and a timeout are transient', async () => {
    const dead = new TwilioMessaging({ accountSid: SID, authToken: TOKEN, from: FROM, statusCallbackUrl: CALLBACK, baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    const e1 = await dead.sendSms({ to: freshNumber().e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } }).catch((e) => e);
    expect(e1).toMatchObject({ name: 'MessagingError', failure: 'transient' });
    reply = () => ({ status: 200, hang: true });
    const e2 = await adapter({ timeoutMs: 150 }).sendSms({ to: freshNumber().e164, templateId: 'appt_reminder_24h_v3', variables: { first: 'Ingrid', time: '8:00 AM' } }).catch((e) => e);
    expect(e2).toMatchObject({ name: 'MessagingError', failure: 'transient' });
  });
});

describe('when it is used', () => {
  const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
  it('only with BOTH credentials set and outside the test run', () => {
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: 'production' }))).toBe(true);
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: 'development' }))).toBe(true);
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN }))).toBe(true);
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: 'test' }))).toBe(false);   // never in the test run
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: SID, NODE_ENV: 'production' }))).toBe(false);
    expect(twilioSendingConfigured(env({ TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: 'production' }))).toBe(false);
    expect(twilioSendingConfigured(env({ TWILIO_ACCOUNT_SID: '  ', TWILIO_AUTH_TOKEN: TOKEN, NODE_ENV: 'production' }))).toBe(false);
    expect(twilioSendingConfigured(env({}))).toBe(false);
  });

  it('names the missing credential when only one is set — never a value', () => {
    expect(twilioMissingCredential(env({ TWILIO_ACCOUNT_SID: SID }))).toBe('TWILIO_AUTH_TOKEN');
    expect(twilioMissingCredential(env({ TWILIO_AUTH_TOKEN: TOKEN }))).toBe('TWILIO_ACCOUNT_SID');
    expect(twilioMissingCredential(env({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN }))).toBeNull();
    expect(twilioMissingCredential(env({}))).toBeNull();
  });

  it('refuses a malformed account SID or an empty token at start-up, and a callback address Twilio would reject', () => {
    expect(() => adapter({ accountSid: TOKEN })).toThrow(/TWILIO_ACCOUNT_SID/);          // a pasted auth token
    expect(() => adapter({ accountSid: ` ${SID}` })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => adapter({ authToken: '' })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(statusCallbackProblem('https://nextwave-scheduling.onrender.com/api/sms/status', true)).toBeNull();
    expect(statusCallbackProblem('http://localhost:4000/api/sms/status', false)).toBeNull();
    expect(statusCallbackProblem('http://app.example.test/api/sms/status', true)).toMatch(/https/);
    expect(statusCallbackProblem('https://next_wave.example.test/api/sms/status', true)).toMatch(/underscore/);
    expect(statusCallbackProblem('not a url', false)).toMatch(/valid/);
  });

  it('stays on the stub in the test run even with both credentials set, and switches to Twilio outside it', async () => {
    const saved = { sid: process.env.TWILIO_ACCOUNT_SID, nodeEnv: process.env.NODE_ENV };
    process.env.TWILIO_ACCOUNT_SID = SID;                                                  // the token is already set for the file
    try {
      await loadIntegrations();
      expect(getIntegrations().messaging).toBeInstanceOf(StubMessaging);
      expect(integrationStatuses().find((s) => s.kind === 'MESSAGING')).toMatchObject({ provider: 'stub', isStub: true });

      process.env.NODE_ENV = 'development';
      await loadIntegrations();
      expect(getIntegrations().messaging).toBeInstanceOf(TwilioMessaging);
      expect(integrationStatuses().find((s) => s.kind === 'MESSAGING')).toMatchObject({ provider: 'twilio', isStub: false });
    } finally {
      if (saved.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = saved.sid;
      process.env.NODE_ENV = saved.nodeEnv;
      await loadIntegrations();
    }
    expect(getIntegrations().messaging).toBeInstanceOf(StubMessaging);
  });

  it('warns, naming only the missing variable, when one credential is set without the other', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';                                                  // the token is set; the SID is not
    try {
      const { text } = await logged(() => loadIntegrations());
      expect(text).toContain('twilio_partially_configured');
      expect(text).toContain('TWILIO_ACCOUNT_SID');
      expect(text).not.toContain(TOKEN);
      expect(getIntegrations().messaging).toBeInstanceOf(StubMessaging);                   // nothing is sent
    } finally { process.env.NODE_ENV = saved; await loadIntegrations(); }
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the text job through the adapter', () => {
  const sevenDays = [0, 1, 2, 3, 4, 5, 6];
  async function appointment(phone: { typed: string }) {
    const clinic = await makeClinic({ weekdays: sevenDays });
    const patient = await makePatient({ phone: phone.typed, smsOptIn: true, firstName: 'Ingrid' });
    const user = await prisma.user.create({ data: { name: 'c', email: '', phone: '6125550000' } });
    const start = new Date('2036-03-05T16:00:00Z');                                        // Wed 10:00 CST
    const booking = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient.id },
    });
    return { patient, booking };
  }
  const NOW = new Date('2036-03-03T17:00:00Z');                                            // Mon 11:00 CST, inside sending hours

  it('sends the confirmation, and keeps the message id — and Twilio is given the patient\'s number and the template\'s words', async () => {
    reply = () => ({ status: 201, body: { sid: 'SMdeadbeefdeadbeefdeadbeefdeadbeef', status: 'queued', error_code: null } });
    const num = freshNumber();
    const { booking } = await appointment(num);
    const { text } = await logged(() => runAppointmentTexts({ messaging: adapter(), now: NOW }));
    const mine = seen.filter((s) => s.form.To === num.e164);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.form.Body).toMatch(/^NextWave Wellness: Hi Ingrid, you're confirmed for /);
    const row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: booking.id, kind: 'CONFIRMATION' } });
    expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'SMdeadbeefdeadbeefdeadbeefdeadbeef', failureCode: null, providerErrorCode: null });
    for (const leak of [num.e164, num.last4, 'Ingrid', "you're confirmed"]) expect(text, leak).not.toContain(leak);
  });

  it('on 21610 turns the patient\'s consent off, puts the number on the do-not-text list, audits it, and never texts again', async () => {
    reply = (k) => (k === 1 ? { status: 400, body: { code: 21610, message: 'The number +1 is blocked', status: 400 } } : { status: 201, body: { sid: 'SM0123456789abcdef0123456789abcdef', status: 'queued' } });
    const num = freshNumber();
    const { patient, booking } = await appointment(num);
    const { text } = await logged(async () => {
      await runAppointmentTexts({ messaging: adapter(), now: NOW });
      await runAppointmentTexts({ messaging: adapter(), now: new Date(NOW.getTime() + 3_600_000) });
    });
    expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({ status: 'FAILED', failureCode: 'opted_out', providerErrorCode: 21610 });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).smsOptIn).toBe(false);
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: num.digits } })).toMatchObject({ source: 'PROVIDER' });
    expect(seen.filter((s) => s.form.To === num.e164)).toHaveLength(1);                    // asked once; not again
    const rows = await auditRows({ resourceType: 'patient', resourceId: patient.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('provider_opt_out');
    expect(blob(await auditRows({ resourceType: 'sms_consent' }, 1))).not.toContain(num.last4);
    for (const leak of [num.e164, num.last4, 'Ingrid']) expect(text, leak).not.toContain(leak);
  });

  it('retries a Twilio outage with backoff, and records no code for it', async () => {
    reply = () => ({ status: 503, body: { message: 'down' } });
    const num = freshNumber();
    const { booking } = await appointment(num);
    await runAppointmentTexts({ messaging: adapter(), now: NOW });
    const row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(row).toMatchObject({ status: 'QUEUED', failureCode: 'transient', providerErrorCode: null });
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

// ---------------------------------------------------------------------------------------------------
describe('the status-callback webhook', () => {
  const URL_ = 'http://localhost:4000/api/sms/status';                                       // APP_BASE_URL in the test environment + the route
  const post = (params: Record<string, string>, opts: { sign?: boolean; token?: string; url?: string } = {}) => {
    const r = request(app).post('/api/sms/status').type('form');
    if (opts.sign !== false) r.set('X-Twilio-Signature', twilioSignature(opts.token ?? TOKEN, opts.url ?? URL_, params));
    return r.send(params);
  };
  let sidN = 0;
  /** A sent text we can send callbacks about. */
  async function sentMessage(over: { phone?: ReturnType<typeof freshNumber>; consentOnBooking?: boolean } = {}) {
    const num = over.phone ?? freshNumber();
    const clinic = await makeClinic({ weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const patient = over.consentOnBooking ? null : await makePatient({ phone: num.typed, smsOptIn: true });
    const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: over.consentOnBooking ? num.typed : '6125550000' } });
    const start = new Date('2036-04-07T16:00:00Z');
    const booking = await prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: patient?.id ?? null, ...(over.consentOnBooking ? { smsConsentAt: new Date() } : {}) },
    });
    const sid = `SM${(++sidN).toString(16).padStart(8, '0')}${Date.now().toString(16)}`;
    const row = await prisma.messageLog.create({ data: { bookingId: booking.id, patientId: patient?.id ?? null, kind: 'CONFIRMATION', forStart: start, templateId: 'appt_confirmation_v2', status: 'SENT', providerMessageId: sid, sentAt: new Date() } });
    return { num, patient, booking, sid, row };
  }
  const log = (id: string) => prisma.messageLog.findUniqueOrThrow({ where: { id } });
  const deliveryAudits = async (id: string) => (await prisma.auditLog.findMany({ where: { resourceType: 'message', resourceId: id, action: 'UPDATE' } })).filter((r) => (r.meta as { outcome?: string } | null)?.outcome === 'delivery_status');

  it('is signed like the inbound webhook: refuses no signature, a wrong token, a tampered body, and a signature for another address', async () => {
    const m = await sentMessage();
    const params = { MessageSid: m.sid, MessageStatus: 'delivered' };
    expect((await post(params, { sign: false })).status).toBe(403);
    expect((await post(params, { token: 'not-the-token' })).status).toBe(403);
    expect((await post(params, { url: 'http://localhost:4000/api/sms/inbound' })).status).toBe(403);   // the inbound webhook's signature does not work here
    const sig = twilioSignature(TOKEN, URL_, params);
    expect((await request(app).post('/api/sms/status').type('form').set('X-Twilio-Signature', sig).send({ ...params, MessageStatus: 'failed' })).status).toBe(403);
    expect((await log(m.row.id)).deliveryStatus).toBeNull();                              // none of them did anything
    const ok = await post(params);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('');
  });

  it('in production with no token, refuses everything rather than trust an unsigned request', async () => {
    const m = await sentMessage();
    delete process.env.TWILIO_AUTH_TOKEN;
    (config as { isProduction: boolean }).isProduction = true;
    try {
      expect((await post({ MessageSid: m.sid, MessageStatus: 'delivered' }, { sign: false })).status).toBe(503);
      expect((await log(m.row.id)).deliveryStatus).toBeNull();
    } finally { (config as { isProduction: boolean }).isProduction = false; process.env.TWILIO_AUTH_TOKEN = TOKEN; }
  });

  it('records the delivery status beside — not instead of — the send status, and audits the change without any number', async () => {
    const m = await sentMessage();
    await post({ MessageSid: m.sid, MessageStatus: 'sent' });
    await post({ MessageSid: m.sid, MessageStatus: 'delivered' });
    const row = await log(m.row.id);
    expect(row).toMatchObject({ status: 'SENT', deliveryStatus: 'delivered', providerErrorCode: null });
    expect(row.deliveryUpdatedAt).not.toBeNull();
    const audits = await deliveryAudits(m.row.id);
    expect(audits.map((a) => (a.meta as { to: string }).to)).toEqual(['sent', 'delivered']);
    expect(blob(audits)).not.toContain(m.num.last4);
  });

  it('shows the front desk what the provider reported — the status, never a number or the words', async () => {
    const m = await sentMessage();
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    const detail = async () => (await fd.agent.get(`/api/schedule/appointments/${m.booking.id}`)).body.messages as Array<Record<string, unknown>>;
    expect((await detail())[0]).toMatchObject({ status: 'SENT', deliveryStatus: null });
    await post({ MessageSid: m.sid, MessageStatus: 'delivered' });
    const [msg] = await detail();
    expect(msg).toMatchObject({ kind: 'CONFIRMATION', status: 'SENT', deliveryStatus: 'delivered' });
    expect(Object.keys(msg!).sort()).toEqual(['deliveryStatus', 'failureCode', 'forStart', 'kind', 'sentAt', 'status']);
  });

  it('only moves forward: a late or repeated callback changes nothing and writes no audit row', async () => {
    const m = await sentMessage();
    await post({ MessageSid: m.sid, MessageStatus: 'delivered' });
    await post({ MessageSid: m.sid, MessageStatus: 'sent' });                              // arrives late
    await post({ MessageSid: m.sid, MessageStatus: 'queued' });
    await post({ MessageSid: m.sid, MessageStatus: 'delivered' });                         // a repeat
    expect((await log(m.row.id)).deliveryStatus).toBe('delivered');
    expect(await deliveryAudits(m.row.id)).toHaveLength(1);

    const r = await sentMessage();
    await Promise.all(Array.from({ length: 6 }, () => post({ MessageSid: r.sid, MessageStatus: 'delivered' })));
    expect(await deliveryAudits(r.row.id)).toHaveLength(1);                                // six at once: one change
  });

  it('records a failure with its numeric code and nothing else, and leaves consent alone for an ordinary one', async () => {
    const m = await sentMessage();
    await post({ MessageSid: m.sid, MessageStatus: 'undelivered', ErrorCode: '30003', To: m.num.e164 });
    expect(await log(m.row.id)).toMatchObject({ deliveryStatus: 'undelivered', providerErrorCode: 30003 });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: m.patient!.id } })).smsOptIn).toBe(true);
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: m.num.digits } })).toBe(0);
  });

  it('ignores a message it does not know, a status it does not track, and answers 400 only to a request with no usable id or status', async () => {
    const before = await prisma.auditLog.count({ where: { resourceType: 'message' } });
    expect((await post({ MessageSid: 'SM00000000unknown000000000000000000', MessageStatus: 'delivered' })).status).toBe(200);
    const m = await sentMessage();
    expect((await post({ MessageSid: m.sid, MessageStatus: 'read' })).status).toBe(200);
    expect((await log(m.row.id)).deliveryStatus).toBeNull();
    expect((await post({ MessageStatus: 'delivered' })).status).toBe(400);
    expect((await post({ MessageSid: 'not a sid!', MessageStatus: 'delivered' })).status).toBe(400);
    expect((await post({ MessageSid: m.sid, MessageStatus: 'Delivered; DROP' })).status).toBe(400);
    expect(await prisma.auditLog.count({ where: { resourceType: 'message' } })).toBe(before);
  });

  it('on 21610 puts the number on the do-not-text list, turns consent off, and audits it — without the number or the words in any log', async () => {
    const m = await sentMessage();
    const { text } = await logged(() => post({ MessageSid: m.sid, MessageStatus: 'failed', ErrorCode: '21610', To: m.num.e164, From: FROM, AccountSid: SID }));
    expect(await log(m.row.id)).toMatchObject({ deliveryStatus: 'failed', providerErrorCode: 21610 });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: m.patient!.id } })).smsOptIn).toBe(false);
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: m.num.digits } })).toMatchObject({ source: 'PROVIDER' });
    expect(blob(await auditRows({ resourceType: 'patient', resourceId: m.patient!.id, action: 'UPDATE' }))).toContain('provider_opt_out');
    expect(blob(await auditRows({ resourceType: 'sms_consent' }, 1))).not.toContain(m.num.last4);
    expect(text).toContain(m.sid);
    for (const leak of [m.num.e164, m.num.last4, SID]) expect(text, leak).not.toContain(leak);

    const again = await post({ MessageSid: m.sid, MessageStatus: 'failed', ErrorCode: '21610', To: m.num.e164 });   // Twilio repeats itself
    expect(again.status).toBe(200);
    expect(await deliveryAudits(m.row.id)).toHaveLength(1);
  });

  it('finds the number itself when the callback does not carry one — from the patient, or from the booking', async () => {
    const a = await sentMessage();
    await post({ MessageSid: a.sid, MessageStatus: 'undelivered', ErrorCode: '21610' });
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: a.num.digits } })).toMatchObject({ source: 'PROVIDER' });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: a.patient!.id } })).smsOptIn).toBe(false);

    const b = await sentMessage({ consentOnBooking: true });                                // consent was a tick on the booking, no patient
    await post({ MessageSid: b.sid, MessageStatus: 'failed', ErrorCode: '21610' });
    expect(await prisma.smsSuppression.findUniqueOrThrow({ where: { phoneDigits: b.num.digits } })).toMatchObject({ source: 'PROVIDER' });
  });

  it('is the number Twilio says opted out that is suppressed, whatever the booking holds', async () => {
    const m = await sentMessage();
    const other = freshNumber();
    await post({ MessageSid: m.sid, MessageStatus: 'failed', ErrorCode: '21610', To: other.e164 });
    expect(await prisma.smsSuppression.count({ where: { phoneDigits: other.digits } })).toBe(1);
    expect(toE164(m.num.typed)).toBe(m.num.e164);
  });
});
