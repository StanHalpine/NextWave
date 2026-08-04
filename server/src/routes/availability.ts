import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { computeDayAvailability } from '../lib/availability.js';
import { clinicToday } from '../lib/time.js';
import { DateTime } from 'luxon';

export const availabilityRouter = Router();

const query = z.object({
  serviceId: z.string().uuid('serviceId must be a UUID.'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD.'),
});

/**
 * GET /api/config — public, non-sensitive deployment facts the booking page
 * needs before it can render honestly (chiefly: is this real?).
 */
availabilityRouter.get('/config', (req, res) => {
  // A correct ?preview= key lets staff through the coming-soon screen to the
  // real flow. It is a convenience, not a security control — the booking API
  // stays open either way, so this only changes what the page renders.
  const key = typeof req.query.preview === 'string' ? req.query.preview : '';
  const previewing = Boolean(config.previewKey) && key === config.previewKey;

  res.json({
    mode: previewing && config.bookingMode === 'coming_soon' ? 'demo' : config.bookingMode,
    previewing,
    openingWhen: config.openingWhen,
    timezone: config.clinicTimezone,
  });
});

/** GET /api/services — the picker on the booking page. */
availabilityRouter.get('/services', async (_req, res) => {
  const services = await prisma.service.findMany({
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      slug: true,
      name: true,
      category: true,
      durationMin: true,
      priceCents: true,
      priceNote: true,
      newPatientSlug: true,
      options: {
        select: { label: true, priceCents: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });
  res.json({ services });
});

const daysQuery = z.object({
  serviceId: z.string().uuid('serviceId must be a UUID.'),
  days: z.coerce.number().int().min(1).max(60).optional(),
});

/**
 * GET /api/availability/days?serviceId=…&days=14
 *
 * Which of the next N clinic-local days have ANY opening for this service.
 *
 * Exists so the day picker can grey out days nothing can be booked on. Before
 * this, the picker hard-coded Sunday as the only closed day, so a service with
 * no provider rostered on Friday still showed Friday as an ordinary, clickable
 * button — the calendar appeared to offer an appointment it would then refuse.
 */
availabilityRouter.get('/availability/days', async (req, res) => {
  const parsed = daysQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query.' });
  }
  const { serviceId } = parsed.data;
  const span = Math.min(parsed.data.days ?? 14, config.maxAdvanceDays);

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return res.status(404).json({ error: 'Unknown service.' });

  const today = clinicToday();
  const now = new Date();
  const out: Array<{ date: string; open: boolean; reason?: string }> = [];

  // Sequential rather than parallel: each day runs several queries, and a
  // burst of 14 concurrent transactions is a poor trade against a page that
  // renders a few hundred milliseconds sooner.
  for (let i = 0; i < span; i++) {
    const date = DateTime.fromISO(today).plus({ days: i }).toFormat('yyyy-MM-dd');
    const day = await computeDayAvailability(prisma, serviceId, date, now);
    out.push({
      date,
      open: Boolean(day && day.slots.length > 0),
      ...(day?.closedReason ? { reason: day.closedReason } : {}),
    });
  }

  res.json({ serviceId, days: out });
});

/**
 * GET /api/availability?serviceId=…&date=YYYY-MM-DD
 *
 * Open 15-minute starts for one service on one clinic-local day.
 */
availabilityRouter.get('/availability', async (req, res) => {
  const parsed = query.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query.' });
  }
  const { serviceId, date } = parsed.data;

  const today = clinicToday();
  if (date < today) {
    return res.status(400).json({ error: 'Cannot look up availability in the past.' });
  }
  const horizon = DateTime.fromISO(today).plus({ days: config.maxAdvanceDays }).toFormat('yyyy-MM-dd');
  if (date > horizon) {
    return res
      .status(400)
      .json({ error: `Bookings open ${config.maxAdvanceDays} days ahead (through ${horizon}).` });
  }

  const day = await computeDayAvailability(prisma, serviceId, date);
  if (!day) return res.status(404).json({ error: 'Unknown service.' });

  res.json(day);
});
