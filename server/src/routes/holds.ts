/**
 * Slot holds.
 *
 * WHY THE LOCK IS ON `Resource`, NOT ON `Booking`
 *
 * The spec asks for `SELECT … FOR UPDATE`, and the obvious reading — lock the
 * conflicting Booking rows — cannot work. Two people racing for the *same empty
 * slot* both find zero conflicting bookings, so there is nothing to lock, and
 * both inserts succeed. That is a write-skew phantom: row locks cannot guard a
 * row that does not exist yet.
 *
 * So we lock the scarce resource instead. Every hold attempt for a given room
 * type takes `FOR UPDATE` on that type's Resource rows before it evaluates
 * anything. Those rows always exist, so the lock always bites, and attempts on
 * the same room type serialize. Attempts on unrelated room types stay parallel.
 *
 * Locks are always taken Resource-then-Staff, each ordered by id, so two
 * transactions can never deadlock by grabbing them in opposite orders.
 *
 * THE HOLD ID IS THE SESSION TOKEN
 *
 * The schema has no session-token column, and adding one is not needed: the
 * hold id is already a v4 UUID, unguessable, and scoped to exactly one slot.
 * The browser keeps `{ holdId, expiresAt }` in localStorage and presents the id
 * to confirm or release. See public/booking-session.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { computeDayAvailability } from '../lib/availability.js';
import { addMinutes, toLocalDateISO } from '../lib/time.js';

export const holdsRouter = Router();

const createBody = z.object({
  serviceId: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  subOption: z.string().trim().min(1).max(120).optional(),
  // Optional preferences; ignored if the pick is no longer free.
  resourceId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
});

/** POST /api/holds — claim a slot for HOLD_TTL_MINUTES. */
holdsRouter.post('/holds', async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { serviceId, start, subOption, resourceId, staffId } = parsed.data;

  const startAt = new Date(start);
  if (startAt.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'That start time is in the past.' });
  }

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        const service = await tx.service.findUnique({ where: { id: serviceId } });
        if (!service) return { status: 404 as const, error: 'Unknown service.' };

        // --- serialize on the scarce resources, then the providers ---------
        await tx.$queryRaw`
          SELECT id FROM "Resource"
          WHERE type = ${service.resourceType}
          ORDER BY id
          FOR UPDATE`;
        await tx.$queryRaw`
          SELECT id FROM "Staff"
          WHERE role = ${service.requiredRole}::"StaffRole"
          ORDER BY id
          FOR UPDATE`;

        // --- re-prove the slot now that nobody else can move ---------------
        const now = new Date();
        const day = await computeDayAvailability(tx, serviceId, toLocalDateISO(startAt), now);
        if (!day) return { status: 404 as const, error: 'Unknown service.' };

        const slot = day.slots.find((s) => s.start === startAt.toISOString());
        if (!slot) {
          return {
            status: 409 as const,
            error: day.closedReason ?? 'That time was taken while you were deciding.',
          };
        }

        // Honour the caller's preference when it is still free.
        const chosenResource =
          resourceId && slot.resourceIds.includes(resourceId) ? resourceId : slot.resourceIds[0]!;
        const chosenStaff =
          staffId && slot.staffIds.includes(staffId) ? staffId : slot.staffIds[0]!;

        // Booking.userId is NOT NULL, so a hold needs a User before contact
        // details exist. This placeholder is filled in by POST /api/bookings
        // and swept if the hold lapses. See handoff notes.
        const placeholder = await tx.user.create({
          data: { name: 'Pending guest', email: '', phone: '' },
        });

        const endAt = addMinutes(startAt, service.durationMin);
        const booking = await tx.booking.create({
          data: {
            userId: placeholder.id,
            serviceId: service.id,
            resourceId: chosenResource,
            staffId: chosenStaff,
            subOption: subOption ?? null,
            startTime: startAt,
            endTime: endAt,
            holdExpiresAt: addMinutes(now, config.holdTtlMinutes),
            status: 'HOLD',
          },
          include: {
            service: { select: { name: true, durationMin: true } },
            resource: { select: { name: true } },
            staff: { select: { name: true } },
          },
        });

        return { status: 201 as const, booking };
      },
      { timeout: 15_000 },
    );

    if ('error' in result) return res.status(result.status).json({ error: result.error });

    const b = result.booking;
    return res.status(201).json({
      // Store this in localStorage — it is the session token.
      holdId: b.id,
      expiresAt: b.holdExpiresAt!.toISOString(),
      holdTtlMinutes: config.holdTtlMinutes,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      service: b.service.name,
      subOption: b.subOption,
      resource: b.resource.name,
      staff: b.staff?.name ?? null,
    });
  } catch (err) {
    console.error('[holds] create failed', err);
    return res.status(500).json({ error: 'Could not hold that slot. Please try again.' });
  }
});

/** GET /api/holds/:id — is the localStorage token still good? */
holdsRouter.get('/holds/:id', async (req, res) => {
  const hold = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: {
      service: { select: { name: true } },
      resource: { select: { name: true } },
      staff: { select: { name: true } },
    },
  });
  if (!hold) return res.status(404).json({ error: 'Unknown hold.' });

  const expired = hold.status === 'HOLD' && (!hold.holdExpiresAt || hold.holdExpiresAt <= new Date());

  res.json({
    holdId: hold.id,
    status: hold.status,
    active: hold.status === 'HOLD' && !expired,
    expired,
    expiresAt: hold.holdExpiresAt?.toISOString() ?? null,
    start: hold.startTime.toISOString(),
    end: hold.endTime.toISOString(),
    service: hold.service.name,
    subOption: hold.subOption,
    resource: hold.resource.name,
    staff: hold.staff?.name ?? null,
  });
});

/** DELETE /api/holds/:id — user backed out; free the slot immediately. */
holdsRouter.delete('/holds/:id', async (req, res) => {
  const hold = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!hold) return res.status(404).json({ error: 'Unknown hold.' });
  if (hold.status !== 'HOLD') {
    return res.status(409).json({ error: `Cannot release a booking that is ${hold.status}.` });
  }

  await prisma.$transaction(async (tx) => {
    await tx.booking.delete({ where: { id: hold.id } });
    // Drop the placeholder user this hold created, if it never got details.
    await tx.user.deleteMany({
      where: { id: hold.userId, email: '', bookings: { none: {} } },
    });
  });

  res.status(204).end();
});
