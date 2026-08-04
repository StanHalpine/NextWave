/**
 * Booking lifecycle.
 *
 *   HOLD ──POST /api/bookings──▶ PENDING_REVIEW ──PATCH──▶ CONFIRMED
 *                                              └─PATCH──▶ DECLINED
 *                                CONFIRMED ────PATCH──▶ CANCELLED
 *
 * Nothing is ever hard-deleted once it reaches PENDING_REVIEW — declining and
 * cancelling are status changes, so the front desk keeps its history. Only
 * unclaimed holds are deleted outright (see DELETE /api/holds/:id).
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { computeDayAvailability } from '../lib/availability.js';
import { toLocalDateISO } from '../lib/time.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import type { BookingStatus } from '@prisma/client';

export const bookingsRouter = Router();

const confirmBody = z.object({
  holdId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required.').max(120),
  email: z.string().trim().email('A valid email is required.').max(200),
  phone: z.string().trim().min(7, 'A phone number is required.').max(40),
  isRecurring: z.boolean().optional(),
  // Patient-supplied context, e.g. "recovering from knee surgery". NOT a
  // clinical note — provider notes go to VisitNote, which is attributed and
  // amend-only. `.strict()` keeps a stray `notes` key a loud 400 rather than
  // silently discarded input.
  patientNote: z.string().trim().min(1).max(2000).optional(),
}).strict();

/**
 * POST /api/bookings — turn a held slot into a request the front desk reviews.
 *
 * Re-takes the resource lock, because a hold that lapsed between the browser's
 * last check and this call must be re-proved rather than trusted.
 */
bookingsRouter.post('/bookings', async (req, res) => {
  const parsed = confirmBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { holdId, name, email, phone, isRecurring, patientNote } = parsed.data;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const hold = await tx.booking.findUnique({
          where: { id: holdId },
          include: { service: true },
        });
        if (!hold) return { status: 404 as const, error: 'That hold no longer exists.' };

        if (hold.status !== 'HOLD') {
          return {
            status: 409 as const,
            error:
              hold.status === 'PENDING_REVIEW'
                ? 'This request has already been submitted.'
                : `This booking is already ${hold.status.toLowerCase()}.`,
          };
        }

        await tx.$queryRaw`
          SELECT r.id FROM "Resource" r
          JOIN "ServiceRoom" sr ON sr."resourceId" = r.id
          WHERE sr."serviceId" = ${hold.serviceId}
          ORDER BY r.id
          FOR UPDATE OF r`;

        const now = new Date();
        const lapsed = !hold.holdExpiresAt || hold.holdExpiresAt <= now;

        // A lapsed hold stops reserving anything, so re-prove the slot is still
        // open before promoting it. computeDayAvailability already ignores
        // expired holds, so this row does not mask its own conflict.
        if (lapsed) {
          const day = await computeDayAvailability(tx, hold.serviceId, toLocalDateISO(hold.startTime), now);
          const stillFree = day?.slots.some((s) => s.start === hold.startTime.toISOString());
          if (!stillFree) {
            return {
              status: 410 as const,
              error: 'Your hold expired and the slot has been taken. Please choose another time.',
            };
          }
        }

        // Reuse an existing patient record when the email matches.
        const existing = await tx.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: hold.userId } },
          orderBy: { createdAt: 'asc' },
        });

        let userId = hold.userId;
        // The placeholder cannot be dropped yet — this booking still points at
        // it, and removing it first violates Booking_userId_fkey. Repoint the
        // booking below, then clean up.
        let orphanedPlaceholder: string | null = null;
        if (existing) {
          userId = existing.id;
          await tx.user.update({ where: { id: existing.id }, data: { name, phone } });
          orphanedPlaceholder = hold.userId;
        } else {
          await tx.user.update({ where: { id: hold.userId }, data: { name, email, phone } });
        }

        const booking = await tx.booking.update({
          where: { id: hold.id },
          data: {
            userId,
            status: 'PENDING_REVIEW',
            holdExpiresAt: null,
            isRecurring: isRecurring ?? false,
            patientNote: patientNote ?? null,
          },
          include: {
            service: { select: { name: true, category: true } },
            resource: { select: { name: true } },
            staff: { select: { name: true } },
            user: { select: { name: true, email: true, phone: true } },
          },
        });

        // Safe now: the booking points at the real patient. The `none`
        // guard means a placeholder still referenced by any other booking
        // survives rather than failing the whole transaction.
        if (orphanedPlaceholder) {
          await tx.user.deleteMany({
            where: { id: orphanedPlaceholder, email: '', bookings: { none: {} } },
          });
        }

        return { status: 201 as const, booking };
      },
      { timeout: 15_000 },
    );

    if ('error' in result) return res.status(result.status).json({ error: result.error });

    const b = result.booking;
    return res.status(201).json({
      bookingId: b.id,
      status: b.status,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      service: b.service.name,
      category: b.service.category,
      subOption: b.subOption,
      resource: b.resource.name,
      staff: b.staff?.name ?? null,
      patient: b.user,
      message: 'Request received. The front desk will confirm by phone or email.',
    });
  } catch (err) {
    console.error('[bookings] confirm failed', err);
    return res.status(500).json({ error: 'Could not submit that request. Please try again.' });
  }
});

/** GET /api/bookings/:id — a patient checking their own request. */
bookingsRouter.get('/bookings/:id', async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      service: { select: { name: true, category: true } },
      resource: { select: { name: true } },
      staff: { select: { name: true } },
    },
  });
  if (!b) return res.status(404).json({ error: 'Unknown booking.' });

  res.json({
    bookingId: b.id,
    status: b.status,
    start: b.startTime.toISOString(),
    end: b.endTime.toISOString(),
    service: b.service.name,
    category: b.service.category,
    subOption: b.subOption,
    patientNote: b.patientNote,
    resource: b.resource.name,
    staff: b.staff?.name ?? null,
  });
});

// ---------------------------------------------------------------------------
// Front desk
// ---------------------------------------------------------------------------

/** Transitions the front desk is allowed to make. */
const ALLOWED: Record<string, BookingStatus[]> = {
  PENDING_REVIEW: ['CONFIRMED', 'DECLINED'],
  CONFIRMED: ['CANCELLED'],
  HOLD: ['CANCELLED'],
  DECLINED: [],
  CANCELLED: [],
};

const patchBody = z.object({
  status: z.enum(['CONFIRMED', 'DECLINED', 'CANCELLED']),
});

/** PATCH /api/bookings/:id — approve, decline, or cancel. */
bookingsRouter.patch('/bookings/:id', requireFrontDesk, async (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'status must be CONFIRMED, DECLINED, or CANCELLED.' });
  }
  const next = parsed.data.status;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: req.params.id },
        include: { service: true },
      });
      if (!booking) return { status: 404 as const, error: 'Unknown booking.' };

      if (booking.status === next) return { status: 200 as const, booking };

      if (!ALLOWED[booking.status]?.includes(next)) {
        return {
          status: 409 as const,
          error: `Cannot move a ${booking.status} booking to ${next}.`,
        };
      }

      // Approving is the one transition that consumes capacity, so re-check
      // for a conflict the front desk cannot see — e.g. two pending requests
      // for the same chair, both approved in quick succession.
      if (next === 'CONFIRMED') {
        await tx.$queryRaw`
          SELECT r.id FROM "Resource" r
          JOIN "ServiceRoom" sr ON sr."resourceId" = r.id
          WHERE sr."serviceId" = ${booking.serviceId}
          ORDER BY r.id
          FOR UPDATE OF r`;

        const room = await tx.resource.findUniqueOrThrow({ where: { id: booking.resourceId } });
        const rivals = await tx.booking.findMany({
          where: {
            id: { not: booking.id },
            resourceId: booking.resourceId,
            status: 'CONFIRMED',
            startTime: { lt: booking.endTime },
            endTime: { gt: booking.startTime },
          },
        });
        if (rivals.length >= room.maxCapacity) {
          return {
            status: 409 as const,
            error: `${room.name} is already at capacity for that time. Decline, or move this booking first.`,
          };
        }
      }

      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: { status: next, holdExpiresAt: null },
      });
      return { status: 200 as const, booking: updated };
    });

    if ('error' in result) return res.status(result.status).json({ error: result.error });
    return res.json({ bookingId: result.booking.id, status: result.booking.status });
  } catch (err) {
    console.error('[bookings] status update failed', err);
    return res.status(500).json({ error: 'Could not update that booking.' });
  }
});
