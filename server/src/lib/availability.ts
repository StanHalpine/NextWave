/**
 * The availability engine.
 *
 * One function, `computeDayAvailability`, is the single source of truth for
 * "can this be booked". Both GET /api/availability and POST /api/holds call it
 * — the hold path re-runs it inside the locking transaction, so what the
 * browser was shown is re-proved before anything is written.
 *
 * A slot is offered only when all four hold simultaneously:
 *
 *   1. the appointment fits inside published clinic hours for that weekday
 *   2. a provider of the required role is rostered across the appointment
 *   3. that provider has no conflicting booking
 *   4. some room of the required type has spare capacity
 *
 * Buffers are applied as trailing turnaround: a booking occupies its room and
 * its provider for durationMin + bufferMin. The appointment itself must end by
 * close and by end-of-shift, but its buffer may run past both — otherwise the
 * last appointment of every day would be unbookable.
 */

import type { Prisma, PrismaClient, StaffRole } from '@prisma/client';
import { CLINIC_HOURS, config } from '../config.js';
import {
  addMinutes,
  alignedSlotStarts,
  isoWeekday,
  localDayBounds,
  mergeIntervals,
  overlaps,
  toLocalHHMM,
  wallClockToUtc,
} from './time.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface Slot {
  /** Appointment start, ISO-8601 UTC. */
  start: string;
  /** Appointment end (excludes buffer), ISO-8601 UTC. */
  end: string;
  /** Clinic-local "HH:MM", for display. */
  localTime: string;
  /** Rooms with spare capacity at this instant. */
  resourceIds: string[];
  /** Rostered, unconflicted providers at this instant. */
  staffIds: string[];
  /** Total spare seats across all eligible rooms. */
  remainingCapacity: number;
}

export interface DayAvailability {
  serviceId: string;
  serviceName: string;
  date: string;
  timezone: string;
  durationMin: number;
  bufferMin: number;
  slots: Slot[];
  /** Set when the day yields nothing, so the UI can say why. */
  closedReason?: string;
}

/**
 * Bookings that consume capacity. Declined and cancelled never do; a HOLD only
 * does while unexpired, which is what makes abandoned holds self-healing —
 * no sweeper job is required for correctness.
 */
export function activeBookingFilter(now: Date): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: ['PENDING_REVIEW', 'CONFIRMED'] } },
      { status: 'HOLD', holdExpiresAt: { gt: now } },
    ],
  };
}

/** A booking plus the buffer-expanded window it actually blocks. */
interface Occupancy {
  resourceId: string;
  staffId: string | null;
  blockStart: Date;
  blockEnd: Date;
}

export async function computeDayAvailability(
  db: Db,
  serviceId: string,
  dateISO: string,
  now: Date = new Date(),
): Promise<DayAvailability | null> {
  const service = await db.service.findUnique({ where: { id: serviceId } });
  if (!service) return null;

  const base = {
    serviceId: service.id,
    serviceName: service.name,
    date: dateISO,
    timezone: config.clinicTimezone,
    durationMin: service.durationMin,
    bufferMin: service.bufferMin,
    slots: [] as Slot[],
  };

  const weekday = isoWeekday(dateISO);
  const hours = CLINIC_HOURS[weekday];
  if (!hours) return { ...base, closedReason: 'The clinic is closed on this day.' };

  const openAt = wallClockToUtc(dateISO, hours.open);
  const closeAt = wallClockToUtc(dateISO, hours.close);

  // ---- rooms of the required type -------------------------------------
  const resources = await db.resource.findMany({
    where: { type: service.resourceType },
    orderBy: { id: 'asc' },
  });
  if (resources.length === 0) {
    return { ...base, closedReason: `No ${service.resourceType} room is configured.` };
  }

  // ---- providers rostered on this weekday ------------------------------
  const staff = await db.staff.findMany({
    where: {
      role: service.requiredRole as StaffRole,
      schedules: { some: { dayOfWeek: weekday } },
    },
    include: { schedules: { where: { dayOfWeek: weekday } } },
    orderBy: { id: 'asc' },
  });
  if (staff.length === 0) {
    return { ...base, closedReason: 'No qualified provider is scheduled on this day.' };
  }

  // Each provider's rostered windows, clamped to clinic hours.
  const shiftsByStaff = new Map<string, Array<{ start: Date; end: Date }>>();
  for (const person of staff) {
    const windows = person.schedules
      .map((s) => ({
        start: new Date(Math.max(wallClockToUtc(dateISO, s.startTime).getTime(), openAt.getTime())),
        end: new Date(Math.min(wallClockToUtc(dateISO, s.endTime).getTime(), closeAt.getTime())),
      }))
      .filter((w) => w.start < w.end);
    if (windows.length > 0) shiftsByStaff.set(person.id, windows);
  }
  if (shiftsByStaff.size === 0) {
    return { ...base, closedReason: 'No provider shift overlaps clinic hours on this day.' };
  }

  // Candidate starts span the union of all shifts — no point testing an
  // instant when nobody qualified is on the floor.
  const coverage = mergeIntervals([...shiftsByStaff.values()].flat());

  // ---- existing occupancy ----------------------------------------------
  // Widen the fetch window by the longest possible buffer so a booking that
  // starts before the day but bleeds into it is still counted.
  const { dayStart, dayEnd } = localDayBounds(dateISO);
  const maxBuffer = await db.service.aggregate({ _max: { bufferMin: true } });
  const lookback = (maxBuffer._max.bufferMin ?? 0) + 24 * 60;

  const bookings = await db.booking.findMany({
    where: {
      AND: [
        activeBookingFilter(now),
        { startTime: { lt: dayEnd } },
        { endTime: { gt: addMinutes(dayStart, -lookback) } },
      ],
    },
    include: { service: { select: { bufferMin: true } } },
  });

  const occupancy: Occupancy[] = bookings.map((b) => ({
    resourceId: b.resourceId,
    staffId: b.staffId,
    blockStart: b.startTime,
    blockEnd: addMinutes(b.endTime, b.service.bufferMin),
  }));

  // ---- walk the grid ----------------------------------------------------
  const slots: Slot[] = [];

  for (const window of coverage) {
    for (const start of alignedSlotStarts(window.start, window.end, config.slotGranularityMin)) {
      const apptEnd = addMinutes(start, service.durationMin);

      // The appointment (not its buffer) must finish by close.
      if (apptEnd > closeAt) continue;
      // Never offer a slot in the past.
      if (start <= now) continue;

      const blockEnd = addMinutes(apptEnd, service.bufferMin);

      // Providers rostered across the whole appointment and free of conflicts.
      const freeStaff = staff
        .filter((person) => {
          const windows = shiftsByStaff.get(person.id);
          if (!windows?.some((w) => start >= w.start && apptEnd <= w.end)) return false;
          return !occupancy.some(
            (o) => o.staffId === person.id && overlaps(start, blockEnd, o.blockStart, o.blockEnd),
          );
        })
        .map((p) => p.id);
      if (freeStaff.length === 0) continue;

      // Rooms with a seat left. maxCapacity > 1 means genuine concurrency.
      const freeResources: string[] = [];
      let remainingCapacity = 0;
      for (const room of resources) {
        const used = occupancy.filter(
          (o) => o.resourceId === room.id && overlaps(start, blockEnd, o.blockStart, o.blockEnd),
        ).length;
        const spare = room.maxCapacity - used;
        if (spare > 0) {
          freeResources.push(room.id);
          remainingCapacity += spare;
        }
      }
      if (freeResources.length === 0) continue;

      slots.push({
        start: start.toISOString(),
        end: apptEnd.toISOString(),
        localTime: toLocalHHMM(start),
        resourceIds: freeResources,
        staffIds: freeStaff,
        remainingCapacity,
      });
    }
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));

  return {
    ...base,
    slots,
    ...(slots.length === 0
      ? { closedReason: 'Every slot on this day is taken.' }
      : {}),
  };
}
