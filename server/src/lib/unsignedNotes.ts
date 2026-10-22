/**
 * A provider's UNSIGNED NOTES worklist (rev 2.0): every visit booked with that provider whose note is required and not yet
 * signed — still here or long checked out, from any day — oldest first. Check-out no longer waits for the note (providers
 * often write them after the patient has gone: thirty adjustments in a day, notes on breaks or at the end of it), so this is
 * where a pending note is found once its visit has left the day's queue.
 *
 *   scope     the visit's provider PERSON, not their role: the covering provider when one is set, else the one it is booked with
 *             (lib/visitProvider.ts, rev 2.1) — "my unsigned notes". A covered visit moves to the covering provider's list. An
 *             administrator may read anyone's; who may WRITE is decided by the same rule (lib/documentation.ts).
 *   never     a visit whose service needed no note when it was checked in (Encounter.noteRequired = false), a cancelled or
 *             deleted one, or one the patient was never checked in for.
 *   overdue   pending longer than NOTE_OVERDUE_HOURS (config.noteOverdueHours, default 24) since check-in, in elapsed hours.
 *
 * Patient names are in it, so it is served only behind the clinical gate (middleware/clinical.ts). Read only.
 */

import type { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { docStatus } from './documentation.js';
import { CHECKED_IN_STATES, isOverdue, pendingSince } from './noteStatus.js';
import { prisma } from './prisma.js';
import { colorHexFor } from './serviceColors.js';
import { toLocalDateISO, toLocalHHMM } from './time.js';

/** More than this is shown as "and more": the oldest are listed first, so nothing overdue is the part cut off. */
export const WORKLIST_LIMIT = 500;

const INCLUDE = {
  service: { select: { id: true, name: true, color: true, documentationType: true } },
  patient: { select: { id: true, firstName: true, lastName: true } },
  user: { select: { name: true } },
  encounter: { select: { status: true, checkedInAt: true, checkedOutAt: true } },
  documentationDraft: { select: { id: true, updatedAt: true } },
} satisfies Prisma.BookingInclude;

/** The worklist's rule, in one place: this is the visit's provider (covering, else booked), checked in, a note required, none signed. */
const pendingFor = (staffId: string) => ({
  status: 'CONFIRMED',
  encounter: { is: { noteRequired: true, deletedAt: null, status: { in: [...CHECKED_IN_STATES] } } },
  noteSignature: { is: null },
  AND: [{ OR: [{ encounter: { is: { coveringStaffId: staffId } } }, { staffId, encounter: { is: { coveringStaffId: null } } }] }],
}) satisfies Prisma.BookingWhereInput;

export async function unsignedNotes(a: { staffId: string; now: Date }) {
  const found = await prisma.booking.findMany({
    where: pendingFor(a.staffId),
    include: INCLUDE,
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    take: WORKLIST_LIMIT + 1,
  });
  const hours = config.noteOverdueHours;
  const rows = found.slice(0, WORKLIST_LIMIT).map((b) => {
    const since = pendingSince(b);
    const e = b.encounter!;
    return {
      bookingId: b.id,
      localDate: toLocalDateISO(b.startTime),
      localStart: toLocalHHMM(b.startTime),
      patient: { id: b.patient?.id ?? null, name: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.user.name },
      service: { id: b.service.id, name: b.service.name, color: colorHexFor(b.service.color), documentationType: b.service.documentationType },
      subOption: b.subOption,
      visit: { status: e.status, checkedOutAt: e.checkedOutAt },
      /** NONE or DRAFT — a signed visit is never on this list. */
      documentation: { status: docStatus(b), draftUpdatedAt: b.documentationDraft?.updatedAt ?? null },
      pendingSince: since.toISOString(),
      hoursPending: Math.max(0, Math.floor((a.now.getTime() - since.getTime()) / 3_600_000)),
      overdue: isOverdue(since, a.now, hours),
    };
  });
  return { thresholdHours: hours, rows, overdue: rows.filter((r) => r.overdue).length, more: found.length > WORKLIST_LIMIT };
}

/**
 * Just the counts, for the Provider page's link to the worklist: no names, so nothing is read that is not shown. "Overdue" is the same
 * test as the list's (pending since check-in, or the start when there is none, more than the threshold ago).
 */
export async function unsignedNoteCounts(a: { staffId: string; now: Date }) {
  const cutoff = new Date(a.now.getTime() - config.noteOverdueHours * 3_600_000);
  const where = pendingFor(a.staffId);
  const [count, overdue] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.count({
      where: {
        ...where,
        OR: [{ encounter: { is: { checkedInAt: { lt: cutoff } } } }, { encounter: { is: { checkedInAt: null } }, startTime: { lt: cutoff } }],
      },
    }),
  ]);
  return { count, overdue, thresholdHours: config.noteOverdueHours };
}
