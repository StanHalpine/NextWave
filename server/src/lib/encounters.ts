/**
 * The front-desk visit workflow: where the PATIENT is.
 *
 *   SCHEDULED → CHECKED_IN → IN_PROGRESS (a provider opened the visit) → SEEN (the provider signed while the patient
 *   was still here) → CHECKED_OUT, with IN_PROGRESS and SEEN optional: check-out is open from any of CHECKED_IN,
 *   IN_PROGRESS and SEEN, and CHECKED_OUT is reached ONLY through check-out (lib/checkout.ts, which records the payment).
 *
 * Rev 2.0: the note is tracked apart from this (lib/noteStatus.ts — NOT_REQUIRED | PENDING | SIGNED). Check-out never
 * waits for it, so a visit is often CHECKED_OUT with its note still PENDING and signed later; signing a checked-out
 * visit leaves it CHECKED_OUT. SEEN is therefore a signal to the desk ("the provider is done"), not a gate. Whether a
 * visit needs a note at all is fixed when the patient is checked in, by a database trigger (Encounter.noteRequired).
 *
 * The Encounter is separate from the Booking on purpose: the booking's own lifecycle
 * (hold / pending / confirmed / cancelled) belongs to the booking engine and is not
 * touched here. This is about where the PERSON is, not whether the slot is reserved.
 *
 * Every transition takes the Booking row lock first. That serialises a check-in against
 * a cancel or a move arriving at the same instant, so a patient can never be both
 * cancelled and checked in. (Only the Booking row is locked here — never the resource
 * rows — so this cannot join the lock-order cycle described in lib/scheduling.ts.)
 */

import type { Prisma } from '@prisma/client';
import { toLocalDateISO } from './time.js';
import type { Rec } from './staffTx.js';
import { SchedulingError } from './scheduling.js';

type Tx = Prisma.TransactionClient;

export async function lockedBooking(tx: Tx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
  const b = await tx.booking.findUnique({ where: { id: bookingId }, include: { encounter: true } });
  if (!b) throw new SchedulingError(404, 'unknown_booking', 'Unknown appointment.');
  return b;
}

const fail = (status: 409 | 400, code: string, message: string) => new SchedulingError(status, code, message);

export async function checkIn(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; now: Date }) {
  const b = await lockedBooking(tx, a.bookingId);
  if (b.status !== 'CONFIRMED') {
    throw fail(409, 'not_confirmed', b.status === 'PENDING_REVIEW'
      ? 'This request has not been approved yet. Approve it first.'
      : `A ${b.status.toLowerCase().replace('_', ' ')} appointment cannot be checked in.`);
  }
  if (toLocalDateISO(b.startTime) !== toLocalDateISO(a.now)) {
    throw fail(409, 'not_today', "Only today's appointments can be checked in.");
  }
  const enc = b.encounter;
  if (enc?.status === 'CHECKED_IN') return { encounter: enc, changed: false as const }; // idempotent
  if (enc && enc.status !== 'SCHEDULED' && enc.status !== 'NO_SHOW') {
    throw fail(409, 'already_started', 'This visit is already under way or finished.');
  }
  const data = { status: 'CHECKED_IN' as const, checkedInAt: a.now, checkedInById: a.accountId, noShowAt: null };
  const encounter = enc
    ? await tx.encounter.update({ where: { id: enc.id }, data })
    : await tx.encounter.create({ data: { bookingId: b.id, ...data } });
  await rec({ action: enc ? 'UPDATE' : 'CREATE', resourceType: 'encounter', resourceId: encounter.id, meta: { to: 'CHECKED_IN', fields: ['status', 'checkedInAt'] } });
  return { encounter, changed: true as const };
}

export async function undoCheckIn(tx: Tx, rec: Rec, a: { bookingId: string }) {
  const b = await lockedBooking(tx, a.bookingId);
  const enc = b.encounter;
  if (!enc || enc.status !== 'CHECKED_IN') {
    throw fail(409, 'not_checked_in', 'Only a patient who is checked in, and not yet seen, can be moved back.');
  }
  const encounter = await tx.encounter.update({
    where: { id: enc.id },
    data: { status: 'SCHEDULED', checkedInAt: null, checkedInById: null },
  });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, meta: { to: 'SCHEDULED', fields: ['status', 'checkedInAt'] } });
  return { encounter };
}

export async function checkOut(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; now: Date }) {
  const b = await lockedBooking(tx, a.bookingId);
  const enc = b.encounter;
  if (!enc || enc.status === 'SCHEDULED' || enc.status === 'NO_SHOW') {
    throw fail(409, 'not_checked_in', 'This patient has not been checked in.');
  }
  if (enc.status === 'CHECKED_OUT') return { encounter: enc, changed: false as const }; // idempotent
  const encounter = await tx.encounter.update({
    where: { id: enc.id },
    data: { status: 'CHECKED_OUT', checkedOutAt: a.now, checkedOutById: a.accountId, seenAt: enc.seenAt ?? a.now },
  });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, meta: { to: 'CHECKED_OUT', fields: ['status', 'checkedOutAt'] } });
  return { encounter, changed: true as const };
}

export async function markNoShow(tx: Tx, rec: Rec, a: { bookingId: string; now: Date }) {
  const b = await lockedBooking(tx, a.bookingId);
  if (b.status !== 'CONFIRMED') throw fail(409, 'not_confirmed', 'Only a confirmed appointment can be marked as a no-show.');
  if (a.now.getTime() < b.startTime.getTime()) {
    throw fail(409, 'too_early', 'That appointment has not started yet, so the patient cannot be a no-show.');
  }
  const enc = b.encounter;
  if (enc?.status === 'NO_SHOW') return { encounter: enc, changed: false as const };
  if (enc && enc.status !== 'SCHEDULED') throw fail(409, 'already_started', 'This patient has already been checked in.');
  const encounter = enc
    ? await tx.encounter.update({ where: { id: enc.id }, data: { status: 'NO_SHOW', noShowAt: a.now } })
    : await tx.encounter.create({ data: { bookingId: b.id, status: 'NO_SHOW', noShowAt: a.now } });
  await rec({ action: enc ? 'UPDATE' : 'CREATE', resourceType: 'encounter', resourceId: encounter.id, meta: { to: 'NO_SHOW', fields: ['status', 'noShowAt'] } });
  return { encounter, changed: true as const };
}
