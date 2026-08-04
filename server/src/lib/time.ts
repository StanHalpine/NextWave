/**
 * Wall-clock ↔ UTC helpers.
 *
 * Everything in the database is UTC. Everything a human types — StaffSchedule
 * rows, CLINIC_HOURS, the ?date= query param, the dashboard grid — is local
 * wall-clock time in the clinic's zone. All conversion happens here so DST
 * transitions are handled in exactly one place.
 */

import { DateTime, Interval } from 'luxon';
import { config } from '../config.js';

const ZONE = config.clinicTimezone;

export class TimeError extends Error {}

/** "HH:MM" on a given local calendar date → an absolute UTC Date. */
export function wallClockToUtc(dateISO: string, hhmm: string): Date {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new TimeError(`Expected HH:MM, got "${hhmm}"`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);

  const dt = DateTime.fromISO(dateISO, { zone: ZONE }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  if (!dt.isValid) throw new TimeError(`Invalid date "${dateISO}": ${dt.invalidReason}`);

  // A "spring forward" gap can shift the wall time (e.g. 02:30 does not exist).
  // Luxon lands on the next real instant, which is the behaviour we want.
  return dt.toJSDate();
}

/** ISO weekday for a local calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(dateISO: string): number {
  const dt = DateTime.fromISO(dateISO, { zone: ZONE });
  if (!dt.isValid) throw new TimeError(`Invalid date "${dateISO}": ${dt.invalidReason}`);
  return dt.weekday;
}

/** Start and end of a local calendar day, as UTC instants. */
export function localDayBounds(dateISO: string): { dayStart: Date; dayEnd: Date } {
  const start = DateTime.fromISO(dateISO, { zone: ZONE }).startOf('day');
  if (!start.isValid) throw new TimeError(`Invalid date "${dateISO}": ${start.invalidReason}`);
  return { dayStart: start.toJSDate(), dayEnd: start.plus({ days: 1 }).toJSDate() };
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

/** Half-open overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Render a UTC instant as "HH:MM" in clinic-local time. */
export function toLocalHHMM(d: Date): string {
  return DateTime.fromJSDate(d, { zone: ZONE }).toFormat('HH:mm');
}

/** Render a UTC instant as an ISO local calendar date, "YYYY-MM-DD". */
export function toLocalDateISO(d: Date): string {
  return DateTime.fromJSDate(d, { zone: ZONE }).toFormat('yyyy-MM-dd');
}

/** Today in the clinic's zone, as "YYYY-MM-DD". */
export function clinicToday(): string {
  return DateTime.now().setZone(ZONE).toFormat('yyyy-MM-dd');
}

/**
 * Every slot-granularity instant in [from, to), aligned to the local clock.
 * Alignment is to wall time, not epoch time, so a half-hour-offset zone still
 * yields :00/:15/:30/:45 locally.
 */
export function alignedSlotStarts(from: Date, to: Date, granularityMin: number): Date[] {
  let cursor = DateTime.fromJSDate(from, { zone: ZONE });

  const remainder = cursor.minute % granularityMin;
  if (remainder !== 0 || cursor.second !== 0 || cursor.millisecond !== 0) {
    cursor = cursor
      .plus({ minutes: granularityMin - remainder })
      .set({ second: 0, millisecond: 0 });
  }

  const out: Date[] = [];
  const end = DateTime.fromJSDate(to, { zone: ZONE });
  while (cursor < end) {
    out.push(cursor.toJSDate());
    cursor = cursor.plus({ minutes: granularityMin });
  }
  return out;
}

/** Merge overlapping/adjacent intervals — used to union staff shift windows. */
export function mergeIntervals(ranges: Array<{ start: Date; end: Date }>) {
  const intervals = ranges
    .map((r) => Interval.fromDateTimes(r.start, r.end))
    .filter((i) => i.isValid && i.length('minutes') > 0);

  return Interval.merge(intervals).map((i) => ({
    start: i.start!.toJSDate(),
    end: i.end!.toJSDate(),
  }));
}
