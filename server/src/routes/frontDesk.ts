import { Router } from 'express';
import { z } from 'zod';
import { config, CLINIC_HOURS } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { isoWeekday, localDayBounds, toLocalHHMM } from '../lib/time.js';

export const frontDeskRouter = Router();

const dayQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD.'),
});

/**
 * GET /api/front-desk/schedule?date=YYYY-MM-DD
 *
 * Everything the master grid needs in one round trip: the room columns, the
 * day's bookings, and the open clinic window to draw rows for.
 */
frontDeskRouter.get('/front-desk/schedule', requireFrontDesk, async (req, res) => {
  const parsed = dayQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query.' });
  }
  const { date } = parsed.data;
  const { dayStart, dayEnd } = localDayBounds(date);
  const hours = CLINIC_HOURS[isoWeekday(date)] ?? null;

  const [resources, bookings] = await Promise.all([
    prisma.resource.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
    prisma.booking.findMany({
      where: {
        startTime: { lt: dayEnd, gte: dayStart },
        // Expired holds are noise on the grid — they reserve nothing.
        NOT: { status: 'HOLD', holdExpiresAt: { lte: new Date() } },
      },
      include: {
        service: { select: { name: true, category: true, bufferMin: true } },
        _count: { select: { visitNotes: true } },
        resource: { select: { name: true } },
        staff: { select: { name: true } },
        user: { select: { name: true, email: true, phone: true } },
      },
      orderBy: { startTime: 'asc' },
    }),
  ]);

  res.json({
    date,
    timezone: config.clinicTimezone,
    slotGranularityMin: config.slotGranularityMin,
    open: hours?.open ?? null,
    close: hours?.close ?? null,
    closed: hours === null,
    resources: resources.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      maxCapacity: r.maxCapacity,
    })),
    bookings: bookings.map((b) => ({
      id: b.id,
      status: b.status,
      resourceId: b.resourceId,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      localStart: toLocalHHMM(b.startTime),
      localEnd: toLocalHHMM(b.endTime),
      bufferMin: b.service.bufferMin,
      service: b.service.name,
      category: b.service.category,
      subOption: b.subOption,
      patientNote: b.patientNote,
      noteCount: b._count.visitNotes,
      staff: b.staff?.name ?? null,
      patient: b.user.name,
      email: b.user.email,
      phone: b.user.phone,
      isRecurring: b.isRecurring,
      holdExpiresAt: b.holdExpiresAt?.toISOString() ?? null,
    })),
  });
});

/**
 * GET /api/front-desk/staff — author picker for clinical notes.
 *
 * Stopgap: with no staff logins, the dashboard has to *claim* an author rather
 * than prove one. Once real accounts exist, VisitNote.authorId should come
 * from the session and this list becomes display-only. See spec §7.5.
 */
frontDeskRouter.get('/front-desk/staff', requireFrontDesk, async (_req, res) => {
  const staff = await prisma.staff.findMany({
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, role: true },
  });
  res.json({ staff });
});

/** GET /api/front-desk/pending — the review queue, newest request first. */
frontDeskRouter.get('/front-desk/pending', requireFrontDesk, async (_req, res) => {
  const pending = await prisma.booking.findMany({
    where: { status: 'PENDING_REVIEW' },
    include: {
      service: { select: { name: true, category: true } },
      resource: { select: { name: true } },
      staff: { select: { name: true } },
      user: { select: { name: true, email: true, phone: true } },
    },
    orderBy: { startTime: 'asc' },
  });

  res.json({
    count: pending.length,
    bookings: pending.map((b) => ({
      id: b.id,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      localStart: toLocalHHMM(b.startTime),
      service: b.service.name,
      category: b.service.category,
      subOption: b.subOption,
      resource: b.resource.name,
      staff: b.staff?.name ?? null,
      patient: b.user.name,
      email: b.user.email,
      phone: b.user.phone,
      isRecurring: b.isRecurring,
      requestedAt: b.createdAt.toISOString(),
    })),
  });
});
