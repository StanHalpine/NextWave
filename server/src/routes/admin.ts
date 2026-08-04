/**
 * Admin configuration — staff, shifts, rooms, service timings and prices.
 *
 * These endpoints change what the availability engine will offer, so they are
 * the most consequential writes in the system: halving a room's capacity or
 * deleting a shift silently removes slots patients could otherwise book.
 * Everything here is token-gated alongside the clinical routes.
 *
 * DELETION IS SOFT. Staff and Resource carry an `active` flag rather than
 * being removed, because a departed provider still owns historical bookings
 * and authored clinical notes, and a decommissioned room still appears in past
 * appointments. Hard-deleting either would orphan or destroy that history.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { config } from '../config.js';

export const adminRouter = Router();
adminRouter.use('/admin', requireFrontDesk);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ROLES = ['CHIROPRACTOR', 'NURSE_PRACTITIONER', 'REGISTERED_NURSE', 'FRONT_DESK'] as const;

// ---------------------------------------------------------------------------
// Staff + shifts
// ---------------------------------------------------------------------------

/** GET /api/admin/staff — everyone, including deactivated, with their shifts. */
adminRouter.get('/admin/staff', async (_req, res) => {
  const staff = await prisma.staff.findMany({
    orderBy: [{ active: 'desc' }, { role: 'asc' }, { name: 'asc' }],
    include: {
      schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      _count: { select: { bookings: true, visitNotes: true } },
    },
  });
  // Roles some service actually requires. A role nothing requires (front desk)
  // produces no appointment slots, so the UI must not warn that an empty
  // roster is costing availability — for them it simply is not.
  const delivering = await prisma.service.findMany({
    select: { requiredRole: true },
    distinct: ['requiredRole'],
  });

  res.json({
    deliveringRoles: delivering.map((d) => d.requiredRole),
    staff: staff.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      active: s.active,
      bookingCount: s._count.bookings,
      noteCount: s._count.visitNotes,
      schedules: s.schedules.map((x) => ({
        id: x.id, dayOfWeek: x.dayOfWeek, startTime: x.startTime, endTime: x.endTime,
      })),
    })),
  });
});

const staffBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  role: z.enum(ROLES),
}).strict();

adminRouter.post('/admin/staff', async (req, res) => {
  const parsed = staffBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  const staff = await prisma.staff.create({ data: parsed.data });
  res.status(201).json({ id: staff.id, name: staff.name, role: staff.role, active: true, schedules: [] });
});

const staffPatch = staffBody.partial().extend({ active: z.boolean().optional() }).strict();

adminRouter.patch('/admin/staff/:id', async (req, res) => {
  const parsed = staffPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });

  const existing = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Unknown staff member.' });

  const staff = await prisma.staff.update({ where: { id: existing.id }, data: parsed.data });
  res.json({ id: staff.id, name: staff.name, role: staff.role, active: staff.active });
});

/**
 * DELETE /api/admin/staff/:id
 *
 * Deactivates. Only a member with no bookings and no authored notes — someone
 * added in error — is genuinely removed, because there is nothing to orphan.
 */
adminRouter.delete('/admin/staff/:id', async (req, res) => {
  const staff = await prisma.staff.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { bookings: true, visitNotes: true } } },
  });
  if (!staff) return res.status(404).json({ error: 'Unknown staff member.' });

  if (staff._count.bookings === 0 && staff._count.visitNotes === 0) {
    await prisma.staff.delete({ where: { id: staff.id } });
    return res.json({ removed: true, deactivated: false });
  }

  await prisma.staff.update({ where: { id: staff.id }, data: { active: false } });
  res.json({
    removed: false,
    deactivated: true,
    reason: `Kept because ${staff.name} has ${staff._count.bookings} booking(s) and `
      + `${staff._count.visitNotes} clinical note(s). Deactivated instead — they take no new bookings.`,
  });
});

const shiftsBody = z.object({
  shifts: z.array(z.object({
    dayOfWeek: z.number().int().min(1).max(7),
    startTime: z.string().regex(HHMM, 'Times must be HH:MM.'),
    endTime: z.string().regex(HHMM, 'Times must be HH:MM.'),
  })).max(40),
}).strict();

/**
 * PUT /api/admin/staff/:id/shifts — replace the whole roster for one person.
 *
 * Replace rather than patch: a weekly roster is edited as a unit, and diffing
 * individual rows would make "delete Tuesday" awkward for no benefit.
 */
adminRouter.put('/admin/staff/:id/shifts', async (req, res) => {
  const parsed = shiftsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });

  const staff = await prisma.staff.findUnique({ where: { id: req.params.id } });
  if (!staff) return res.status(404).json({ error: 'Unknown staff member.' });

  for (const s of parsed.data.shifts) {
    if (s.startTime >= s.endTime) {
      return res.status(400).json({
        error: `Shift on day ${s.dayOfWeek} ends at or before it starts (${s.startTime}–${s.endTime}).`,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.staffSchedule.deleteMany({ where: { staffId: staff.id } });
    if (parsed.data.shifts.length) {
      await tx.staffSchedule.createMany({
        data: parsed.data.shifts.map((s) => ({ ...s, staffId: staff.id })),
      });
    }
  });

  // Bookings already made outside the new roster are NOT cancelled — that is a
  // judgement call for the front desk, not a side effect of editing a shift.
  // Surface the count so the change is not silent.
  const orphaned = await prisma.booking.count({
    where: { staffId: staff.id, status: { in: ['PENDING_REVIEW', 'CONFIRMED'] }, startTime: { gte: new Date() } },
  });

  const shifts = await prisma.staffSchedule.findMany({
    where: { staffId: staff.id },
    orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }],
  });
  res.json({ shifts, upcomingBookings: orphaned });
});

// ---------------------------------------------------------------------------
// Resources (rooms)
// ---------------------------------------------------------------------------

adminRouter.get('/admin/resources', async (_req, res) => {
  const resources = await prisma.resource.findMany({
    orderBy: [{ active: 'desc' }, { type: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { bookings: true } } },
  });
  // Services left with no ACTIVE room cannot be booked at all, and the booking
  // page can only say "no availability". Naming the service beats naming a
  // room type — it points straight at what a patient cannot book.
  const services = await prisma.service.findMany({
    select: { name: true, rooms: { select: { resource: { select: { active: true } } } } },
    orderBy: { name: 'asc' },
  });
  const stranded = services
    .filter((s) => !s.rooms.some((r) => r.resource.active))
    .map((s) => s.name);

  res.json({
    resources: resources.map((r) => ({
      id: r.id, name: r.name, type: r.type, maxCapacity: r.maxCapacity,
      active: r.active, bookingCount: r._count.bookings,
    })),
    strandedServices: stranded,
  });
});

const resourceBody = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  type: z.string().trim().min(1, 'Type is required.').max(60)
    .regex(/^[A-Z0-9_]+$/, 'Type must be UPPER_SNAKE_CASE, e.g. IV_CHAIR.'),
  maxCapacity: z.number().int().min(1, 'Capacity must be at least 1.').max(50),
}).strict();

adminRouter.post('/admin/resources', async (req, res) => {
  const parsed = resourceBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });

  const r = await prisma.resource.create({ data: parsed.data });

  // A new room starts assigned to whatever its siblings of the same type
  // already serve. Without this, adding "IV Chair 5" would be a silent no-op:
  // no error, no extra capacity, just fewer slots than expected — the same
  // class of quiet failure as a provider with no shifts.
  const siblings = await prisma.serviceRoom.findMany({
    where: { resource: { type: r.type, id: { not: r.id } } },
    select: { serviceId: true },
    distinct: ['serviceId'],
  });
  if (siblings.length > 0) {
    await prisma.serviceRoom.createMany({
      data: siblings.map((s) => ({ serviceId: s.serviceId, resourceId: r.id })),
    });
  }

  res.status(201).json({
    ...r,
    bookingCount: 0,
    inheritedServices: siblings.length,
  });
});

const resourcePatch = resourceBody.partial().extend({ active: z.boolean().optional() }).strict();

adminRouter.patch('/admin/resources/:id', async (req, res) => {
  const parsed = resourcePatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });

  const existing = await prisma.resource.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Unknown room.' });

  // Reducing capacity below what is already booked at some instant would put
  // the room over its own limit. Refuse rather than silently overbook.
  const nextCap = parsed.data.maxCapacity;
  if (nextCap != null && nextCap < existing.maxCapacity) {
    const upcoming = await prisma.booking.findMany({
      where: {
        resourceId: existing.id,
        status: { in: ['PENDING_REVIEW', 'CONFIRMED'] },
        endTime: { gt: new Date() },
      },
      select: { startTime: true, endTime: true },
    });
    let worst = 0;
    for (const a of upcoming) {
      const overlapping = upcoming.filter((b) => a.startTime < b.endTime && b.startTime < a.endTime).length;
      if (overlapping > worst) worst = overlapping;
    }
    if (worst > nextCap) {
      return res.status(409).json({
        error: `${existing.name} already has ${worst} overlapping bookings. `
          + `Lower the capacity to ${nextCap} only after those are moved.`,
      });
    }
  }

  const r = await prisma.resource.update({ where: { id: existing.id }, data: parsed.data });
  res.json(r);
});

adminRouter.delete('/admin/resources/:id', async (req, res) => {
  const r = await prisma.resource.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { bookings: true } } },
  });
  if (!r) return res.status(404).json({ error: 'Unknown room.' });

  if (r._count.bookings === 0) {
    await prisma.resource.delete({ where: { id: r.id } });
    return res.json({ removed: true, deactivated: false });
  }
  await prisma.resource.update({ where: { id: r.id }, data: { active: false } });
  res.json({
    removed: false,
    deactivated: true,
    reason: `Kept because ${r.name} appears in ${r._count.bookings} booking(s). `
      + 'Deactivated instead — it takes no new bookings.',
  });
});

// ---------------------------------------------------------------------------
// Purge — demo mode only
// ---------------------------------------------------------------------------

/** GET /api/admin/purge — what a purge would delete, without deleting it. */
adminRouter.get('/admin/purge', async (_req, res) => {
  const [bookings, users, notes] = await Promise.all([
    prisma.booking.count(),
    prisma.user.count(),
    prisma.visitNote.count(),
  ]);
  res.json({
    allowed: config.bookingMode === 'demo',
    mode: config.bookingMode,
    wouldDelete: { bookings, patients: users, visitNotes: notes },
  });
});

const PURGE_PHRASE = 'DELETE ALL BOOKINGS';

/**
 * POST /api/admin/purge — delete every booking, patient and clinical note.
 *
 * Two locks, because this is the most destructive operation in the system and
 * it is irreversible:
 *
 *   1. BOOKING_MODE must be "demo". Once the practice flips to beta or live
 *      this endpoint refuses outright — it cannot destroy real patient records
 *      even with a valid token, and no code change is needed to secure it.
 *   2. The exact phrase must be sent in the body, so a stray click or a
 *      replayed request cannot trigger it.
 *
 * Configuration (services, rooms, staff, shifts) is never touched.
 */
adminRouter.post('/admin/purge', async (req, res) => {
  if (config.bookingMode !== 'demo') {
    return res.status(403).json({
      error: `Refused: BOOKING_MODE is "${config.bookingMode}". Purging is only possible `
        + 'in demo mode, so real patient records cannot be destroyed from here.',
    });
  }

  const body = z.object({ confirm: z.string() }).strict().safeParse(req.body);
  if (!body.success || body.data.confirm !== PURGE_PHRASE) {
    return res.status(400).json({ error: `Send {"confirm":"${PURGE_PHRASE}"} to proceed.` });
  }

  const before = {
    bookings: await prisma.booking.count(),
    patients: await prisma.user.count(),
    visitNotes: await prisma.visitNote.count(),
  };

  // Order matters: VisitNote restricts deletion of its Booking and Staff, and
  // amendments reference the note they supersede, so break the chain first.
  await prisma.$transaction(async (tx) => {
    await tx.visitNote.updateMany({ data: { amendsId: null } });
    await tx.visitNote.deleteMany({});
    await tx.booking.deleteMany({});
    await tx.user.deleteMany({});
  });

  console.warn('[admin] PURGE executed — deleted', before);
  res.json({
    purged: true,
    deleted: before,
    kept: {
      services: await prisma.service.count(),
      resources: await prisma.resource.count(),
      staff: await prisma.staff.count(),
    },
  });
});

// ---------------------------------------------------------------------------
// Services — timings and pricing
// ---------------------------------------------------------------------------

adminRouter.get('/admin/services', async (_req, res) => {
  const services = await prisma.service.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: {
      options: { orderBy: { sortOrder: 'asc' } },
      rooms: { select: { resourceId: true } },
    },
  });
  // The picker needs every room, including inactive ones — a service may
  // legitimately still be linked to a room that is temporarily switched off.
  const resources = await prisma.resource.findMany({
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, type: true, active: true },
  });
  res.json({
    services: services.map((s) => ({
      ...s,
      rooms: undefined,
      roomIds: s.rooms.map((r) => r.resourceId),
    })),
    resources,
  });
});

const servicePatch = z.object({
  durationMin: z.number().int().min(5, 'Minimum 5 minutes.').max(480).optional(),
  bufferMin: z.number().int().min(0).max(240).optional(),
  priceCents: z.number().int().min(0).max(10_000_00).nullable().optional(),
  priceNote: z.string().trim().max(200).nullable().optional(),
  /// Rooms this service may be delivered in. Replaces the whole set.
  /// Not .uuid() — seeded ids are UUID-shaped but not valid hex
  /// ("re500u4c-…"), and existence is proven against the table below anyway.
  roomIds: z.array(z.string().min(1).max(64)).optional(),
}).strict();

adminRouter.patch('/admin/services/:id', async (req, res) => {
  const parsed = servicePatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });

  const existing = await prisma.service.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Unknown service.' });

  const { roomIds, ...fields } = parsed.data;

  // A service with no rooms cannot be booked at all, and the booking page can
  // only say "no availability" without explaining why. Refuse rather than let
  // the schedule go quietly empty.
  if (roomIds && roomIds.length === 0) {
    return res.status(400).json({
      error: `${existing.name} needs at least one room, or nobody can book it.`,
    });
  }
  if (roomIds) {
    const found = await prisma.resource.count({ where: { id: { in: roomIds } } });
    if (found !== roomIds.length) return res.status(400).json({ error: 'Unknown room.' });
  }

  const svc = await prisma.$transaction(async (tx) => {
    if (roomIds) {
      await tx.serviceRoom.deleteMany({ where: { serviceId: existing.id } });
      await tx.serviceRoom.createMany({
        data: roomIds.map((resourceId) => ({ serviceId: existing.id, resourceId })),
      });
    }
    return tx.service.update({ where: { id: existing.id }, data: fields });
  });

  // Changing a duration does not retime bookings already made at the old
  // length; say so rather than let the difference go unnoticed.
  let note: string | undefined;
  if (fields.durationMin != null && fields.durationMin !== existing.durationMin) {
    const affected = await prisma.booking.count({
      where: { serviceId: svc.id, status: { in: ['PENDING_REVIEW', 'CONFIRMED'] }, startTime: { gte: new Date() } },
    });
    if (affected > 0) {
      note = `${affected} upcoming booking(s) keep the old ${existing.durationMin}-minute length. `
        + 'Only new bookings use the new duration.';
    }
  }
  res.json({ service: svc, note });
});
