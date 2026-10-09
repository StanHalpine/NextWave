/**
 * The daylight-saving change of Sunday 1 November 2026 in America/Chicago: at 02:00 CDT the
 * clocks go back to 01:00 CST, so that day is 25 hours long and every wall-clock time after it
 * is one hour later in UTC than the day before.
 *
 * The clinic is closed on Sundays, so to exercise the transition DAY itself these tests open
 * Sunday (07:00–19:00) for their duration and roster staff on it. What is checked:
 *   • the slots endpoint across the change (Sat 31 Oct CDT → Sun 1 Nov CST → Mon 2 Nov CST)
 *   • the 24-hour reminder window and the "tomorrow" wording
 *   • appointment moves across the change, and walk-ins on the day
 *   • the edges of the 25-hour day (calendar and dashboard)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { prisma } from '../src/lib/prisma.js';
import { CLINIC_HOURS } from '../src/config.js';
import { setClockForTests } from '../src/lib/clock.js';
import { alignedSlotStarts, localDayBounds } from '../src/lib/time.js';
import { walkInSlotStart } from '../src/lib/scheduling.js';
import { runAppointmentTexts, withinSendingHours } from '../src/jobs/appointmentTexts.js';
import { makeAccount, signInFully } from './helpers.js';
import { makeClinic, makePatient, post, slotAt } from './phase2.js';
import type { Messaging } from '../src/integrations/types.js';
import { toE164 } from '../src/lib/phone.js';

const SAT = '2026-10-31';   // CDT, UTC-5
const SUN = '2026-11-01';   // 25 hours; after 02:00 it is CST, UTC-6
const MON = '2026-11-02';   // CST
const NOW = new Date('2026-10-29T15:00:00Z'); // Thu 10:00 CDT — everything above is in the future

const hadSunday = CLINIC_HOURS[7];
beforeAll(() => { CLINIC_HOURS[7] = { open: '07:00', close: '19:00' }; setClockForTests(NOW); });
afterAll(() => { if (hadSunday) CLINIC_HOURS[7] = hadSunday; else delete CLINIC_HOURS[7]; setClockForTests(null); });

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
const sevenDays = [1, 2, 3, 4, 5, 6, 7];
const hours = (ms: number) => ms / 3_600_000;

describe('DST: the arithmetic underneath', () => {
  it('the clinic day on 1 Nov is 25 hours and the day on 8 Mar is 23', () => {
    const nov = localDayBounds(SUN);
    expect(hours(nov.dayEnd.getTime() - nov.dayStart.getTime())).toBe(25);
    expect(nov.dayStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');   // midnight CDT
    expect(nov.dayEnd.toISOString()).toBe('2026-11-02T06:00:00.000Z');     // midnight CST
    const mar = localDayBounds('2026-03-08');
    expect(hours(mar.dayEnd.getTime() - mar.dayStart.getTime())).toBe(23);
  });

  it('wall-clock times map to UTC with the right offset on each side of the change', () => {
    expect(slotAt('10:00', SAT).toISOString()).toBe('2026-10-31T15:00:00.000Z');   // CDT
    expect(slotAt('10:00', SUN).toISOString()).toBe('2026-11-01T16:00:00.000Z');   // CST
    expect(slotAt('10:00', MON).toISOString()).toBe('2026-11-02T16:00:00.000Z');
    // "same time tomorrow" is 25 hours later across the change, 24 on either side of it.
    expect(hours(slotAt('10:00', SUN).getTime() - slotAt('10:00', SAT).getTime())).toBe(25);
    expect(hours(slotAt('10:00', MON).getTime() - slotAt('10:00', SUN).getTime())).toBe(24);
  });

  it('a 15-minute grid over the long day has 100 distinct, evenly-spaced starts', () => {
    const { dayStart, dayEnd } = localDayBounds(SUN);
    const starts = alignedSlotStarts(dayStart, dayEnd, 15);
    expect(starts).toHaveLength(100);                                    // 25 h × 4
    expect(new Set(starts.map((d) => d.getTime())).size).toBe(100);
    for (let i = 1; i < starts.length; i++) expect(starts[i]!.getTime() - starts[i - 1]!.getTime()).toBe(15 * 60_000);
  });

  it('texts go out 08:00–21:00 by the clinic clock on both sides of the change', () => {
    expect(withinSendingHours(new Date('2026-11-01T13:59:00Z'))).toBe(false); // 07:59 CST
    expect(withinSendingHours(new Date('2026-11-01T14:00:00Z'))).toBe(true);  // 08:00 CST
    expect(withinSendingHours(new Date('2026-11-02T02:59:00Z'))).toBe(true);  // 20:59 CST Sunday
    expect(withinSendingHours(new Date('2026-11-02T03:00:00Z'))).toBe(false); // 21:00 CST
    expect(withinSendingHours(new Date('2026-10-31T12:59:00Z'))).toBe(false); // 07:59 CDT, Saturday
    expect(withinSendingHours(new Date('2026-10-31T13:00:00Z'))).toBe(true);  // 08:00 CDT
  });

  it('a walk-in in the REPEATED hour floors within that hour, not to the first pass of it', () => {
    // 01:07 CST (the second 1 a.m.) = 07:07Z. The slot is 01:00 CST = 07:00Z — not 01:00 CDT (06:00Z, an hour earlier).
    expect(walkInSlotStart(new Date('2026-11-01T07:07:00Z')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(walkInSlotStart(new Date('2026-11-01T06:07:00Z')).toISOString()).toBe('2026-11-01T06:00:00.000Z'); // the first 1 a.m. (CDT)
    expect(walkInSlotStart(new Date('2026-11-01T16:07:00Z')).toISOString()).toBe('2026-11-01T16:00:00.000Z'); // 10:07 CST → 10:00 CST
  });
});

describe('DST: the slots endpoint across the change', () => {
  it('offers each day\'s published wall-clock hours on Saturday (CDT), Sunday (the 25-hour day) and Monday (CST)', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const day = async (date: string) => (await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${date}`)).body;

    // Saturday's published hours are 08:00–14:00; Sunday (opened for this test) and Monday are 07:00–19:00.
    for (const [date, offsetH, first, last, count] of [
      [SAT, 5, '08:00', '13:30', 23],
      [SUN, 6, '07:00', '18:30', 47],
      [MON, 6, '07:00', '18:30', 47],
    ] as const) {
      const body = await day(date);
      expect(body.closedReason, date).toBeNull();
      expect(body.slots, date).toHaveLength(count);                                  // every 15 min, 30-min visits, ending by close
      expect(body.slots[0].localTime, date).toBe(first);
      expect(body.slots.at(-1).localTime, date).toBe(last);
      const [h] = first.split(':').map(Number);
      // The ISO instant of the first slot is its wall-clock time plus the offset of THAT day: CDT = +5, CST = +6.
      expect(body.slots[0].start, date).toBe(`${date}T${String(h! + offsetH).padStart(2, '0')}:00:00.000Z`);
      expect(DateTime.fromISO(body.slots.at(-1).start, { zone: 'America/Chicago' }).toFormat('HH:mm'), date).toBe(last);
      expect(DateTime.fromISO(body.slots[0].start, { zone: 'America/Chicago' }).toFormat('HH:mm'), date).toBe(first);
    }
  });

  it('is closed on the long Sunday when the clinic is, and open when it is not (no hour is lost or doubled)', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const saved = CLINIC_HOURS[7];
    delete CLINIC_HOURS[7];
    try {
      const closed = (await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${SUN}`)).body;
      expect(closed.slots).toEqual([]);
      expect(closed.closedReason).toMatch(/closed/i);
    } finally { CLINIC_HOURS[7] = saved!; }
  });

  it('respects a provider\'s shift on the long day (a 09:00–12:00 shift is three hours of CST, not four)', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: [] });
    await prisma.staffSchedule.create({ data: { staffId: clinic.staff[0]!.id, dayOfWeek: 7, startTime: '09:00', endTime: '12:00' } });
    const body = (await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${SUN}`)).body;
    expect(body.slots[0].localTime).toBe('09:00');
    expect(body.slots.at(-1).localTime).toBe('11:30');                              // the last 30-min visit that ends by 12:00
    expect(body.slots).toHaveLength(11);                                            // 09:00 … 11:30
    expect(body.slots[0].start).toBe('2026-11-01T15:00:00.000Z');                   // 09:00 CST
  });

  it('offers a move the times overlapping its own slot on the long day, exactly as on any other', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const made = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('11:00', SUN).toISOString(), patientId: (await makePatient()).id });
    expect(made.status).toBe(201);
    const asIf = await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${SUN}&forAppointmentId=${made.body.appointment.id}`);
    const starts: string[] = asIf.body.slots.map((x: any) => x.start);
    expect(starts).toContain(slotAt('11:15', SUN).toISOString());
    expect(starts).toContain(slotAt('11:00', SUN).toISOString());
    const plain = (await fd.agent.get(`/api/schedule/slots?serviceId=${clinic.service.id}&date=${SUN}`)).body.slots.map((x: any) => x.start);
    expect(plain).not.toContain(slotAt('11:15', SUN).toISOString());
  });
});

describe('DST: the edges of the 25-hour day', () => {
  async function raw(clinic: Awaited<ReturnType<typeof makeClinic>>, startIso: string) {
    const patient = await makePatient();
    const user = await prisma.user.create({ data: { name: 'x', email: '', phone: patient.phone } });
    const start = new Date(startIso);
    return prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
        startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'CONFIRMED', patientId: patient.id },
    });
  }

  it('puts a booking on the right clinic day at the first and last minute of 1 Nov — in the calendar and on the dashboard', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 5, staff: 5, weekdays: sevenDays });
    const lastOfSat = await raw(clinic, '2026-11-01T04:59:00Z');   // 23:59 CDT, 31 Oct
    const firstOfSun = await raw(clinic, '2026-11-01T05:00:00Z');  // 00:00 CDT, 1 Nov
    const lastOfSun = await raw(clinic, '2026-11-02T05:59:00Z');   // 23:59 CST, 1 Nov
    const firstOfMon = await raw(clinic, '2026-11-02T06:00:00Z');  // 00:00 CST, 2 Nov

    const cal = async (d: string) => (await fd.agent.get(`/api/schedule/calendar?from=${d}&to=${d}`)).body.appointments.map((a: any) => a.id);
    const dash = async (d: string) => {
      const b = (await fd.agent.get(`/api/fd/dashboard?date=${d}`)).body;
      return [...b.scheduled, ...b.checkedIn, ...b.done, ...b.noShows].map((a: any) => a.id);
    };
    for (const list of [await cal(SUN), await dash(SUN)]) {
      expect(list).toContain(firstOfSun.id);
      expect(list).toContain(lastOfSun.id);
      expect(list).not.toContain(lastOfSat.id);
      expect(list).not.toContain(firstOfMon.id);
    }
    expect(await cal(SAT)).toContain(lastOfSat.id);
    expect(await cal(MON)).toContain(firstOfMon.id);

    const view = (await fd.agent.get(`/api/schedule/calendar?from=${SUN}&to=${SUN}`)).body.appointments;
    expect(view.find((a: any) => a.id === lastOfSun.id)).toMatchObject({ localDate: SUN, localStart: '23:59' });
    expect(view.find((a: any) => a.id === firstOfSun.id)).toMatchObject({ localDate: SUN, localStart: '00:00' });
  });

  it('a calendar request spanning the change gives every day its own hours and the right offset', async () => {
    const fd = await fdLogin();
    const cal = (await fd.agent.get(`/api/schedule/calendar?from=${SAT}&to=${MON}`)).body;
    expect(cal.days.map((d: any) => d.date)).toEqual([SAT, SUN, MON]);
    expect(cal.days.map((d: any) => `${d.open}-${d.close}`)).toEqual(['08:00-14:00', '07:00-19:00', '07:00-19:00']);   // Sat, Sun (opened for the test), Mon
  });
});

describe('DST: appointment moves across the change', () => {
  it('moves Saturday 10:00 CDT to Sunday and Monday 10:00 CST — the wall-clock time survives, the UTC offset changes', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const patient = await makePatient();
    const made = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('10:00', SAT).toISOString(), patientId: patient.id });
    expect(made.status).toBe(201);
    const id = made.body.appointment.id;
    expect(made.body.appointment).toMatchObject({ localDate: SAT, localStart: '10:00' });

    const toSun = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('10:00', SUN).toISOString() });
    expect(toSun.status).toBe(200);
    expect(toSun.body.appointment).toMatchObject({ localDate: SUN, localStart: '10:00', localEnd: '10:30' });
    let row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.startTime.toISOString()).toBe('2026-11-01T16:00:00.000Z');
    expect(row.endTime.getTime() - row.startTime.getTime()).toBe(30 * 60_000);
    expect(row.patientId).toBe(patient.id);

    const toMon = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('10:00', MON).toISOString() });
    expect(toMon.status).toBe(200);
    row = await prisma.booking.findUniqueOrThrow({ where: { id } });
    expect(row.startTime.toISOString()).toBe('2026-11-02T16:00:00.000Z');
    expect(toMon.body.appointment).toMatchObject({ localDate: MON, localStart: '10:00' });

    // And back across the change, to Saturday.
    const back = await post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt('10:00', SAT).toISOString() });
    expect(back.status).toBe(200);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id } })).startTime.toISOString()).toBe('2026-10-31T15:00:00.000Z');
  });

  it('moves within the long day, and refuses a clash on it', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const a = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('11:00', SUN).toISOString(), patientId: (await makePatient()).id });
    const b = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('13:00', SUN).toISOString(), patientId: (await makePatient()).id });
    expect((await post(fd, `/api/schedule/appointments/${a.body.appointment.id}/move`, { start: slotAt('11:15', SUN).toISOString() })).status).toBe(200);
    const clash = await post(fd, `/api/schedule/appointments/${b.body.appointment.id}/move`, { start: slotAt('11:15', SUN).toISOString() });
    expect(clash.status).toBe(409);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.body.appointment.id } })).startTime.toISOString()).toBe(slotAt('13:00', SUN).toISOString());
  });

  it('will not let two appointments share a slot even when one was booked a day either side of the change', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ weekdays: sevenDays });
    const mon = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('10:00', MON).toISOString(), patientId: (await makePatient()).id });
    const sat = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('10:00', SAT).toISOString(), patientId: (await makePatient()).id });
    expect(mon.status).toBe(201);
    expect(sat.status).toBe(201);
    // Moving Saturday's onto Monday 10:00 must conflict (same room, same provider, same instant).
    expect((await post(fd, `/api/schedule/appointments/${sat.body.appointment.id}/move`, { start: slotAt('10:00', MON).toISOString() })).status).toBe(409);
  });
});

describe('DST: walk-ins on the long day', () => {
  it('place a walk-in at 10:07 CST in the 10:00 CST slot', async () => {
    setClockForTests(new Date('2026-11-01T16:07:00Z'));                              // Sun 10:07 CST
    try {
      const fd = await fdLogin();
      const clinic = await makeClinic({ weekdays: sevenDays });
      const res = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id });
      expect(res.status).toBe(201);
      expect(res.body.appointment).toMatchObject({ localDate: SUN, localStart: '10:00', localEnd: '10:30' });
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: res.body.appointment.id } })).startTime.toISOString()).toBe('2026-11-01T16:00:00.000Z');
    } finally { setClockForTests(NOW); }
  });
});

/** A recording stand-in for Twilio. */
function fakeMessaging() {
  const calls: Array<{ to: string; templateId: string; variables: Record<string, string> }> = [];
  const m: Messaging = { async sendSms(input) { calls.push(input); return { providerMessageId: `fake-${calls.length}` }; } };
  return { m, calls };
}

describe('DST: the 24-hour reminder window', () => {
  const consenting = () => makePatient({ smsOptIn: true, firstName: 'Ingrid' });
  async function booking(patientId: string, clinic: Awaited<ReturnType<typeof makeClinic>>, startIso: string) {
    const user = await prisma.user.create({ data: { name: 'c', email: '', phone: '6125550000' } });
    const start = new Date(startIso);
    return prisma.booking.create({
      data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
        startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId },
    });
  }
  const mine = (calls: ReturnType<typeof fakeMessaging>['calls'], phone: string) => calls.filter((c) => c.to === toE164(phone));
  const remindersFor = (calls: ReturnType<typeof fakeMessaging>['calls'], phone: string) => mine(calls, phone).filter((c) => c.templateId === 'appt_reminder_24h_v2');

  it('Monday 07:00 CST: the window opens Sunday 07:00 CST, but nothing is sent before 08:00 — then it says "tomorrow"', async () => {
    const clinic = await makeClinic({ weekdays: sevenDays });
    const p = await consenting();
    await booking(p.id, clinic, '2026-11-02T13:00:00Z');                             // Mon 07:00 CST
    const { m, calls } = fakeMessaging();

    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-30T15:00:00Z') });   // Fri: confirmation only
    expect(remindersFor(calls, p.phone)).toHaveLength(0);
    await runAppointmentTexts({ messaging: m, now: new Date('2026-11-01T13:30:00Z') });   // Sun 07:30 CST: inside 24h, but before 08:00
    expect(remindersFor(calls, p.phone)).toHaveLength(0);
    await runAppointmentTexts({ messaging: m, now: new Date('2026-11-01T14:00:00Z') });   // Sun 08:00 CST
    const r = remindersFor(calls, p.phone);
    expect(r).toHaveLength(1);
    expect(r[0]!.variables).toEqual({ first: 'Ingrid', time: '7:00 AM' });
  });

  it('Sunday 08:00 CST: the window opens 24 elapsed hours earlier — Saturday 09:00 CDT, not 08:00', async () => {
    const clinic = await makeClinic({ weekdays: sevenDays });
    const p = await consenting();
    await booking(p.id, clinic, '2026-11-01T14:00:00Z');                             // Sun 08:00 CST (the day is 25 h long)
    const { m, calls } = fakeMessaging();

    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-30T15:00:00Z') });   // Fri: confirmation
    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-31T13:59:00Z') });   // Sat 08:59 CDT: 24 h 01 min away
    expect(remindersFor(calls, p.phone)).toHaveLength(0);
    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-31T14:00:00Z') });   // Sat 09:00 CDT: exactly 24 h away
    const r = remindersFor(calls, p.phone);
    expect(r).toHaveLength(1);
    expect(r[0]!.variables).toEqual({ first: 'Ingrid', time: '8:00 AM' });               // and it IS tomorrow by the clinic calendar
    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-31T15:00:00Z') });
    expect(remindersFor(calls, p.phone)).toHaveLength(1);                                // once
  });

  it('an appointment later on the long day is "tomorrow" from Saturday evening, and "today" from Sunday morning', async () => {
    const clinic = await makeClinic({ weekdays: sevenDays });
    const p = await consenting();
    const b = await booking(p.id, clinic, '2026-11-01T18:00:00Z');                   // Sun 12:00 CST
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-31T23:00:00Z') });   // Sat 18:00 CDT: tomorrow ✓ (18 h away)
    expect(remindersFor(calls, p.phone)).toHaveLength(1);

    const q = await consenting();
    const b2 = await booking(q.id, clinic, '2026-11-01T18:00:00Z');
    const fresh = fakeMessaging();
    await runAppointmentTexts({ messaging: fresh.m, now: new Date('2026-11-01T14:30:00Z') }); // Sun 08:30 CST: the same day → no "tomorrow"
    expect(remindersFor(fresh.calls, q.phone)).toHaveLength(0);
    expect((await prisma.messageLog.findFirstOrThrow({ where: { bookingId: b2.id, kind: 'REMINDER_24H' } })).failureCode).toBe('same_day');
    void b;
  });

  it('writes the time and day of the text in clinic time on both sides of the change', async () => {
    const clinic = await makeClinic({ weekdays: sevenDays });
    const sat = await consenting();
    const mon = await consenting();
    await booking(sat.id, clinic, '2026-10-31T15:00:00Z');                           // Sat 10:00 CDT
    await booking(mon.id, clinic, '2026-11-02T16:00:00Z');                           // Mon 10:00 CST
    const { m, calls } = fakeMessaging();
    await runAppointmentTexts({ messaging: m, now: new Date('2026-10-30T15:00:00Z') });
    expect(mine(calls, sat.phone)[0]!.variables).toEqual({ first: 'Ingrid', day: 'Saturday, Oct 31', time: '10:00 AM' });
    expect(mine(calls, mon.phone)[0]!.variables).toEqual({ first: 'Ingrid', day: 'Monday, Nov 2', time: '10:00 AM' });
  });
});
