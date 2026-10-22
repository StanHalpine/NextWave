/**
 * The covering (rendering) provider (rev 2.1): who is actually seeing a checked-in patient when it is not the provider the visit
 * was booked with — and, from that, who may write and sign its note (lib/visitProvider.ts) and whom check-out records.
 *
 *   providerOptions       who the desk may choose, each with their OTHER appointments overlapping this visit — a warning only
 *   setCoveringProvider   the desk's "Change provider…" (front desk or admin), after check-in and before the note is signed
 *   confirmSignerAsCovering / signatureMismatches
 *                         a note signed by someone other than the visit's provider (possible under the old role rule): listed for an
 *                         administrator, who may confirm the signer as the covering provider. The signature itself is never touched.
 *
 * Only Encounter.coveringStaffId is written. The booking, its slot and the scheduling engine are not touched: before check-in the
 * provider is changed with Move (which re-proves availability), and after it the engine still counts the slot as the scheduled
 * provider's — so it will not stop someone booking the covering provider into the same time. Hence the overlap warning.
 *
 * Every write takes the Booking row lock first (lockedBooking), like every other visit transition, and is audited with ids only.
 */

import type { Prisma, StaffRole } from '@prisma/client';
import { lockedBooking } from './encounters.js';
import { CHECKED_IN_STATES } from './noteStatus.js';
import { prisma } from './prisma.js';
import { SchedulingError } from './scheduling.js';
import type { Rec } from './staffTx.js';
import { toLocalDateISO, toLocalHHMM } from './time.js';
import { visitProviderId } from './visitProvider.js';

type Tx = Prisma.TransactionClient;
const fail = (status: 400 | 404 | 409, code: string, message: string, extra: Record<string, unknown> = {}) => new SchedulingError(status, code, message, extra);

const PROVIDER_STAFF_ROLES: StaffRole[] = ['CHIROPRACTOR', 'NURSE_PRACTITIONER', 'REGISTERED_NURSE'];
const wasCheckedIn = (s: string | undefined) => !!s && (CHECKED_IN_STATES as readonly string[]).includes(s);

const MOVE_INSTEAD = 'This patient has not been checked in yet. Change the provider with Move… on the Schedule: it checks that they are free at that time.';

// ---- who the desk may choose, and what else they have on at that time ---------------------------------------------------------

export async function providerOptions(bookingId: string) {
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: {
      service: { select: { id: true, name: true } },
      staff: { select: { id: true, name: true, role: true } },
      encounter: { select: { status: true, coveringStaffId: true } },
      noteSignature: { select: { id: true } },
    },
  });
  if (!b) return null;
  const current = visitProviderId(b);
  // The same role as the scheduled provider (any provider role when nobody was), active, and set up to perform this service.
  const candidates = await prisma.staff.findMany({
    where: {
      active: true,
      role: b.staff ? b.staff.role : { in: PROVIDER_STAFF_ROLES },
      services: { some: { serviceId: b.serviceId } },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, role: true },
  });
  const ids = candidates.map((c) => c.id);
  // Their other confirmed or requested appointments that overlap this one: booked with them (and not covered by someone else), or
  // covered by them. A plain read; the availability engine is not consulted.
  const overlapping = ids.length ? await prisma.booking.findMany({
    where: {
      id: { not: b.id },
      status: { in: ['CONFIRMED', 'PENDING_REVIEW'] },
      startTime: { lt: b.endTime },
      endTime: { gt: b.startTime },
      OR: [
        { staffId: { in: ids }, OR: [{ encounter: { is: null } }, { encounter: { is: { coveringStaffId: null } } }] },
        { encounter: { is: { coveringStaffId: { in: ids } } } },
      ],
    },
    include: {
      service: { select: { name: true } },
      patient: { select: { firstName: true, lastName: true } },
      user: { select: { name: true } },
      encounter: { select: { coveringStaffId: true } },
    },
    orderBy: { startTime: 'asc' },
  }) : [];
  return {
    bookingId: b.id,
    service: b.service.name,
    scheduled: b.staff ? { id: b.staff.id, name: b.staff.name } : null,
    currentId: current,
    checkedIn: wasCheckedIn(b.encounter?.status),
    signed: !!b.noteSignature,
    options: candidates.map((c) => ({
      id: c.id, name: c.name, role: c.role,
      isCurrent: c.id === current,
      isScheduled: c.id === b.staffId,
      overlaps: overlapping
        .filter((o) => (o.encounter?.coveringStaffId ?? o.staffId) === c.id)
        .map((o) => ({
          bookingId: o.id, localStart: toLocalHHMM(o.startTime), localEnd: toLocalHHMM(o.endTime), service: o.service.name,
          patient: o.patient ? `${o.patient.firstName} ${o.patient.lastName}` : o.user.name,
          status: o.status, asCovering: o.encounter?.coveringStaffId === c.id,
        })),
    })),
  };
}

// ---- the desk's "Change provider…" ------------------------------------------------------------------------------------------------

export async function setCoveringProvider(tx: Tx, rec: Rec, a: { bookingId: string; staffId: string; confirmDraft: boolean }) {
  const locked = await lockedBooking(tx, a.bookingId);                       // 1. the Booking row
  if (locked.status !== 'CONFIRMED') throw fail(409, 'not_confirmed', 'Only a confirmed appointment can have its provider changed.');
  const enc = locked.encounter;
  if (!enc || !wasCheckedIn(enc.status)) throw fail(409, 'use_move', MOVE_INSTEAD);

  const b = await tx.booking.findUniqueOrThrow({
    where: { id: a.bookingId },
    include: {
      service: { select: { id: true, name: true } },
      staff: { select: { id: true, name: true, role: true } },
      noteSignature: { select: { id: true } },
      documentationDraft: { select: { createdByAccountId: true, updatedByAccountId: true } },
    },
  });
  if (b.noteSignature) {
    throw fail(409, 'already_signed', 'The note for this visit is already signed, so its provider can no longer be changed. If someone other than the visit\'s provider signed it, an administrator can confirm them as the covering provider.');
  }
  const target = await tx.staff.findUnique({ where: { id: a.staffId }, select: { id: true, name: true, role: true, active: true } });
  if (!target) throw fail(404, 'unknown_staff', 'Unknown provider.');
  if (!target.active) throw fail(409, 'inactive', `${target.name} is not active.`);
  if (!PROVIDER_STAFF_ROLES.includes(target.role) || (b.staff && target.role !== b.staff.role)) {
    throw fail(409, 'wrong_role', `${target.name} is not in the same provider role as ${b.staff?.name ?? 'this visit'}, so cannot see this patient instead.`);
  }
  const allowed = await tx.serviceStaff.findUnique({ where: { serviceId_staffId: { serviceId: b.serviceId, staffId: target.id } } });
  if (!allowed) throw fail(409, 'not_authorized', `${target.name} is not set up to perform ${b.service.name} (Configuration → Services → Who can perform this).`);

  const current = enc.coveringStaffId ?? b.staffId;
  if (current === target.id) return { changed: false as const };

  // A draft someone else started is not discarded — the new provider sees it — but the desk must say they know it is there.
  const draft = b.documentationDraft;
  if (draft) {
    const author = await tx.account.findUnique({ where: { id: draft.updatedByAccountId }, select: { staffId: true, staff: { select: { name: true } } } });
    if (author?.staffId !== target.id && !a.confirmDraft) {
      throw fail(409, 'draft_open', `${author?.staff?.name ?? 'Another provider'} has started a note for this visit. Change the provider anyway? ${target.name} will see that draft and can finish or replace it.`, { draftBy: author?.staff?.name ?? null });
    }
  }

  const next = target.id === b.staffId ? null : target.id;                  // back to the scheduled provider = no covering provider
  await tx.encounter.update({ where: { id: enc.id }, data: { coveringStaffId: next } });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, meta: { fields: ['coveringStaffId'], from: current, to: target.id, draftOpen: !!draft, via: 'front_desk' } });
  return { changed: true as const };
}

// ---- notes signed by someone other than the visit's provider ----------------------------------------------------------------------

/** An administrator confirms that the note's signer did see the patient: they become the covering provider. Nothing else changes. */
export async function confirmSignerAsCovering(tx: Tx, rec: Rec, a: { bookingId: string }) {
  const locked = await lockedBooking(tx, a.bookingId);
  const enc = locked.encounter;
  const sig = await tx.noteSignature.findUnique({ where: { bookingId: a.bookingId }, select: { signedByStaffId: true } });
  if (!sig || !enc) throw fail(409, 'not_signed', 'This visit has no signed note to confirm.');
  const current = enc.coveringStaffId ?? locked.staffId;
  if (current === sig.signedByStaffId) return { changed: false as const };
  const next = sig.signedByStaffId === locked.staffId ? null : sig.signedByStaffId;
  await tx.encounter.update({ where: { id: enc.id }, data: { coveringStaffId: next } });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, meta: { fields: ['coveringStaffId'], from: current, to: sig.signedByStaffId, via: 'confirm_signer' } });
  return { changed: true as const };
}

export const MISMATCH_LIMIT = 500;

/** Every signed note whose signer is not the visit's provider, oldest first. Names are in it: served behind the clinical gate, admin only. */
export async function signatureMismatches() {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT b."id" FROM "NoteSignature" s
    JOIN "Booking" b ON b."id" = s."bookingId"
    LEFT JOIN "Encounter" e ON e."bookingId" = b."id"
    WHERE COALESCE(e."coveringStaffId", b."staffId") IS NOT NULL
      AND COALESCE(e."coveringStaffId", b."staffId") <> s."signedByStaffId"
    ORDER BY s."signedAt" ASC, b."id" ASC
    LIMIT ${MISMATCH_LIMIT + 1}`;
  const ids = rows.slice(0, MISMATCH_LIMIT).map((r) => r.id);
  const found = ids.length ? await prisma.booking.findMany({
    where: { id: { in: ids } },
    include: {
      service: { select: { name: true } },
      staff: { select: { id: true, name: true } },
      patient: { select: { id: true, firstName: true, lastName: true } },
      user: { select: { name: true } },
      encounter: { select: { coveringStaff: { select: { id: true, name: true } } } },
      noteSignature: { select: { signedAt: true, signedByStaffId: true } },
    },
  }) : [];
  const signers = new Map((await prisma.staff.findMany({ where: { id: { in: found.map((b) => b.noteSignature!.signedByStaffId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const byId = new Map(found.map((b) => [b.id, b]));
  return {
    rows: ids.map((id) => byId.get(id)!).map((b) => ({
      bookingId: b.id,
      start: b.startTime.toISOString(),
      localDate: toLocalDateISO(b.startTime),
      localStart: toLocalHHMM(b.startTime),
      service: b.service.name,
      patient: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.user.name,
      visitProvider: b.encounter?.coveringStaff ?? b.staff,
      signedBy: { id: b.noteSignature!.signedByStaffId, name: signers.get(b.noteSignature!.signedByStaffId) ?? null },
      signedAt: b.noteSignature!.signedAt.toISOString(),
    })),
    more: rows.length > MISMATCH_LIMIT,
  };
}
