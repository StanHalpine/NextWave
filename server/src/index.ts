import 'express-async-errors'; // forwards rejected async handlers to the error handler below
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { runAsSystem } from './lib/audit.js';
import { availabilityRouter } from './routes/availability.js';
import { holdsRouter } from './routes/holds.js';
import { bookingsRouter } from './routes/bookings.js';
import { frontDeskRouter } from './routes/frontDesk.js';
import { notesRouter } from './routes/notes.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { adminAccountsRouter } from './routes/adminAccounts.js';
import { patientsRouter } from './routes/patients.js';
import { scheduleRouter } from './routes/schedule.js';
import { fdRouter } from './routes/fd.js';
import { smsPublicRouter } from './routes/smsPublic.js';
import { creditsRouter } from './routes/credits.js';
import { membershipAdminRouter } from './routes/membershipAdmin.js';
import { smsInboundRouter } from './routes/smsInbound.js';
import { startInProcessScheduler } from './jobs/scheduler.js';
import { demoGate } from './middleware/demoGate.js';
import { requestContext } from './middleware/requestContext.js';
import { loadSession } from './middleware/session.js';
import { auditAccess } from './middleware/auditAccess.js';
import { loadIntegrations } from './integrations/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/**
 * Last resort for anything that escapes a handler. Node's DEFAULT behaviour is to
 * print the error — message included — to stderr, and for a Prisma error that
 * message contains the failing query's arguments, i.e. patient data. So even a
 * crash goes through the sanitiser.
 */
process.on('unhandledRejection', (reason) => logger.error('unhandled_rejection', reason));
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', err);
  process.exit(1);
});

export function buildApp() {
  const app = express();

  // Behind Render's / a load balancer's proxy, req.ip is the client only if told so.
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(requestContext);
  // The cross-origin surface is the PUBLIC, cookie-less booking API. Credentials
  // are not enabled, so a foreign site can never ride a staff session.
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  app.use(cookieParser());
  app.use(express.json({ limit: '64kb' }));

  // The old shared Basic Auth curtain. Retired by default; the flag exists so it
  // can be switched back on during cutover. Individual logins apply either way.
  if (config.basicAuthGate) app.use(demoGate);

  app.use(loadSession);

  // Nothing under /api may be cached by a browser or intermediary: responses
  // carry schedules, contact details and clinical notes.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, timezone: config.clinicTimezone });
    } catch {
      res.status(503).json({ ok: false, error: 'Database unreachable.' });
    }
  });

  // ── Route-level access audit ────────────────────────────────────────────────
  // Mounted here so the handlers they cover — including the booking and hold
  // routes, which must not be edited — stay untouched. See middleware/auditAccess.ts:
  // reads and refused attempts are recorded here; successful writes are recorded
  // by the Prisma extension, with the row id.
  const idParam = (req: Request) => req.params.id ?? null;
  // Booking / hold paths (the four routes with hand-written FOR UPDATE locking):
  app.post('/api/holds', auditAccess('appointment'));
  app.get('/api/holds/:id', auditAccess('appointment', { id: idParam }));
  app.delete('/api/holds/:id', auditAccess('appointment', { id: idParam }));
  app.post('/api/bookings', auditAccess('appointment'));
  app.get('/api/bookings/:id', auditAccess('appointment', { id: idParam }));
  app.patch('/api/bookings/:id', auditAccess('appointment', { id: idParam }));
  // Staff views that disclose patient data:
  app.get('/api/front-desk/schedule', auditAccess('appointment', { listKey: 'schedule' }));
  app.get('/api/front-desk/pending', auditAccess('appointment', { listKey: 'pending' }));
  app.get('/api/bookings/:id/notes', auditAccess('visit_note', { id: idParam, meta: () => ({ scope: 'booking' }) }));
  app.get('/api/patients/:id/history', auditAccess('booking_contact', { id: idParam }));
  app.post('/api/patients/search', auditAccess('booking_contact', { read: true, everyTime: true }));

  app.use('/api', authRouter);
  app.use('/api', adminAccountsRouter);
  app.use('/api', availabilityRouter);
  app.use('/api', smsPublicRouter);  // consent label + the booking widget's consent checkbox
  app.use('/api', smsInboundRouter); // the messaging provider's STOP / HELP / C webhook (signed)
  app.use('/api', holdsRouter);
  app.use('/api', bookingsRouter);
  app.use('/api', frontDeskRouter);
  app.use('/api', notesRouter);
  app.use('/api', adminRouter);
  // Phase 2: patients, schedule, front-desk workflow. Each handler audits its own reads
  // and (through staffTransaction) its writes — they are NOT covered by the legacy
  // auditAccess mounts above.
  app.use('/api', patientsRouter);
  app.use('/api', scheduleRouter);
  app.use('/api', fdRouter);
  app.use('/api', creditsRouter);
  app.use('/api', membershipAdminRouter);

  // The staff app (React + Vite), built to public/app. index.html must never be
  // cached so a deploy takes effect at once; its hashed assets can be.
  const staffApp = path.join(publicDir, 'app');
  app.use('/app/assets', express.static(path.join(staffApp, 'assets'), { immutable: true, maxAge: '1y' }));
  app.get(['/app', '/app/*'], (_req, res) => {
    const index = path.join(staffApp, 'index.html');
    if (!existsSync(index)) {
      return res.status(503).type('text').send('The staff app has not been built. Run: npm run web:build');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(index);
  });

  // Public booking widget + the legacy staff pages (dashboard.html, admin.html).
  app.use(express.static(publicDir));

  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Error handler. Returns a request reference, never the error text.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    if (type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
    logger.error('unhandled_request_error', err, { method: req.method });
    if (res.headersSent) return;
    res.status(500).json({ error: 'Something went wrong.', requestId: req.requestId });
  });

  return app;
}

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
    logger.info('sweep_removed_expired_holds', { count: stale.length });
  } catch (err) {
    logger.error('sweep_failed', err);
  }
}

async function main() {
  await loadIntegrations();
  const app = buildApp();

  const server = app.listen(config.port, () => {
    logger.info('server_listening', {
      port: config.port,
      timezone: config.clinicTimezone,
      basicAuthGate: config.basicAuthGate,
      jobsInProcess: config.jobsInProcess,
      production: config.isProduction,
    });
  });

  // Runs as a named system actor so the audit rows for deleted holds say so.
  const sweep = () => runAsSystem('hold-sweeper', sweepExpiredHolds);
  const sweeper = setInterval(sweep, 60_000);
  void sweep();

  const stopJobs = config.jobsInProcess ? startInProcessScheduler() : () => undefined;

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(sweeper);
      stopJobs();
      server.close(() => prisma.$disconnect().then(() => process.exit(0)));
    });
  }
}

// Not `import.meta.main`: tests import buildApp() and must not start a listener.
if (process.env.NW_NO_LISTEN !== '1') {
  main().catch((err) => {
    logger.error('startup_failed', err);
    process.exit(1);
  });
}

