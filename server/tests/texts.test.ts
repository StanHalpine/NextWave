import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { runAppointmentTexts, MAX_ATTEMPTS, withinSendingHours } from '../src/jobs/appointmentTexts.js';
import { runAllJobsOnce } from '../src/jobs/scheduler.js';
import { loadIntegrations } from '../src/integrations/index.js';
import { MessagingError, type Messaging } from '../src/integrations/types.js';
import { TEMPLATES, REPLIES, ALLOWED_VARIABLES, renderTemplate, sanitizeFirstName, TemplateError, placeholdersOf } from '../src/integrations/templates.js';
import { renderTemplatesDoc } from '../src/integrations/templateDoc.js';
import { smsInfo } from '../src/integrations/smsEncoding.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StubMessaging } from '../src/integrations/stubs.js';
import { toE164 } from '../src/lib/phone.js';
import { makeAccount, signInFully, auditRows, blob } from './helpers.js';
import { TUESDAY_1007, makeClinic, makePatient, post, slotAt } from './phase2.js';

/** A recording stand-in for Twilio. `behave` may throw to simulate a failure. */
function fakeMessaging(behave?: (n: number) => void) {
  const calls: Array<{ to: string; templateId: string; variables: Record<string, string> }> = [];
  const m: Messaging = {
    async sendSms(input) {
      calls.push(input);
      behave?.(calls.length);
      return { providerMessageId: `fake-${calls.length}` };
    },
  };
  return { m, calls };
}
const to = (p: { phone: string }) => toE164(p.phone)!;
const callsFor = (calls: ReturnType<typeof fakeMessaging>['calls'], p: { phone: string }) => calls.filter((c) => c.to === to(p));

const WED = '2026-10-14';
const APPT = slotAt('10:00', WED);                       // Wed 10:00 CDT
const FAR = new Date('2026-10-10T15:00:00Z');            // Sat 10:00 — four days before
const T1 = TUESDAY_1007;                                 // Tue 10:07 — 23h53m before: inside the reminder window

let sharedClinic: Awaited<ReturnType<typeof makeClinic>>;
beforeAll(async () => {
  // Other test files leave consenting patients with future appointments in this schema;
  // switch them off so this file's counts are about this file's patients only.
  await prisma.patient.updateMany({ where: { smsOptIn: true }, data: { smsOptIn: false } });
  sharedClinic = await makeClinic({ rooms: 40, staff: 40 });
});
afterAll(() => setClockForTests(null));

let slotN = 0;
/** A confirmed future appointment for a patient. Distinct room/provider so fixtures never collide. */
async function appt(patientId: string | null, over: { start?: Date; status?: 'CONFIRMED' | 'PENDING_REVIEW' | 'CANCELLED'; source?: 'ONLINE' | 'PHONE' | 'WALK_IN' | 'FRONT_DESK' } = {}) {
  const i = slotN++ % 40;
  const start = over.start ?? APPT;
  const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: '6125550000' } });
  return prisma.booking.create({
    data: {
      userId: user.id, serviceId: sharedClinic.service.id, resourceId: sharedClinic.rooms[i]!.id, staffId: sharedClinic.staff[i]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: over.status ?? 'CONFIRMED',
      source: over.source ?? 'FRONT_DESK', patientId,
    },
  });
}
const consenting = (over: object = {}) => makePatient({ smsOptIn: true, firstName: 'Ingrid', ...over });

describe('message templates', () => {
  const V = { first: 'Ingrid', day: 'Wednesday, Oct 14', time: '10:00 AM' };

  it('are EXACTLY the wording the owner approved', () => {
    expect(renderTemplate('appt_confirmation_v2', V)).toBe(
      "NextWave Wellness: Hi Ingrid, you're confirmed for Wednesday, Oct 14 at 10:00 AM. Reply C to confirm or call us to change. Reply STOP to opt out.");
    expect(renderTemplate('appt_reminder_24h_v2', { first: 'Ingrid', time: '10:00 AM' })).toBe(
      'NextWave Wellness: Reminder — Ingrid, see you tomorrow at 10:00 AM. Reply STOP to opt out.');
    // The raw strings, with their placeholders, as handed to the A2P form.
    expect(TEMPLATES.appt_confirmation_v2.text).toBe("NextWave Wellness: Hi {first}, you're confirmed for {day} at {time}. Reply C to confirm or call us to change. Reply STOP to opt out.");
    expect(TEMPLATES.appt_reminder_24h_v2.text).toBe('NextWave Wellness: Reminder — {first}, see you tomorrow at {time}. Reply STOP to opt out.');
  });

  it('carry first name, day and time — and nothing else about the care', () => {
    expect([...ALLOWED_VARIABLES]).toEqual(['first', 'day', 'time']);
    expect(placeholdersOf('appt_confirmation_v2')).toEqual(['day', 'first', 'time']);
    expect(placeholdersOf('appt_reminder_24h_v2')).toEqual(['first', 'time']);
    for (const id of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      for (const v of placeholdersOf(id)) expect((ALLOWED_VARIABLES as readonly string[]).includes(v), `${id} uses {${v}}`).toBe(true);
      // Strip the fields and the fixed wording's own words: no service, provider or room can remain.
      const body = renderTemplate(id, Object.fromEntries(placeholdersOf(id).map((k) => [k, V[k as keyof typeof V]])));
      expect(body.replace('Ingrid', '')).not.toMatch(/chiropract|adjust|infusion|hyperbaric|therapy|Dr\.|nurse|\broom\b|x-ray|hormone|peptide|biomarker/i);
    }
  });

  it('REJECT a variable the template does not use, a missing one, an unknown template, and values that could smuggle content', () => {
    expect(() => renderTemplate('appt_confirmation_v2', { ...V, service: 'Spinal Exam' })).toThrow(TemplateError);
    expect(() => renderTemplate('appt_confirmation_v2', { ...V, provider: 'Dr. Lee' })).toThrow(TemplateError);
    expect(() => renderTemplate('appt_confirmation_v2', { first: 'Ingrid', day: 'x' })).toThrow(TemplateError);
    expect(() => renderTemplate('appt_reminder_24h_v2', V)).toThrow(TemplateError);          // the reminder takes no {day}
    expect(() => renderTemplate('appt_cancel_v1', V)).toThrow(TemplateError);
    expect(() => renderTemplate('appt_confirmation_v2', { ...V, first: 'Ingrid\nvisit https://x.test' })).toThrow(TemplateError);
    expect(() => renderTemplate('appt_confirmation_v2', { ...V, first: '' })).toThrow(TemplateError);
  });

  it('sanitise a first name so it cannot carry a link or a number', () => {
    expect(sanitizeFirstName('Ingrid')).toBe('Ingrid');
    expect(sanitizeFirstName("Mary-Anne O'Neil")).toBe("Mary-Anne O'Neil");
    expect(sanitizeFirstName('José')).toBe('José');
    expect(sanitizeFirstName('Bob http://evil.test 555-1212')).not.toMatch(/[:/\d]/);
    expect(sanitizeFirstName('12345')).toBe('there');
    expect(sanitizeFirstName('   ')).toBe('there');
    expect(sanitizeFirstName('x'.repeat(100)).length).toBeLessThanOrEqual(30);
  });

  it('are enforced by the stub provider too, so a bad call fails in development rather than in production', async () => {
    const stub = new StubMessaging();
    await expect(stub.sendSms({ to: '+16125550100', templateId: 'appt_confirmation_v2', variables: { ...V, service: 'IV' } })).rejects.toThrow(TemplateError);
  });

  it('replies are held to the same rule; the only extra they may carry is the clinic phone', () => {
    expect(renderTemplate('reply_help_v1', { phone: '(612) 555-0100' })).toBe('NextWave Wellness: For help, call (612) 555-0100. Msg & data rates may apply. Reply STOP to opt out.');
    expect(renderTemplate('reply_confirmed_v1', V)).toContain('Wednesday, Oct 14 at 10:00 AM');
    for (const id of Object.keys(REPLIES)) for (const v of placeholdersOf(id)) expect(['first', 'day', 'time', 'phone']).toContain(v);
  });

  it('report their size honestly: the reminder\'s em dash makes it Unicode', () => {
    const conf = smsInfo(renderTemplate('appt_confirmation_v2', V));
    expect(conf).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    const rem = smsInfo(renderTemplate('appt_reminder_24h_v2', { first: 'Ingrid', time: '10:00 AM' }));
    expect(rem.encoding).toBe('UCS-2');
    expect(rem.nonGsm).toEqual(['—']);
    expect(smsInfo('a'.repeat(160))).toMatchObject({ encoding: 'GSM-7', segments: 1 });
    expect(smsInfo('a'.repeat(161))).toMatchObject({ segments: 2, length: 161 });
    expect(smsInfo('[' + 'a'.repeat(159))).toMatchObject({ segments: 2 });               // "[" costs two
    expect(smsInfo('é'.repeat(3) + '—'.repeat(67)).segments).toBe(1);                       // 70 UCS-2 units fit in one segment
    expect(smsInfo('é'.repeat(3) + '—'.repeat(68)).segments).toBe(2);                       // 71 do not
  });

  it('are in the committed campaign document, which is not stale (run `npm run sms:templates`)', () => {
    const committed = readFileSync(path.resolve(process.cwd(), '..', 'docs', 'SMS_TEMPLATES.md'), 'utf8');
    expect(committed).toBe(renderTemplatesDoc());
    for (const t of [...Object.values(TEMPLATES), ...Object.values(REPLIES)]) expect(committed).toContain(t.text);
  });
});

describe('sending hours', () => {
  it('are 8:00 to 21:00 clinic time', () => {
    const at = (hhmm: string) => slotAt(hhmm, WED);
    expect(withinSendingHours(at('07:59'))).toBe(false);
    expect(withinSendingHours(at('08:00'))).toBe(true);
    expect(withinSendingHours(at('20:59'))).toBe(true);
    expect(withinSendingHours(at('21:00'))).toBe(false);
    expect(withinSendingHours(at('00:30'))).toBe(false);
  });
});

describe('confirmation texts', () => {
  it('sends exactly one, with only first name, date and time — and never again on a re-run', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging();

    const first = await runAppointmentTexts({ messaging: m, now: FAR });
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const mine = callsFor(calls, p);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual({ to: to(p), templateId: 'appt_confirmation_v2', variables: { first: 'Ingrid', day: 'Wednesday, Oct 14', time: '10:00 AM' } });
    expect(Object.keys(mine[0]!.variables).sort()).toEqual(['day', 'first', 'time']);

    const log = await prisma.messageLog.findMany({ where: { bookingId: b.id } });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'CONFIRMATION', status: 'SENT', templateId: 'appt_confirmation_v2', attempts: 1, patientId: p.id });
    expect(log[0]!.providerMessageId).toMatch(/^fake-/);
    expect(log[0]!.forStart.toISOString()).toBe(APPT.toISOString());

    await runAppointmentTexts({ messaging: m, now: FAR });
    await runAppointmentTexts({ messaging: m, now: new Date(FAR.getTime() + 3_600_000) });
    expect(callsFor(calls, p)).toHaveLength(1);
    expect(await prisma.messageLog.count({ where: { bookingId: b.id } })).toBe(1);

    expect(blob(await auditRows({ resourceType: 'message', resourceId: log[0]!.id }, 2))).not.toMatch(/Ingrid|555/);
  });

  it('uses the preferred name when there is one', async () => {
    const p = await consenting({ preferredName: 'Inge' });
    await appt(p.id);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(callsFor(calls, p)[0]!.variables.first).toBe('Inge');
  });

  it('two runners at once still send once', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging();
    await Promise.all(Array.from({ length: 5 }, () => runAppointmentTexts({ messaging: m, now: FAR })));
    expect(callsFor(calls, p)).toHaveLength(1);
    expect(await prisma.messageLog.count({ where: { bookingId: b.id } })).toBe(1);
  });

  it('texts nobody who has not consented, cannot be reached, or is not really coming', async () => {
    const noConsent = await makePatient({ smsOptIn: false });
    const badNumber = await consenting({ phone: 'call-the-office' });
    const deleted = await consenting();
    await prisma.patient.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const walkIn = await consenting();
    const pending = await consenting();
    const cancelled = await consenting();
    const here = await consenting();
    const past = await consenting();
    const unlinked = await consenting();

    await appt(noConsent.id);
    await appt(badNumber.id);
    await appt(deleted.id);
    await appt(walkIn.id, { source: 'WALK_IN' });
    await appt(pending.id, { status: 'PENDING_REVIEW' });
    await appt(cancelled.id, { status: 'CANCELLED' });
    const hereBooking = await appt(here.id);
    await prisma.encounter.create({ data: { bookingId: hereBooking.id, status: 'CHECKED_IN', checkedInAt: FAR } });
    await appt(past.id, { start: new Date(FAR.getTime() - 3_600_000) });
    await appt(null);                         // an online booking nobody has linked to a patient
    void unlinked;

    const { m, calls } = fakeMessaging();
    const res = await runAppointmentTexts({ messaging: m, now: FAR });
    for (const p of [noConsent, deleted, walkIn, pending, cancelled, here, past, unlinked]) expect(callsFor(calls, p), p.id).toHaveLength(0);
    expect(callsFor(calls, badNumber)).toHaveLength(0);
    expect(res.notEligible).toBeGreaterThanOrEqual(3);
  });

  it('texts a patient once their consent is recorded (the appointment was booked before they agreed)', async () => {
    const p = await makePatient({ smsOptIn: false });
    await appt(p.id);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(callsFor(calls, p)).toHaveLength(0);

    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    expect((await post(fd, `/api/fd/patients/${p.id}/sms-consent`, { optIn: true, source: 'verbal' })).status).toBe(200);
    await runAppointmentTexts({ messaging: m, now: FAR });
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(callsFor(calls, p)).toHaveLength(1);
  });

  it('holds everything back outside 8:00–21:00 and sends it in the morning', async () => {
    const p = await consenting();
    await appt(p.id);
    const { m, calls } = fakeMessaging();
    const night = await runAppointmentTexts({ messaging: m, now: slotAt('21:00', '2026-10-10') });
    const early = await runAppointmentTexts({ messaging: m, now: slotAt('07:59', '2026-10-11') });
    expect(night.sent + early.sent).toBe(0);
    expect(callsFor(calls, p)).toHaveLength(0);
    await runAppointmentTexts({ messaging: m, now: slotAt('08:00', '2026-10-11') });
    expect(callsFor(calls, p)).toHaveLength(1);
  });
});

describe('24-hour reminders', () => {
  it('goes out once the appointment is inside 24 hours — and not before', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });                                       // confirmation only
    await runAppointmentTexts({ messaging: m, now: new Date(APPT.getTime() - 25 * 3_600_000) });  // 25h out: still too early
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_confirmation_v2']);

    await runAppointmentTexts({ messaging: m, now: T1 });
    await runAppointmentTexts({ messaging: m, now: T1 });
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_confirmation_v2', 'appt_reminder_24h_v2']);
    expect(callsFor(calls, p)[1]!.variables).toEqual({ first: 'Ingrid', time: '10:00 AM' });   // the reminder says "tomorrow": no day
    const kinds = (await prisma.messageLog.findMany({ where: { bookingId: b.id } })).map((r) => `${r.kind}:${r.status}`).sort();
    expect(kinds).toEqual(['CONFIRMATION:SENT', 'REMINDER_24H:SENT']);
  });

  it('is skipped when the patient was only told less than a day ago — one text, not two', async () => {
    // Booked (and texted) at noon Tuesday for 10:00 Wednesday: the 24-hour mark was 10:00 Tuesday, so
    // they were told AFTER it. By mid-afternoon the reminder would just repeat the confirmation.
    const p = await consenting();
    const b = await appt(p.id);
    const toldAt = slotAt('12:00', '2026-10-13');
    await prisma.messageLog.create({
      data: { bookingId: b.id, patientId: p.id, kind: 'CONFIRMATION', forStart: APPT, templateId: 'appt_confirmation_v2', status: 'SENT', queuedAt: toldAt, sentAt: toldAt },
    });
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: slotAt('15:00', '2026-10-13') });
    expect(callsFor(calls, p)).toHaveLength(0);
    expect((await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id, kind: 'REMINDER_24H' } })).failureCode).toBe('booked_inside_window');
  });

  it('is still sent when the patient was told before the 24-hour mark', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const toldAt = slotAt('09:59', '2026-10-13');   // one minute before the window opened
    await prisma.messageLog.create({
      data: { bookingId: b.id, patientId: p.id, kind: 'CONFIRMATION', forStart: APPT, templateId: 'appt_confirmation_v2', status: 'SENT', queuedAt: toldAt, sentAt: toldAt },
    });
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: slotAt('15:00', '2026-10-13') });
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_reminder_24h_v2']);
  });

  it('is NEVER sent for an appointment that is today — "see you tomorrow" would be false', async () => {
    // Wed 08:00, appointment Wed 10:00: inside 24 hours, but not tomorrow (the job was down overnight,
    // or consent arrived late). The confirmation still says the day and time; the reminder is skipped.
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: slotAt('08:00', WED) });
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_confirmation_v2']);
    const reminder = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id, kind: 'REMINDER_24H' } });
    expect(reminder).toMatchObject({ status: 'SKIPPED', failureCode: 'same_day' });
    await runAppointmentTexts({ messaging: m, now: slotAt('09:00', WED) });
    expect(callsFor(calls, p)).toHaveLength(1);
  });

  it('is not sent for an appointment that was cancelled in the meantime', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
    await runAppointmentTexts({ messaging: m, now: T1 });
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_confirmation_v2']);
  });
});

describe('a moved appointment', () => {
  it('is confirmed and reminded again for its NEW time, and the old time\'s rows do not suppress that', async () => {
    setClockForTests(T1);
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    const clinic = await makeClinic();
    const p = await consenting();
    const made = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: APPT.toISOString(), patientId: p.id });
    expect(made.status).toBe(201);
    const id = made.body.appointment.id;
    const { m, calls } = fakeMessaging();

    await runAppointmentTexts({ messaging: m, now: FAR });      // confirmation for 10:00
    await runAppointmentTexts({ messaging: m, now: T1 });       // reminder for 10:00
    expect(callsFor(calls, p)).toHaveLength(2);

    const moved = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('11:00', WED).toISOString() });
    expect(moved.status).toBe(200);

    await runAppointmentTexts({ messaging: m, now: T1 });       // confirmation for 11:00; reminder not yet due (> 24h away)
    expect(callsFor(calls, p).map((c) => c.templateId)).toEqual(['appt_confirmation_v2', 'appt_reminder_24h_v2', 'appt_confirmation_v2']);
    expect(callsFor(calls, p)[2]!.variables.time).toBe('11:00 AM');

    await runAppointmentTexts({ messaging: m, now: slotAt('11:30', '2026-10-13') });   // now inside 24h of 11:00
    const sent = callsFor(calls, p);
    expect(sent).toHaveLength(4);
    expect(sent[3]).toMatchObject({ templateId: 'appt_reminder_24h_v2', variables: { time: '11:00 AM' } });
    expect(await prisma.messageLog.count({ where: { bookingId: id } })).toBe(4);   // 2 times × 2 kinds, none overwritten
    setClockForTests(null);
  });
});

describe('failures and retries', () => {
  it('retries a transient failure after a delay, then succeeds', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging((n) => { if (n === 1) throw new MessagingError('transient'); });

    const r1 = await runAppointmentTexts({ messaging: m, now: FAR });
    expect(r1.retryScheduled).toBeGreaterThanOrEqual(1);
    let row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, failureCode: 'transient' });
    expect(row.nextAttemptAt!.getTime() - FAR.getTime()).toBe(5 * 60_000);

    await runAppointmentTexts({ messaging: m, now: new Date(FAR.getTime() + 4 * 60_000) });   // too soon
    expect(callsFor(calls, p)).toHaveLength(1);
    await runAppointmentTexts({ messaging: m, now: new Date(FAR.getTime() + 5 * 60_000) });
    expect(callsFor(calls, p)).toHaveLength(2);
    row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, failureCode: null });
    await runAppointmentTexts({ messaging: m, now: new Date(FAR.getTime() + 60 * 60_000) });
    expect(callsFor(calls, p)).toHaveLength(2);
  });

  it('gives up after the maximum number of attempts, and records a code rather than the provider\'s words', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging(() => { throw new MessagingError('transient'); });
    let t = FAR.getTime();
    for (const waitMin of [0, 5, 15, 60, 240]) {
      t += waitMin * 60_000;
      await runAppointmentTexts({ messaging: m, now: new Date(t) });
    }
    expect(callsFor(calls, p)).toHaveLength(MAX_ATTEMPTS);
    const row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'transient_exhausted', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
  });

  it('does not retry a number that cannot receive texts or a rejected message', async () => {
    for (const failure of ['invalid_recipient', 'rejected'] as const) {
      const p = await consenting();
      const b = await appt(p.id);
      const { m, calls } = fakeMessaging(() => { throw new MessagingError(failure); });
      await runAppointmentTexts({ messaging: m, now: FAR });
      await runAppointmentTexts({ messaging: m, now: new Date(FAR.getTime() + 6 * 3_600_000) });
      expect(callsFor(calls, p)).toHaveLength(1);
      expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } })).toMatchObject({ status: 'FAILED', failureCode: failure });
    }
  });

  it('honours STOP: marks the patient opted out, audits it, and never texts them again', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const { m, calls } = fakeMessaging(() => { throw new MessagingError('opted_out'); });
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } })).toMatchObject({ status: 'FAILED', failureCode: 'opted_out' });
    expect((await prisma.patient.findUniqueOrThrow({ where: { id: p.id } })).smsOptIn).toBe(false);

    await runAppointmentTexts({ messaging: m, now: T1 });
    expect(callsFor(calls, p)).toHaveLength(1);
    const rows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('provider_opt_out');
  });

  it('treats an unexpected error as transient and keeps the recipient out of the database and the logs', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    const secretNumber = to(p);
    const { m } = fakeMessaging(() => { throw new Error(`Twilio rejected ${secretNumber} for Ingrid`); });
    const seen: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { seen.push(a.map(String).join(' ')); }));
    try {
      await runAppointmentTexts({ messaging: m, now: FAR });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const row = await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } });
    expect(row).toMatchObject({ status: 'QUEUED', failureCode: 'transient' });
    expect(blob(row)).not.toContain(p.phone.replace(/\D/g, '').slice(3));
    expect(seen.join('\n')).not.toContain(p.phone.replace(/\D/g, '').slice(3));
    expect(seen.join('\n')).toContain('sms_send_unexpected_error');
  });

  it('picks up a message whose sender crashed after claiming it (expired lease)', async () => {
    const p = await consenting();
    const b = await appt(p.id);
    await prisma.messageLog.create({
      data: { bookingId: b.id, patientId: p.id, kind: 'CONFIRMATION', forStart: APPT, templateId: 'appt_confirmation_v2', attempts: 1, nextAttemptAt: new Date(FAR.getTime() - 60_000) },
    });
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(callsFor(calls, p)).toHaveLength(1);
    expect(await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b.id } })).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('does not send a stale retry for an appointment that was cancelled or moved meanwhile', async () => {
    const cancelledP = await consenting();
    const movedP = await consenting();
    const cancelled = await appt(cancelledP.id, { status: 'CANCELLED' });
    const moved = await appt(movedP.id, { start: slotAt('12:00', WED) });
    for (const [b, p, forStart] of [[cancelled, cancelledP, APPT], [moved, movedP, APPT]] as const) {
      await prisma.messageLog.create({ data: { bookingId: b.id, patientId: p.id, kind: 'CONFIRMATION', forStart, templateId: 'appt_confirmation_v2', attempts: 1, nextAttemptAt: new Date(FAR.getTime() - 1000) } });
    }
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: FAR });
    expect(callsFor(calls, cancelledP)).toHaveLength(0);
    // The moved one is texted for its NEW time only (one confirmation), never the old.
    expect(callsFor(calls, movedP).map((c) => c.variables.time)).toEqual(['12:00 PM']);
    expect((await prisma.messageLog.findFirstOrThrow({ where: { bookingId: cancelled.id } })).failureCode).toBe('superseded');
  });
});

describe('the scheduler entry point', () => {
  it('runs the job through the configured provider, and does nothing when messaging is switched off', async () => {
    await loadIntegrations();
    const on = await runAllJobsOnce();
    expect(on.appointmentTexts).not.toHaveProperty('disabled');

    await prisma.integrationConfig.update({ where: { kind: 'MESSAGING' }, data: { enabled: false } });
    try {
      await loadIntegrations();
      expect((await runAllJobsOnce()).appointmentTexts).toEqual({ disabled: true });
    } finally {
      await prisma.integrationConfig.update({ where: { kind: 'MESSAGING' }, data: { enabled: true } });
      await loadIntegrations();
    }
  });
});
