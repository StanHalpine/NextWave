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
      requiredRole: true,
      resourceType: true,
    },
  });
  res.json({ services });
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
