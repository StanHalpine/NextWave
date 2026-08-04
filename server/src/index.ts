import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { availabilityRouter } from './routes/availability.js';
import { holdsRouter } from './routes/holds.js';
import { bookingsRouter } from './routes/bookings.js';
import { frontDeskRouter } from './routes/frontDesk.js';
import { notesRouter } from './routes/notes.js';
import { demoGate } from './middleware/demoGate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

// Whole-app Basic Auth while this is a shared demo. No-ops when DEMO_USER /
// DEMO_PASSWORD are unset, so local development is unaffected.
app.use(demoGate);

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, timezone: config.clinicTimezone });
  } catch {
    res.status(503).json({ ok: false, error: 'Database unreachable.' });
  }
});

app.use('/api', availabilityRouter);
app.use('/api', holdsRouter);
app.use('/api', bookingsRouter);
app.use('/api', frontDeskRouter);
app.use('/api', notesRouter);

// Dashboard + booking widget assets.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

/**
 * Housekeeping only. Expiry is decided by `holdExpiresAt`, never by this sweep
 * — an expired hold stops blocking the moment its timestamp passes, whether or
 * not this has run. It exists to stop abandoned holds and their placeholder
 * users accumulating.
 */
async function sweepExpiredHolds() {
  try {
    const stale = await prisma.booking.findMany({
      where: { status: 'HOLD', holdExpiresAt: { lte: new Date() } },
      select: { id: true, userId: true },
    });
    if (stale.length === 0) return;

    await prisma.booking.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    await prisma.user.deleteMany({
      where: { id: { in: stale.map((s) => s.userId) }, email: '', bookings: { none: {} } },
    });
    console.log(`[sweep] removed ${stale.length} expired hold(s)`);
  } catch (err) {
    console.error('[sweep] failed', err);
  }
}

const server = app.listen(config.port, () => {
  console.log(`NextWave scheduling API  →  http://localhost:${config.port}`);
  console.log(`Front desk dashboard     →  http://localhost:${config.port}/dashboard.html`);
  console.log(`Clinic timezone          →  ${config.clinicTimezone}`);
});

const sweeper = setInterval(sweepExpiredHolds, 60_000);
sweepExpiredHolds();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(sweeper);
    server.close(() => prisma.$disconnect().then(() => process.exit(0)));
  });
}
