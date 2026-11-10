import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { makeClinic, makePatient, slotAt } from './phase2.js';

/**
 * Rev 2.4.x, the Front Desk:
 *   • "Still open from earlier days": on TODAY's board, visits from earlier clinic days still CHECKED_IN or IN_PROGRESS.
 *   • The deep link /front-desk?date=<the appointment's localDate>&appt=<id>: the day it names is the clinic's (America/Chicago) day the
 *     appointment is on, and the dashboard for that day lists it — across midnight and both DST changes.
 * Days in 2033 that nothing else uses, because the schema is shared: assertions are on this file's own rows, never on totals alone.
 */

afterEach(() => setClockForTests(null));
afterAll(() => setClockForTests(null));

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
type Enc = 'SCHEDULED' | 'CHECKED_IN' | 'IN_PROGRESS' | 'SEEN' | 'CHECKED_OUT' | 'NO_SHOW';

/** A visit at a clinic-local time on a clinic-local day, in the state given, inserted directly (past days cannot be booked). */
async function visitAt(clinic: Awaited<ReturnType<typeof makeClinic>>, date: string, hhmm: string, enc: Enc | null, status: 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED') {
  const patient = await makePatient();
  const user = await prisma.user.create({ data: { name: `${patient.firstName} ${patient.lastName}`, email: '', phone: patient.phone } });
  const start = slotAt(hhmm, date);
  const b = await prisma.booking.create({
    data: {
      userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status, patientId: patient.id,
    },
  });
  if (enc) await prisma.encounter.create({ data: { bookingId: b.id, status: enc, checkedInAt: enc === 'SCHEDULED' || enc === 'NO_SHOW' ? null : start } });
  return { booking: b, patient };
}
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

describe('still open from earlier days (today\'s Front Desk)', () => {
  it('lists earlier-day visits still checked in or with the provider, oldest first — not today\'s, not finished ones, not cancelled', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    setClockForTests(new Date('2033-05-11T15:00:00Z'));                                        // Wed 11 May 2033, 10:00 CDT
    const twoWeeks = await visitAt(clinic, '2033-04-27', '09:00', 'IN_PROGRESS');
    const yesterdayIn = await visitAt(clinic, '2033-05-10', '14:00', 'CHECKED_IN');
    const yesterdayLate = await visitAt(clinic, '2033-05-10', '23:30', 'CHECKED_IN');       // 04:30 UTC on the 11th: still the 10th in Chicago
    const seen = await visitAt(clinic, '2033-05-10', '10:00', 'SEEN');
    const out = await visitAt(clinic, '2033-05-10', '11:00', 'CHECKED_OUT');
    const noShow = await visitAt(clinic, '2033-05-10', '12:00', 'NO_SHOW');
    const cancelled = await visitAt(clinic, '2033-05-10', '13:00', 'CHECKED_IN', 'CANCELLED');
    const todayIn = await visitAt(clinic, '2033-05-11', '09:00', 'CHECKED_IN');
    const justAfterMidnight = await visitAt(clinic, '2033-05-11', '00:15', 'CHECKED_IN');  // 05:15 UTC: today in Chicago, so not "earlier"

    const r = await fd.agent.get('/api/fd/dashboard');
    expect(r.status).toBe(200);
    const listed = ids(r.body.staleOpen);
    const mine = [twoWeeks, yesterdayIn, yesterdayLate].map((v) => v.booking.id);
    expect(listed.filter((id: string) => mine.includes(id))).toEqual(mine);                    // all three, oldest first
    for (const v of [seen, out, noShow, cancelled, todayIn, justAfterMidnight]) expect(listed, v.booking.id).not.toContain(v.booking.id);
    expect(r.body.staleOpenCount).toBeGreaterThanOrEqual(3);
    expect(r.body.staleOpenCount).toBeGreaterThanOrEqual(r.body.staleOpen.length);
    // today's checked-in visits stay in their column
    expect(ids(r.body.checkedIn)).toEqual(expect.arrayContaining([todayIn.booking.id, justAfterMidnight.booking.id]));
    // each row says its own clinic day — the late one is the 10th, not the 11th — which is the day its deep link opens
    const late = r.body.staleOpen.find((a: { id: string }) => a.id === yesterdayLate.booking.id);
    expect([late.localDate, late.localStart, late.encounter.status]).toEqual(['2033-05-10', '23:30', 'CHECKED_IN']);
    expect(late.patient.name).toContain(yesterdayLate.patient.firstName);
  });

  it('is on today\'s board only; once checked out or moved back, a visit leaves the list', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    setClockForTests(new Date('2033-06-08T15:00:00Z'));                                        // Wed 8 June 2033
    const v = await visitAt(clinic, '2033-06-07', '15:00', 'CHECKED_IN');
    expect(ids((await fd.agent.get('/api/fd/dashboard')).body.staleOpen)).toContain(v.booking.id);
    const other = await fd.agent.get('/api/fd/dashboard?date=2033-06-07');
    expect([other.body.isToday, other.body.staleOpen, other.body.staleOpenCount]).toEqual([false, [], 0]);
    expect(ids(other.body.checkedIn)).toContain(v.booking.id);                                  // on its own day, where it always was
    const undo = await fd.agent.post(`/api/fd/appointments/${v.booking.id}/undo-check-in`).set('x-csrf-token', fd.csrf).send({});
    expect(undo.status).toBe(200);
    expect(ids((await fd.agent.get('/api/fd/dashboard')).body.staleOpen)).not.toContain(v.booking.id);
  });

  it('is scoped like the rest of the Front Desk: refused to anonymous callers and providers; the audit row carries a count, no names', async () => {
    const clinic = await makeClinic({ rooms: 1, staff: 1 });
    setClockForTests(new Date('2033-07-13T15:00:00Z'));
    const v = await visitAt(clinic, '2033-07-12', '09:30', 'CHECKED_IN');
    expect((await request(app).get('/api/fd/dashboard')).status).toBe(401);
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await prov.agent.get('/api/fd/dashboard')).status).toBe(403);
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    expect(ids((await admin.agent.get('/api/fd/dashboard')).body.staleOpen)).toContain(v.booking.id);
    const fd = await fdLogin();
    await fd.agent.get('/api/fd/dashboard');
    const rows = await auditRows({ resourceType: 'appointment', action: 'READ', actorAccountId: fd.state.account.id });
    const row = rows.find((x: any) => (x.meta as { scope?: string })?.scope === 'front_desk_dashboard');
    expect((row!.meta as { staleOpen: number }).staleOpen).toBeGreaterThanOrEqual(1);
    expect(blob(rows)).not.toContain(v.patient.lastName);
  });
});

describe('the deep link\'s day is the appointment\'s clinic day — the dashboard for it lists the appointment', () => {
  const cases: Array<[string, string, string]> = [
    // [clinic day, clinic time, why]
    ['2033-05-10', '23:30', 'late evening: the next day in UTC'],
    ['2033-05-11', '00:15', 'just after midnight: the previous day in UTC'],
    ['2033-11-06', '01:30', 'the 25-hour day (DST ends): the repeated hour'],
    ['2033-11-06', '23:30', 'the 25-hour day: its last half hour'],
    ['2033-03-13', '00:30', 'the 23-hour day (DST starts): before the jump'],
    ['2033-03-13', '03:30', 'the 23-hour day: after the jump'],
  ];
  it.each(cases)('%s %s — %s', async (day, hhmm) => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 1, staff: 1 });
    setClockForTests(new Date('2033-02-01T15:00:00Z'));
    const v = await visitAt(clinic, day, hhmm, null);
    // the appointment as the Schedule's dialog has it: its localDate is what "Open on Front Desk" puts in the URL
    const appt = (await fd.agent.get(`/api/schedule/appointments/${v.booking.id}`)).body.appointment;
    expect([appt.localDate, appt.localStart]).toEqual([day, hhmm]);
    const board = await fd.agent.get(`/api/fd/dashboard?date=${appt.localDate}`);
    expect(board.status).toBe(200);
    expect(ids(board.body.scheduled)).toContain(v.booking.id);
    // and not on either neighbouring day
    const prev = new Date(`${day}T12:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 1);
    const next = new Date(`${day}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    for (const d of [prev, next]) {
      const other = await fd.agent.get(`/api/fd/dashboard?date=${d.toISOString().slice(0, 10)}`);
      expect(ids([...other.body.scheduled, ...other.body.checkedIn, ...other.body.done, ...other.body.noShows]), d.toISOString()).not.toContain(v.booking.id);
    }
  });
});
