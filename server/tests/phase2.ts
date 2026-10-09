/** Shared fixtures for the Phase 2 tests. */
import { DateTime } from 'luxon';
import { prisma } from '../src/lib/prisma.js';
import type { Signed } from './helpers.js';

const ZONE = 'America/Chicago';

export const post = (s: Signed, url: string, body: object = {}) => s.agent.post(url).set('x-csrf-token', s.csrf).send(body);
export const patch = (s: Signed, url: string, body: object = {}) => s.agent.patch(url).set('x-csrf-token', s.csrf).send(body);
export const del = (s: Signed, url: string) => s.agent.delete(url).set('x-csrf-token', s.csrf).send({});

/**
 * Tuesday 13 Oct 2026, 10:07 in Minnesota (CDT, UTC-5). Far enough ahead that nothing
 * in the shared seed data collides, and a weekday so the clinic is open.
 * The walk-in slot for this instant is 10:00 local = 15:00Z.
 */
export const TUESDAY_1007 = new Date('2026-10-13T15:07:00Z');
export const TUESDAY_DATE = '2026-10-13';
/** A clinic-local wall time on a date, as a UTC instant (DST-correct). */
export const slotAt = (hhmmLocal: string, date = TUESDAY_DATE) =>
  DateTime.fromISO(`${date}T${hhmmLocal}`, { zone: ZONE }).toJSDate();

/** The first Tuesday at least `minDays` from the REAL now — for tests that cannot pin the clock. */
export function futureTuesday(minDays = 3): string {
  let d = DateTime.now().setZone(ZONE).plus({ days: minDays });
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  return d.toFormat('yyyy-MM-dd');
}

let n = 0;
const rnd = () => `${Date.now().toString(36)}${(++n).toString(36)}`;

/**
 * A service of our own with exactly the rooms and people we say, so a test's outcome
 * does not depend on what the shared seed happens to roster. Open Mon–Sat all day.
 */
export async function makeClinic(opts: { rooms?: number; staff?: number; capacity?: number; durationMin?: number; bufferMin?: number; weekdays?: number[] } = {}) {
  const { rooms = 1, staff = 1, capacity = 1, durationMin = 30, bufferMin = 0, weekdays = [1, 2, 3, 4, 5, 6] } = opts;
  const tag = rnd();
  const service = await prisma.service.create({
    data: { slug: `t-${tag}`, category: 'Chiropractic', name: `Test Service ${tag}`, durationMin, bufferMin, color: 'chiro_saddle' },
  });
  const roomRows = [];
  for (let i = 0; i < rooms; i++) {
    const r = await prisma.resource.create({ data: { name: `Test Room ${tag}-${i}`, type: 'TEST_ROOM', maxCapacity: capacity } });
    await prisma.serviceRoom.create({ data: { serviceId: service.id, resourceId: r.id } });
    roomRows.push(r);
  }
  const staffRows = [];
  for (let i = 0; i < staff; i++) {
    const s = await prisma.staff.create({
      data: {
        name: `Test Provider ${tag}-${i}`, role: 'CHIROPRACTOR',
        schedules: { create: weekdays.map((dayOfWeek) => ({ dayOfWeek, startTime: '07:00', endTime: '19:00' })) },
      },
    });
    await prisma.serviceStaff.create({ data: { serviceId: service.id, staffId: s.id } });
    staffRows.push(s);
  }
  return { service, rooms: roomRows, staff: staffRows, tag };
}

export async function makePatient(over: Partial<{ firstName: string; lastName: string; phone: string; email: string | null; smsOptIn: boolean; preferredName: string }> = {}) {
  const tag = rnd();
  const phone = over.phone ?? `612555${String(1000 + (n % 9000))}`;
  return prisma.patient.create({
    data: {
      firstName: over.firstName ?? 'Test',
      lastName: over.lastName ?? `Patient${tag}`,
      preferredName: over.preferredName ?? null,
      phone,
      phoneDigits: phone.replace(/\D/g, ''),
      email: over.email === undefined ? `p-${tag}@example.test` : over.email,
      smsOptIn: over.smsOptIn ?? false,
      smsOptInAt: over.smsOptIn ? new Date() : null,
      createdById: (await prisma.account.findFirst({ select: { id: true } }))?.id ?? 'test',
    },
  });
}
