import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { computeDayAvailability } from '../src/lib/availability.js';
import { toLocalDateISO } from '../src/lib/time.js';
import { app } from './helpers.js';
import { futureTuesday, makeClinic, slotAt } from './phase2.js';

/**
 * POST /api/bookings (confirm) on a LAPSED hold (rev 2.4.x review): the hold names a provider and a room, and the request keeps them —
 * so both must still be free. Before, the route re-checked only that the TIME was still open with somebody, somewhere, and a lapsed
 * hold could be confirmed onto a provider (or a room) booked in the meantime: a double booking. Now it is 409, never a substitute.
 *
 * The confirm and hold routes use the real clock, so these use real future Tuesdays, each on a clinic of its own (rooms and people
 * nobody else books), so the shared schema cannot interfere.
 */

type Clinic = Awaited<ReturnType<typeof makeClinic>>;
let n = 0;

/** A hold that has already lapsed: it names a room and a provider, and reserves nothing any more. */
async function lapsedHold(c: Clinic, start: Date, room: number, staff: number) {
  const user = await prisma.user.create({ data: { name: 'Pending guest', email: '', phone: '' } });
  return prisma.booking.create({
    data: {
      userId: user.id, serviceId: c.service.id, resourceId: c.rooms[room]!.id, staffId: c.staff[staff]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'HOLD', holdExpiresAt: new Date(Date.now() - 60_000),
    },
  });
}
/** Someone else's booking, made while the first hold sat lapsed. */
async function bookedMeanwhile(c: Clinic, start: Date, room: number, staff: number) {
  const user = await prisma.user.create({ data: { name: 'Someone else', email: '', phone: '6125550000' } });
  return prisma.booking.create({
    data: {
      userId: user.id, serviceId: c.service.id, resourceId: c.rooms[room]!.id, staffId: c.staff[staff]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'CONFIRMED',
    },
  });
}
const confirm = (holdId: string) => request(app).post('/api/bookings').send({
  holdId, name: 'Lapsed Holder', email: `lapsed-${Date.now()}-${++n}@example.test`, phone: '6125550142',
});
/** Whether the TIME is still open with anyone in any room — what the route used to check, and all it checked. */
const timeStillOpen = async (c: Clinic, start: Date) =>
  !!(await computeDayAvailability(prisma, c.service.id, toLocalDateISO(start), new Date()))?.slots.some((s) => s.start === start.toISOString());

describe('confirming a lapsed hold', () => {
  it('fails when its provider was booked in the meantime — even though the time is still open with someone else', async () => {
    const c = await makeClinic({ rooms: 2, staff: 2 });
    const start = slotAt('10:00', futureTuesday(5));
    const hold = await lapsedHold(c, start, 0, 0);
    await bookedMeanwhile(c, start, 1, 0);                                     // the SAME provider, in the other room
    expect(await timeStillOpen(c, start)).toBe(true);                           // the old check would have let it through
    const r = await confirm(hold.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/provider has been booked/);
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } });
    expect([after.status, after.staffId, after.resourceId]).toEqual(['HOLD', c.staff[0]!.id, c.rooms[0]!.id]);   // untouched, not substituted
    expect(await prisma.booking.count({ where: { staffId: c.staff[0]!.id, startTime: start, status: { in: ['PENDING_REVIEW', 'CONFIRMED'] } } })).toBe(1);
  });

  it('fails when its room was booked in the meantime — even though another room and its provider are free', async () => {
    const c = await makeClinic({ rooms: 2, staff: 2 });
    const start = slotAt('11:00', futureTuesday(5));
    const hold = await lapsedHold(c, start, 0, 0);
    await bookedMeanwhile(c, start, 0, 1);                                     // the SAME room, with the other provider
    expect(await timeStillOpen(c, start)).toBe(true);
    const r = await confirm(hold.id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/room for this time has been booked/);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } })).status).toBe('HOLD');
    expect(await prisma.booking.count({ where: { resourceId: c.rooms[0]!.id, startTime: start, status: { in: ['PENDING_REVIEW', 'CONFIRMED'] } } })).toBe(1);
  });

  it('confirms when its provider and room are both still free — keeping them', async () => {
    const c = await makeClinic({ rooms: 2, staff: 2 });
    const start = slotAt('12:00', futureTuesday(5));
    const hold = await lapsedHold(c, start, 1, 1);
    await bookedMeanwhile(c, start, 0, 0);                                     // someone else, but not this provider or room
    const r = await confirm(hold.id);
    expect(r.status).toBe(201);
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } });
    expect([after.status, after.staffId, after.resourceId, after.holdExpiresAt]).toEqual(['PENDING_REVIEW', c.staff[1]!.id, c.rooms[1]!.id, null]);
  });

  it('is still 410 when the time is gone altogether (unchanged)', async () => {
    const c = await makeClinic({ rooms: 1, staff: 1 });
    const start = slotAt('13:00', futureTuesday(5));
    const hold = await lapsedHold(c, start, 0, 0);
    await bookedMeanwhile(c, start, 0, 0);
    const r = await confirm(hold.id);
    expect(r.status).toBe(410);
  });

  it('race: six lapsed holds naming ONE provider, confirmed at once while a second provider is free — exactly one wins', async () => {
    const c = await makeClinic({ rooms: 6, staff: 2 });
    const start = slotAt('14:00', futureTuesday(5));
    const holds = [];
    for (let i = 0; i < 6; i++) holds.push(await lapsedHold(c, start, i, 0));   // six rooms, all naming provider 0
    const results = await Promise.all(holds.map((h) => confirm(h.id)));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((s) => s === 201)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(5);
    expect(results.filter((r) => r.status !== 201 && r.status !== 409)).toEqual([]);
    // provider 0 holds exactly one appointment at that time; provider 1 was never given one (never a substitute)
    const active = { startTime: start, status: { in: ['PENDING_REVIEW' as const, 'CONFIRMED' as const] } };
    expect(await prisma.booking.count({ where: { ...active, staffId: c.staff[0]!.id } })).toBe(1);
    expect(await prisma.booking.count({ where: { ...active, staffId: c.staff[1]!.id } })).toBe(0);
  });
});
