/**
 * Staff-side scheduling: create, move and cancel an appointment, and place a walk-in.
 *
 * ── Relationship to the booking engine ────────────────────────────────────────
 * Nothing in the engine is modified. This module CALLS its exported
 * `computeDayAvailability()` to decide what is bookable, and takes row locks in
 * the SAME order the hold route does:
 *
 *      1. every room the service may use     (ORDER BY id, FOR UPDATE)
 *      2. every person who may perform it    (ORDER BY id, FOR UPDATE)
 *      3. only THEN any Booking row
 *
 * The order is what prevents deadlock. The existing approve route locks rooms and
 * then updates a booking row; if new code took a booking-row lock FIRST and then
 * asked for the rooms, one transaction would hold the booking waiting for a room
 * while the other held the room waiting for the booking. So step 3 is a rule, not
 * a preference: never lock a Booking before the Resource rows.
 *
 * The two SELECT … FOR UPDATE statements below are deliberate copies of the ones in
 * routes/holds.ts (the engine's code is not edited, so it cannot be imported).
 * If the engine's locking ever changes, these MUST change with it — the walk-in
 * race test exists to catch a divergence.
 */

import type { BookingSource, Prisma } from '@prisma/client';
import { computeDayAvailability, type Slot } from './availability.js';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { addMinutes, toLocalDateISO } from './time.js';
import type { Rec } from './staffTx.js';

export class SchedulingError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SchedulingError';
  }
}

type Tx = Prisma.TransactionClient;

/** Steps 1 and 2 of the lock order. Identical statements to routes/holds.ts. */
export async function lockServiceResources(tx: Tx, serviceId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT r.id FROM "Resource" r
    JOIN "ServiceRoom" sr ON sr."resourceId" = r.id
    WHERE sr."serviceId" = ${serviceId}
    ORDER BY r.id
    FOR UPDATE OF r`;
  await tx.$queryRaw`
    SELECT st.id FROM "Staff" st
    JOIN "ServiceStaff" ss ON ss."staffId" = st.id
    WHERE ss."serviceId" = ${serviceId}
    ORDER BY st.id
    FOR UPDATE OF st`;
}

export interface SlotRequest {
  serviceId: string;
  start: Date;
  /** Real "now" — a scheduled appointment must be in the future. */
  now: Date;
  /**
   * Walk-ins only. The engine never offers a slot that has already started, but a
   * walk-in is here NOW, in the 15-minute slot we are part-way through. Evaluate
   * availability as of one millisecond before that slot begins, so exactly that
   * slot is considered and nothing earlier.
   */
  allowStartedSlot?: boolean;
  /** Hard requirements: refuse (409) if not free, rather than silently substituting. */
  staffId?: string | null;
  resourceId?: string | null;
  /** Soft preferences: honoured when free, otherwise the first free one is used. */
  preferStaffId?: string | null;
  preferResourceId?: string | null;
}

export interface ProvenSlot {
  slot: Slot;
  resourceId: string;
  staffId: string;
  end: Date;
  durationMin: number;
}

/**
 * Re-prove, under the locks the caller already holds, that `start` is bookable —
 * and choose the room and person. Call lockServiceResources() first.
 */
export async function proveSlot(tx: Tx, req: SlotRequest): Promise<ProvenSlot> {
  if (!req.allowStartedSlot && req.start.getTime() <= req.now.getTime()) {
    throw new SchedulingError(400, 'in_the_past', 'That start time is in the past.');
  }
  const evalNow = req.allowStartedSlot ? new Date(req.start.getTime() - 1) : req.now;
  const day = await computeDayAvailability(tx, req.serviceId, toLocalDateISO(req.start), evalNow);
  if (!day) throw new SchedulingError(404, 'unknown_service', 'Unknown service.');

  const slot = day.slots.find((s) => s.start === req.start.toISOString());
  if (!slot) {
    throw new SchedulingError(409, 'slot_unavailable', day.closedReason ?? 'That time is no longer available.');
  }

  const pick = (free: string[], hard?: string | null, soft?: string | null, what = 'resource') => {
    if (hard) {
      if (!free.includes(hard)) throw new SchedulingError(409, `${what}_unavailable`, `That ${what} is not free at that time.`);
      return hard;
    }
    return soft && free.includes(soft) ? soft : free[0]!;
  };
  return {
    slot,
    resourceId: pick(slot.resourceIds, req.resourceId, req.preferResourceId, 'room'),
    staffId: pick(slot.staffIds, req.staffId, req.preferStaffId, 'provider'),
    end: addMinutes(req.start, day.durationMin),
    durationMin: day.durationMin,
  };
}

export interface BookablePatient {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
}

export interface CreateAppointmentInput extends SlotRequest {
  subOption?: string | null;
  patient: BookablePatient;
  source: BookingSource;
  createdByAccountId: string;
}

/** Create a CONFIRMED appointment for a patient. Staff-made, so no review step. */
export async function createAppointment(tx: Tx, rec: Rec, input: CreateAppointmentInput) {
  const service = await tx.service.findUnique({
    where: { id: input.serviceId },
    include: { options: { select: { label: true } } },
  });
  if (!service) throw new SchedulingError(404, 'unknown_service', 'Unknown service.');
  if (input.subOption) {
    if (!service.options.some((o) => o.label === input.subOption)) {
      throw new SchedulingError(400, 'bad_option', `"${input.subOption}" is not an option for ${service.name}.`);
    }
  }

  await lockServiceResources(tx, input.serviceId);
  const proven = await proveSlot(tx, input);

  // Booking.userId is NOT NULL: every booking carries a contact snapshot. For a
  // staff-made appointment it is copied from the patient record.
  const contact = await tx.user.create({
    data: {
      name: `${input.patient.firstName} ${input.patient.lastName}`.trim(),
      email: input.patient.email ?? '',
      phone: input.patient.phone,
    },
  });
  const booking = await tx.booking.create({
    data: {
      userId: contact.id,
      serviceId: service.id,
      resourceId: proven.resourceId,
      staffId: proven.staffId,
      subOption: input.subOption ?? null,
      startTime: input.start,
      endTime: proven.end,
      status: 'CONFIRMED',
      source: input.source,
      createdByAccountId: input.createdByAccountId,
      patientId: input.patient.id,
    },
  });
  await rec({
    action: 'CREATE',
    resourceType: 'appointment',
    resourceId: booking.id,
    meta: { source: input.source, status: 'CONFIRMED', viaStaff: true },
  });
  return { booking, service, proven };
}

export interface MoveInput {
  bookingId: string;
  start: Date;
  now: Date;
  staffId?: string | null;
  resourceId?: string | null;
}

/**
 * Move an appointment to a new time, in place — its id, patient link and encounter
 * stay attached.
 *
 * The appointment is checked against the schedule AS IF IT WERE NOT THERE, so
 * moving 10:00 → 10:15 is not refused for conflicting with itself. That is done by
 * cancelling it for the duration of the check, inside the transaction: if the new
 * time is not free the error rolls everything back and nothing about the original
 * has changed. Other transactions never see the intermediate state.
 */
export async function moveAppointment(tx: Tx, rec: Rec, input: MoveInput) {
  const head = await tx.booking.findUnique({ where: { id: input.bookingId }, select: { serviceId: true } });
  if (!head) throw new SchedulingError(404, 'unknown_booking', 'Unknown appointment.');

  // Locks first (rooms → staff), THEN read and write the booking. See the header.
  await lockServiceResources(tx, head.serviceId);

  const b = await tx.booking.findUnique({ where: { id: input.bookingId }, include: { encounter: true } });
  if (!b) throw new SchedulingError(404, 'unknown_booking', 'Unknown appointment.');
  if (b.status !== 'CONFIRMED' && b.status !== 'PENDING_REVIEW') {
    throw new SchedulingError(409, 'not_movable', `A ${b.status.toLowerCase().replace('_', ' ')} appointment cannot be moved.`);
  }
  const enc = b.encounter?.status;
  if (enc && enc !== 'SCHEDULED') {
    throw new SchedulingError(409, 'already_started', 'This patient has already been checked in. Undo the check-in first.');
  }
  if (b.startTime.getTime() === input.start.getTime() && !input.staffId && !input.resourceId) {
    return { booking: b, changed: false as const };
  }

  const originalStatus = b.status;
  await tx.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } }); // out of the way, for the check only

  const proven = await proveSlot(tx, {
    serviceId: b.serviceId,
    start: input.start,
    now: input.now,
    staffId: input.staffId,
    resourceId: input.resourceId,
    preferStaffId: b.staffId, // keep the same provider and room when they are free
    preferResourceId: b.resourceId,
  });

  const moved = await tx.booking.update({
    where: { id: b.id },
    data: {
      startTime: input.start,
      endTime: proven.end,
      resourceId: proven.resourceId,
      staffId: proven.staffId,
      status: originalStatus,
    },
  });
  await rec({
    action: 'UPDATE',
    resourceType: 'appointment',
    resourceId: b.id,
    meta: { moved: true, fields: ['startTime', 'endTime', 'resourceId', 'staffId'] },
  });
  return { booking: moved, changed: true as const };
}

export const CANCEL_REASONS = ['patient_request', 'provider_unavailable', 'rescheduled_elsewhere', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/**
 * Cancel an appointment. Locks only the Booking row, never the resource rows
 * (cancelling frees capacity; it cannot over-commit it), which is why it cannot
 * take part in the lock-order cycle described in the header.
 *
 * The reason is a short CODE, not text: free text in a cancellation note is where
 * "cancelled — her chemo schedule changed" ends up in an audit trail.
 */
export async function cancelAppointment(tx: Tx, rec: Rec, input: { bookingId: string; reason: CancelReason }) {
  await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${input.bookingId} FOR UPDATE`;
  const b = await tx.booking.findUnique({ where: { id: input.bookingId }, include: { encounter: true } });
  if (!b) throw new SchedulingError(404, 'unknown_booking', 'Unknown appointment.');
  if (b.status === 'CANCELLED') return { booking: b, changed: false as const };
  if (b.status !== 'CONFIRMED' && b.status !== 'PENDING_REVIEW') {
    throw new SchedulingError(409, 'not_cancellable', `A ${b.status.toLowerCase().replace('_', ' ')} appointment cannot be cancelled.`);
  }
  const enc = b.encounter?.status;
  if (enc && enc !== 'SCHEDULED' && enc !== 'NO_SHOW') {
    throw new SchedulingError(409, 'already_started', 'This patient has been checked in. Undo the check-in before cancelling.');
  }
  const booking = await tx.booking.update({ where: { id: b.id }, data: { status: 'CANCELLED' } });
  await rec({
    action: 'UPDATE',
    resourceType: 'appointment',
    resourceId: b.id,
    meta: { fields: ['status'], to: 'CANCELLED', reasonCode: input.reason },
  });
  return { booking, changed: true as const };
}

/**
 * The slot a walk-in who arrives at `at` occupies: the granularity-aligned slot
 * (clinic wall-clock) that contains `at`. Aligned to local time, as the engine's own
 * slots are, so a 10:07 arrival is the 10:00 slot.
 */
export function walkInSlotStart(at: Date): Date {
  const local = DateTime.fromJSDate(at, { zone: config.clinicTimezone });
  const g = config.slotGranularityMin;
  return local.set({ minute: local.minute - (local.minute % g), second: 0, millisecond: 0 }).toJSDate();
}

export interface WalkInInput {
  serviceId: string;
  now: Date;
  patient: BookablePatient;
  createdByAccountId: string;
  subOption?: string | null;
  staffId?: string | null;
}

/**
 * Place a walk-in: a CONFIRMED appointment starting in the current slot, already
 * CHECKED_IN. Same locks, same availability engine, same re-proof as every other
 * way of taking a slot — a walk-in cannot jump a room or a provider that is busy,
 * and two walk-ins (or a walk-in and an online hold) racing for the last place get
 * exactly one winner.
 */
export async function createWalkIn(tx: Tx, rec: Rec, input: WalkInInput) {
  const start = walkInSlotStart(input.now);
  const { booking, service, proven } = await createAppointment(tx, rec, {
    serviceId: input.serviceId,
    start,
    now: input.now,
    allowStartedSlot: true,
    staffId: input.staffId,
    subOption: input.subOption,
    patient: input.patient,
    source: 'WALK_IN',
    createdByAccountId: input.createdByAccountId,
  });
  const encounter = await tx.encounter.create({
    data: { bookingId: booking.id, status: 'CHECKED_IN', checkedInAt: input.now, checkedInById: input.createdByAccountId },
  });
  await rec({ action: 'CREATE', resourceType: 'encounter', resourceId: encounter.id, meta: { to: 'CHECKED_IN', walkIn: true } });
  return { booking, encounter, service, proven };
}
