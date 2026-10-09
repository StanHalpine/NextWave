/**
 * Concurrency tests for the Phase 2 write paths (risk R-2).
 *
 * The hazard: the booking engine takes row locks in a fixed order — every room the
 * service may use, then every person who may deliver it, each ORDER BY id — and the
 * existing approve route locks rooms and then updates a booking row. New code that
 * took a Booking lock FIRST and rooms second could deadlock against it. These tests
 * fire many requests at once at the same slot and at each other and assert that
 *   • exactly as many win as there are places (never more: no double booking),
 *   • losers get a clean 409, never a 500 and never a hang (a deadlock would surface
 *     as a Postgres error → 500, or a timeout),
 *   • nothing is half-written.
 *
 * Re-run with NW_TEST_POOL=3 to shrink the connection pool; with a pool that small a
 * lock-ordering mistake is hit every time instead of once in a while.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { makeAccount, signInFully } from './helpers.js';
import { TUESDAY_1007, makeClinic, makePatient, post, slotAt } from './phase2.js';

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
const tally = (statuses: number[]) => statuses.reduce<Record<number, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {});

/** Active bookings of a service, with a check that no room or person is over-committed at any instant. */
async function assertNoOvercommit(serviceId: string) {
  const rows = await prisma.booking.findMany({
    where: { serviceId, status: { in: ['CONFIRMED', 'PENDING_REVIEW'] } },
    include: { resource: true },
  });
  for (const a of rows) {
    const clash = rows.filter((b) => b.resourceId === a.resourceId && b.startTime < a.endTime && b.endTime > a.startTime);
    expect(clash.length, `room ${a.resource.name} holds ${clash.length} at once`).toBeLessThanOrEqual(a.resource.maxCapacity);
    const sameDoc = rows.filter((b) => b.staffId && b.staffId === a.staffId && b.startTime < a.endTime && b.endTime > a.startTime);
    expect(sameDoc.length, 'one provider booked twice at once').toBeLessThanOrEqual(1);
  }
}

describe('walk-in races', () => {
  it('12 walk-ins for one room and one provider: exactly one wins', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 1, staff: 1 });
    const patients = await Promise.all(Array.from({ length: 12 }, () => makePatient()));

    const res = await Promise.all(patients.map((p) => post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id })));
    expect(tally(res.map((r) => r.status))).toEqual({ 201: 1, 409: 11 });
    for (const r of res.filter((x) => x.status === 409)) expect(r.body.nextAvailable).toBeInstanceOf(Array);

    expect(await prisma.booking.count({ where: { serviceId: clinic.service.id } })).toBe(1);
    expect(await prisma.encounter.count({ where: { booking: { serviceId: clinic.service.id } } })).toBe(1);
    // Losers rolled back whole: no orphan contact snapshots for them.
    expect(await prisma.user.count({ where: { bookings: { none: {} }, name: { startsWith: 'Test ' } } })).toBe(0);
    await assertNoOvercommit(clinic.service.id);
  });

  it('is limited by the scarcer of rooms and people (2 rooms, 3 providers → 2 winners, in different rooms)', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 2, staff: 3 });
    const patients = await Promise.all(Array.from({ length: 10 }, () => makePatient()));
    const res = await Promise.all(patients.map((p) => post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id })));
    expect(tally(res.map((r) => r.status))).toEqual({ 201: 2, 409: 8 });
    const won = res.filter((r) => r.status === 201).map((r) => r.body.appointment);
    expect(new Set(won.map((w) => w.resource.id)).size).toBe(2);
    expect(new Set(won.map((w) => w.staff.id)).size).toBe(2);
    await assertNoOvercommit(clinic.service.id);

    const people = await Promise.all(Array.from({ length: 10 }, () => makePatient()));
    const scarce = await makeClinic({ rooms: 3, staff: 1 });
    const res2 = await Promise.all(people.map((p) => post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: scarce.service.id })));
    expect(tally(res2.map((r) => r.status))).toEqual({ 201: 1, 409: 9 });
  });

  it('respects a room that seats several (capacity 3, five providers → 3 winners)', async () => {
    const fd = await fdLogin();
    const clinic = await makeClinic({ rooms: 1, staff: 5, capacity: 3 });
    const patients = await Promise.all(Array.from({ length: 10 }, () => makePatient()));
    const res = await Promise.all(patients.map((p) => post(fd, '/api/fd/walk-ins', { patientId: p.id, serviceId: clinic.service.id })));
    expect(tally(res.map((r) => r.status))).toEqual({ 201: 3, 409: 7 });
    await assertNoOvercommit(clinic.service.id);
  });

  it('a walk-in and a scheduled appointment fighting for overlapping time: one winner', async () => {
    const fd = await fdLogin();
    // 30-minute service, one room, one provider: a 10:00 walk-in covers 10:00–10:30, so a 10:15 booking collides.
    for (let round = 0; round < 4; round++) {
      const clinic = await makeClinic({ rooms: 1, staff: 1 });
      const [pa, pb, pc, pd] = await Promise.all([makePatient(), makePatient(), makePatient(), makePatient()]);
      const res = await Promise.all([
        post(fd, '/api/fd/walk-ins', { patientId: pa.id, serviceId: clinic.service.id }),
        post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('10:15').toISOString(), patientId: pb.id }),
        post(fd, '/api/fd/walk-ins', { patientId: pc.id, serviceId: clinic.service.id }),
        post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt('10:15').toISOString(), patientId: pd.id }),
      ]);
      expect(tally(res.map((r) => r.status))[201], `round ${round}: ${res.map((r) => r.status)}`).toBe(1);
      expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      await assertNoOvercommit(clinic.service.id);
    }
  });
});

describe('every path that touches a booking, at once (deadlock hunt)', () => {
  it('walk-ins, creates, moves, cancels, check-ins, approvals and declines all complete, and the books still balance', async () => {
    const fd = await fdLogin();

    for (let round = 0; round < 3; round++) {
      const clinic = await makeClinic({ rooms: 2, staff: 2 });
      const patients = await Promise.all(Array.from({ length: 30 }, () => makePatient()));
      let i = 0;
      const nextPatient = () => patients[i++ % patients.length]!.id;

      // Existing appointments for the movers/cancellers/check-in-ers to fight over, spread over the afternoon.
      const confirmed: string[] = [];
      for (const t of ['12:00', '12:30', '13:00', '13:30', '14:00', '14:30']) {
        const r = await post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt(t).toISOString(), patientId: nextPatient() });
        expect(r.status).toBe(201);
        confirmed.push(r.body.appointment.id);
      }
      // Online requests waiting for a decision, in times nothing else targets.
      const pending: string[] = [];
      for (const t of ['16:00', '16:30', '17:00', '17:30']) {
        const patient = await prisma.patient.findUniqueOrThrow({ where: { id: nextPatient() } });
        const user = await prisma.user.create({ data: { name: patient.firstName, email: 'r@example.test', phone: patient.phone } });
        const b = await prisma.booking.create({
          data: { userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[0]!.id, staffId: clinic.staff[0]!.id, startTime: slotAt(t), endTime: new Date(slotAt(t).getTime() + 30 * 60_000), status: 'PENDING_REVIEW' },
        });
        pending.push(b.id);
      }

      const calls: Array<Promise<{ status: number }>> = [];
      const walk = () => post(fd, '/api/fd/walk-ins', { patientId: nextPatient(), serviceId: clinic.service.id });
      const book = (t: string) => post(fd, '/api/schedule/appointments', { serviceId: clinic.service.id, start: slotAt(t).toISOString(), patientId: nextPatient() });
      const move = (id: string, t: string) => post(fd, `/api/schedule/appointments/${id}/move`, { start: slotAt(t).toISOString() });
      const cancel = (id: string) => post(fd, `/api/schedule/appointments/${id}/cancel`, { reason: 'other' });
      const checkIn = (id: string) => post(fd, `/api/fd/appointments/${id}/check-in`);
      const patchStatus = (id: string, status: string) => fd.agent.patch(`/api/bookings/${id}`).set('x-csrf-token', fd.csrf).send({ status });

      for (let k = 0; k < 6; k++) calls.push(walk());
      for (const t of ['11:00', '11:30', '12:00', '12:30', '15:00', '15:30', '15:00', '15:30']) calls.push(book(t));
      calls.push(move(confirmed[0]!, '12:30'), move(confirmed[1]!, '15:00'), move(confirmed[2]!, '15:30'), move(confirmed[3]!, '11:00'));
      calls.push(cancel(confirmed[4]!), cancel(confirmed[0]!), cancel(confirmed[3]!));
      calls.push(checkIn(confirmed[1]!), checkIn(confirmed[5]!), checkIn(confirmed[4]!));
      calls.push(patchStatus(pending[0]!, 'CONFIRMED'), patchStatus(pending[1]!, 'CONFIRMED'), patchStatus(pending[2]!, 'DECLINED'), patchStatus(pending[3]!, 'CONFIRMED'));

      const res = await Promise.all(calls);
      const bad = res.filter((r) => ![200, 201, 400, 404, 409].includes(r.status));
      expect(bad.map((r) => r.status), `round ${round}: unexpected statuses`).toEqual([]);

      await assertNoOvercommit(clinic.service.id);
      // A patient is never cancelled and checked in at the same time.
      const enc = await prisma.encounter.findMany({ where: { booking: { serviceId: clinic.service.id }, status: { in: ['CHECKED_IN', 'CHECKED_OUT'] } }, include: { booking: true } });
      for (const e of enc) expect(e.booking.status, 'checked-in patient whose appointment is cancelled').not.toBe('CANCELLED');
      // No half-moves: every active booking still has its room, provider and a sane end time.
      const active = await prisma.booking.findMany({ where: { serviceId: clinic.service.id, status: { in: ['CONFIRMED', 'PENDING_REVIEW'] } } });
      for (const b of active) {
        expect(b.staffId).not.toBeNull();
        expect(b.endTime.getTime() - b.startTime.getTime()).toBe(30 * 60_000);
      }
    }
  });
});
