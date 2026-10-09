import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { walkInSlotStart } from '../src/lib/scheduling.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { TUESDAY_1007, TUESDAY_DATE, makeClinic, makePatient, post, slotAt } from './phase2.js';

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

/** A booking inserted directly, for states the API (rightly) refuses to create — e.g. a start in the past. */
async function rawBooking(clinic: Awaited<ReturnType<typeof makeClinic>>, hhmm: string, status: 'CONFIRMED' | 'PENDING_REVIEW' | 'CANCELLED' = 'CONFIRMED', date = TUESDAY_DATE) {
  const patient = await makePatient();
  const user = await prisma.user.create({ data: { name: `${patient.firstName} ${patient.lastName}`, email: '', phone: patient.phone } });
  const start = slotAt(hhmm, date);
  return prisma.booking.create({
    data: {
      userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status, patientId: patient.id,
    },
  });
}

// Check-out now settles the visit; these workflow tests pay cash ($55.00 — the fixture service has no list price, so the amount is given).
const act = (s: any, id: string, what: 'check-in' | 'undo-check-in' | 'check-out' | 'no-show') =>
  post(s, `/api/fd/appointments/${id}/${what}`, what === 'check-out' ? { payment: 'CASH', priceCents: 5500 } : {});

describe('front desk: access', () => {
  it('is closed to anonymous callers and providers; CSRF is enforced on actions', async () => {
    expect((await request(app).get('/api/fd/dashboard')).status).toBe(401);
    expect((await request(app).post('/api/fd/walk-ins').send({})).status).toBe(401);
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await prov.agent.get('/api/fd/dashboard')).status).toBe(403);
    expect((await post(prov, '/api/fd/walk-ins', {})).status).toBe(403);
    expect((await act(prov, 'x', 'check-in')).status).toBe(403);

    const fd = await fdLogin();
    expect((await fd.agent.post('/api/fd/appointments/x/check-in').send({})).status).toBe(403);
    expect((await fd.agent.get('/api/fd/dashboard')).status).toBe(200);
  });
});

describe('front desk: dashboard', () => {
  it('sorts the day into the three columns from the Encounter table, and audits the read', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 6, staff: 6 });
    const a = await rawBooking(clinic, '11:00');                       // still to arrive
    const b = await rawBooking(clinic, '11:30');                       // here
    const c = await rawBooking(clinic, '12:00');                       // done
    const d = await rawBooking(clinic, '09:00');                       // never came
    const pending = await rawBooking(clinic, '13:00', 'PENDING_REVIEW');
    const cancelled = await rawBooking(clinic, '14:00', 'CANCELLED');
    await act(fd, b.id, 'check-in');
    await act(fd, c.id, 'check-in');
    await act(fd, c.id, 'check-out');
    await act(fd, d.id, 'no-show');

    const res = await fd.agent.get('/api/fd/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: TUESDAY_DATE, today: TUESDAY_DATE, isToday: true, timezone: 'America/Chicago' });
    const ids = (k: string) => res.body[k].map((x: any) => x.id);
    expect(ids('scheduled')).toContain(a.id);
    expect(ids('checkedIn')).toContain(b.id);
    expect(ids('done')).toContain(c.id);
    expect(ids('noShows')).toContain(d.id);
    for (const k of ['scheduled', 'checkedIn', 'done', 'noShows']) {
      expect(ids(k)).not.toContain(pending.id);   // a request is not an appointment yet
      expect(ids(k)).not.toContain(cancelled.id);
    }
    // Each appointment appears in exactly one column.
    const all = ['scheduled', 'checkedIn', 'done', 'noShows'].flatMap(ids);
    expect(new Set(all).size).toBe(all.length);
    expect(res.body.pendingReview).toBeGreaterThanOrEqual(1);
    expect(res.body.scheduled.find((x: any) => x.id === a.id)).toMatchObject({ localStart: '11:00' });

    expect((await auditRows({ resourceType: 'appointment', action: 'READ' })).some((r) => JSON.stringify(r.meta).includes('front_desk_dashboard'))).toBe(true);
  });

  it('can look at another day, validates the date, and says it is not today', async () => {
    const fd = await fdLogin();
    const r = await fd.agent.get('/api/fd/dashboard?date=2026-10-14');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ date: '2026-10-14', isToday: false });
    expect((await fd.agent.get('/api/fd/dashboard?date=tomorrow')).status).toBe(400);
  });
});

describe('front desk: the visit workflow', () => {
  it('checks in, undoes, checks out — idempotently, with an audit row per change', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const b = await rawBooking(clinic, '11:00');

    const ci = await act(fd, b.id, 'check-in');
    expect(ci.status).toBe(200);
    expect(ci.body.appointment.encounter.status).toBe('CHECKED_IN');
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(enc.checkedInAt?.toISOString()).toBe(TUESDAY_1007.toISOString());
    expect(enc.checkedInById).toBe(fd.state.account.id);
    expect((await act(fd, b.id, 'check-in')).status).toBe(200);     // again: a no-op
    expect(await prisma.encounter.count({ where: { bookingId: b.id } })).toBe(1);
    expect(await auditRows({ resourceType: 'encounter', resourceId: enc.id, action: 'CREATE' })).toHaveLength(1);

    const undo = await act(fd, b.id, 'undo-check-in');
    expect(undo.body.appointment.encounter.status).toBe('SCHEDULED');
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: b.id } })).checkedInAt).toBeNull();
    expect((await act(fd, b.id, 'undo-check-in')).status).toBe(409);  // nothing to undo

    await act(fd, b.id, 'check-in');
    const out = await act(fd, b.id, 'check-out');
    expect(out.body.appointment.encounter.status).toBe('CHECKED_OUT');
    const done = await prisma.encounter.findUniqueOrThrow({ where: { bookingId: b.id } });
    expect(done.checkedOutAt?.toISOString()).toBe(TUESDAY_1007.toISOString());
    expect(done.seenAt).not.toBeNull();   // until Phase 4 there is no separate "seen" step
    expect((await act(fd, b.id, 'check-out')).status).toBe(200);
    expect((await act(fd, b.id, 'undo-check-in')).status).toBe(409);  // too late to undo once checked out
    expect(blob(await auditRows({ resourceType: 'encounter', resourceId: enc.id }, 4))).not.toMatch(/Patient/);
  });

  it('only checks in a confirmed appointment that is today', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const pending = await rawBooking(clinic, '11:00', 'PENDING_REVIEW');
    const cancelled = await rawBooking(clinic, '11:30', 'CANCELLED');
    const tomorrow = await rawBooking(clinic, '11:00', 'CONFIRMED', '2026-10-14');
    expect((await act(fd, pending.id, 'check-in')).body.code).toBe('not_confirmed');
    expect((await act(fd, cancelled.id, 'check-in')).body.code).toBe('not_confirmed');
    expect((await act(fd, tomorrow.id, 'check-in')).body.code).toBe('not_today');
    expect((await act(fd, 'no-such-id', 'check-in')).status).toBe(404);
    for (const x of [pending, cancelled, tomorrow]) expect(await prisma.encounter.count({ where: { bookingId: x.id } })).toBe(0);
  });

  it('cannot check out someone who never arrived', async () => {
    const fd = await fdLogin();
    const b = await rawBooking(await makeClinic(), '11:00');
    const r = await act(fd, b.id, 'check-out');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('not_checked_in');
  });

  it('marks a no-show only once the start time has passed, and a late arrival can still check in', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    const future = await rawBooking(clinic, '11:00');
    const early = await act(fd, future.id, 'no-show');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('too_early');

    const past = await rawBooking(clinic, '09:00');
    expect((await act(fd, past.id, 'no-show')).body.appointment.encounter.status).toBe('NO_SHOW');
    expect((await act(fd, past.id, 'no-show')).status).toBe(200);     // idempotent
    const late = await act(fd, past.id, 'check-in');                    // turned up after all
    expect(late.body.appointment.encounter.status).toBe('CHECKED_IN');
    expect((await prisma.encounter.findUniqueOrThrow({ where: { bookingId: past.id } })).noShowAt).toBeNull();
    expect((await act(fd, past.id, 'no-show')).body.code).toBe('already_started');
  });

  it('never leaves a patient both cancelled and checked in, however the two requests interleave', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 8, staff: 8 });
    const appts = await Promise.all(['10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45', '12:00'].map((t) => rawBooking(clinic, t)));
    await Promise.all(appts.flatMap((b) => [
      act(fd, b.id, 'check-in'),
      post(fd, `/api/schedule/appointments/${b.id}/cancel`, { reason: 'other' }),
    ]));
    for (const b of appts) {
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: b.id }, include: { encounter: true } });
      const checkedIn = row.encounter?.status === 'CHECKED_IN';
      expect(row.status === 'CANCELLED' && checkedIn, `booking ${b.id.slice(0, 8)}: ${row.status} / ${row.encounter?.status}`).toBe(false);
    }
  });
});

describe('front desk: walk-ins', () => {
  it('places the walk-in in the current 15-minute slot, confirmed and already checked in', async () => {
    expect(walkInSlotStart(TUESDAY_1007).toISOString()).toBe(slotAt('10:00').toISOString());

    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p = await makePatient();
    const res = await post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id });
    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({ status: 'CONFIRMED', source: 'WALK_IN', localStart: '10:00', localEnd: '10:30' });
    expect(res.body.appointment.encounter.status).toBe('CHECKED_IN');

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: res.body.appointment.id }, include: { encounter: true } });
    expect(row.patientId).toBe(p.id);
    expect(row.createdByAccountId).toBe(fd.state.account.id);
    expect(row.encounter?.checkedInAt?.toISOString()).toBe(TUESDAY_1007.toISOString());
    expect(await auditRows({ resourceType: 'appointment', resourceId: row.id, action: 'CREATE' })).toHaveLength(1);
    expect(await auditRows({ resourceType: 'encounter', resourceId: row.encounter!.id, action: 'CREATE' })).toHaveLength(1);

    const dash = await fd.agent.get('/api/fd/dashboard');
    expect(dash.body.checkedIn.map((x: any) => x.id)).toContain(row.id);
  });

  it('refuses when nothing is free right now, offers the next openings, and writes nothing', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    expect((await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id })).status).toBe(201);

    const before = await prisma.booking.count({ where: { serviceId: clinic.service.id } });
    const loser = await makePatient();
    const res = await post(fd, '/api/fd/walk-ins', { patientId: loser.id, serviceId: clinic.service.id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_unavailable');
    expect(res.body.slotStart).toBe(slotAt('10:00').toISOString());
    expect(res.body.nextAvailable[0]).toBe(slotAt('10:30').toISOString()); // 10:00–10:30 is taken; 10:15 would overlap it
    expect(res.body.nextAvailable.length).toBeLessThanOrEqual(3);
    expect(await prisma.booking.count({ where: { serviceId: clinic.service.id } })).toBe(before);
    expect(await prisma.user.count({ where: { name: `${loser.firstName} ${loser.lastName}` } })).toBe(0);
  });

  it('honours a requested provider and refuses a busy one', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 2 });
    const [a, b] = clinic.staff;
    const first = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id, staffId: b!.id });
    expect(first.body.appointment.staff.id).toBe(b!.id);
    const busy = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id, staffId: b!.id });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('provider_unavailable');
    expect((await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id, staffId: a!.id })).status).toBe(201);
  });

  it('refuses when the clinic is closed', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    setClockForTests(new Date('2026-10-18T15:07:00Z')); // Sunday
    try {
      const res = await post(fd, '/api/fd/walk-ins', { patientId: (await makePatient()).id, serviceId: clinic.service.id });
      expect(res.status).toBe(409);
      expect(res.body.nextAvailable).toEqual([]);
    } finally {
      setClockForTests(TUESDAY_1007);
    }
  });

  it('rejects an unknown patient or service, a bad body, and unknown fields', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p = await makePatient();
    expect((await post(fd, '/api/fd/walk-ins', { patientId: 'nope', serviceId: clinic.service.id })).status).toBe(404);
    expect((await post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: 'nope' })).status).toBe(404);
    expect((await post(fd, '/api/fd/walk-ins', { patientId: p.id })).status).toBe(400);
    expect((await post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id, start: '2026-10-13T16:00:00Z' })).status).toBe(400); // the slot is not the caller's to choose
    expect((await post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id, subOption: 'Not an option' })).status).toBe(400);
  });

  it('does not place a walk-in for a soft-deleted patient', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic();
    const p = await makePatient();
    await prisma.patient.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect((await post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id })).status).toBe(404);
  });
});

describe('walk-in slot arithmetic', () => {
  it('floors to the clinic-local grid and never rounds up', () => {
    const at = (iso: string) => walkInSlotStart(new Date(iso)).toISOString();
    expect(at('2026-10-13T15:00:00.000Z')).toBe('2026-10-13T15:00:00.000Z'); // 10:00:00 sharp is the 10:00 slot
    expect(at('2026-10-13T15:14:59.999Z')).toBe('2026-10-13T15:00:00.000Z');
    expect(at('2026-10-13T15:15:00.000Z')).toBe('2026-10-13T15:15:00.000Z');
    expect(at('2026-10-13T14:59:59.999Z')).toBe('2026-10-13T14:45:00.000Z');
    // Across the autumn DST change the grid still follows the wall clock.
    expect(at('2026-11-03T16:07:00.000Z')).toBe('2026-11-03T16:00:00.000Z'); // 10:07 CST
  });
});
