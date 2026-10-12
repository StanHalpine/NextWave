/**
 * Front Desk module: today's dashboard, the check-in / check-out workflow, and walk-ins.
 *
 * The dashboard's three columns come from the Encounter table (lib/encounters.ts):
 *   Today's appointments  → confirmed, no encounter yet (or still SCHEDULED)
 *   Checked in            → CHECKED_IN, IN_PROGRESS
 *   Seen / checked out    → SEEN, CHECKED_OUT   (SEEN = the provider signed; the visit is NOT finished until it is checked out)
 * No-shows are listed apart so they neither clutter nor vanish from the day.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { computeDayAvailability } from '../lib/availability.js';
import { now } from '../lib/clock.js';
import { localDayBounds, toLocalDateISO } from '../lib/time.js';
import { config } from '../config.js';
import { staffTransaction } from '../lib/staffTx.js';
import { APPT_INCLUDE, appointmentView } from '../lib/appointmentView.js';
import { checkIn, markNoShow, undoCheckIn } from '../lib/encounters.js';
import { checkoutPreview, checkoutVisit } from '../lib/checkout.js';
import { basePrisma } from '../lib/prismaBase.js';
import { SchedulingError, createWalkIn, walkInSlotStart } from '../lib/scheduling.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { sendSchedulingError } from './http.js';

export const fdRouter = Router();

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

// ---- dashboard ---------------------------------------------------------------

fdRouter.get('/fd/dashboard', requireFrontDesk, async (req, res) => {
  const t = now();
  const today = toLocalDateISO(t);
  const dateParam = typeof req.query.date === 'string' ? isoDay.safeParse(req.query.date) : null;
  if (dateParam && !dateParam.success) return res.status(400).json({ error: 'date must be YYYY-MM-DD.', code: 'bad_request' });
  const date = dateParam?.data ?? today;
  const { dayStart, dayEnd } = localDayBounds(date);

  const rows = await prisma.booking.findMany({
    where: { startTime: { gte: dayStart, lt: dayEnd }, status: { in: ['PENDING_REVIEW', 'CONFIRMED'] } },
    include: APPT_INCLUDE,
    orderBy: { startTime: 'asc' },
  });

  const scheduled: ReturnType<typeof appointmentView>[] = [];
  const checkedIn: ReturnType<typeof appointmentView>[] = [];
  const done: ReturnType<typeof appointmentView>[] = [];
  const noShows: ReturnType<typeof appointmentView>[] = [];
  let pendingReview = 0;
  for (const b of rows) {
    if (b.status === 'PENDING_REVIEW') { pendingReview++; continue; } // not an appointment yet
    const v = appointmentView(b);
    switch (b.encounter?.status) {
      case 'CHECKED_IN': case 'IN_PROGRESS': checkedIn.push(v); break;
      case 'SEEN': case 'CHECKED_OUT': done.push(v); break;
      case 'NO_SHOW': noShows.push(v); break;
      default: scheduled.push(v);
    }
  }
  // Longest-waiting first is what the desk needs for the checked-in column.
  checkedIn.sort((a, b) => (a.encounter?.checkedInAt?.getTime() ?? 0) - (b.encounter?.checkedInAt?.getTime() ?? 0));
  // A SEEN visit still has to be checked out (nothing is recorded until it is): those lead the finished column, and stay in time order.
  const unpaid = (v: ReturnType<typeof appointmentView>) => (v.encounter?.status === 'SEEN' ? 0 : 1);
  done.sort((a, b) => unpaid(a) - unpaid(b));            // stable: the rows arrived in start-time order

  audit.read('appointment', null, { count: rows.length, scope: 'front_desk_dashboard' }, `dashboard:${date}`);
  res.json({
    date, today, isToday: date === today, timezone: config.clinicTimezone, now: t.toISOString(),
    pendingReview,
    scheduled, checkedIn, done, noShows,
  });
});

// ---- visit actions -----------------------------------------------------------

type Action = typeof checkIn | typeof undoCheckIn | typeof markNoShow;

function visitAction(path: string, run: (tx: Parameters<Action>[0], rec: Parameters<Action>[1], a: { bookingId: string; accountId: string; now: Date }) => Promise<unknown>) {
  fdRouter.post(`/fd/appointments/:id/${path}`, requireFrontDesk, async (req, res) => {
    const bookingId = req.params.id ?? '';
    try {
      await staffTransaction((tx, rec) => run(tx, rec, { bookingId, accountId: req.auth!.account.id, now: now() }));
      const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: APPT_INCLUDE });
      res.json({ appointment: appointmentView(row) });
    } catch (err) {
      if (!sendSchedulingError(res, err)) throw err;
    }
  });
}

visitAction('check-in', (tx, rec, a) => checkIn(tx, rec, a));
visitAction('undo-check-in', (tx, rec, a) => undoCheckIn(tx, rec, a));
// Check-out is no longer a bare state change: it settles the visit (credits, a perk, or cash),
// records the revenue event, and checks the patient out in one transaction. See lib/checkout.ts.
visitAction('no-show', (tx, rec, a) => markNoShow(tx, rec, a));

// ---- walk-ins ----------------------------------------------------------------

const walkInBody = z.object({
  patientId: z.string().min(1).max(64),
  serviceId: z.string().min(1).max(64),
  subOption: z.string().trim().min(1).max(120).optional(),
  staffId: z.string().min(1).max(64).optional(),
}).strict();

/** The next few bookable starts today, for the "not free right now — here is when" answer. */
async function nextAvailable(serviceId: string, from: Date, limit = 3): Promise<string[]> {
  const day = await computeDayAvailability(prisma, serviceId, toLocalDateISO(from), from);
  return (day?.slots ?? []).slice(0, limit).map((s) => s.start);
}

fdRouter.post('/fd/walk-ins', requireFrontDesk, async (req, res) => {
  const parsed = walkInBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid walk-in.', code: 'bad_request' });
  const b = parsed.data;
  const t = now();

  try {
    const id = await staffTransaction(async (tx, rec) => {
      const patient = await tx.patient.findFirst({ where: { id: b.patientId, deletedAt: null } });
      if (!patient) throw Object.assign(new Error('patient'), { notFound: true });
      const { booking } = await createWalkIn(tx, rec, {
        serviceId: b.serviceId, now: t, subOption: b.subOption, staffId: b.staffId,
        createdByAccountId: req.auth!.account.id,
        patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone, email: patient.email },
      });
      return booking.id;
    });
    const row = await prisma.booking.findUniqueOrThrow({ where: { id }, include: APPT_INCLUDE });
    res.status(201).json({ appointment: appointmentView(row) });
  } catch (err) {
    if ((err as { notFound?: boolean }).notFound) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
    if (err instanceof SchedulingError && err.status === 409) {
      // Nothing was written (the transaction rolled back). Offer the next openings instead of a dead end.
      const next = await nextAvailable(b.serviceId, t);
      return res.status(409).json({
        error: err.code === 'slot_unavailable' ? 'No room or provider is free for this service right now.' : err.message,
        code: err.code,
        slotStart: walkInSlotStart(t).toISOString(),
        nextAvailable: next,
      });
    }
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- check-out: settle the visit ----------------------------------------------------------------

const checkoutBody = z.discriminatedUnion('payment', [
  z.object({ payment: z.literal('CREDITS') }).strict(),
  z.object({ payment: z.literal('PERK'), perkId: z.string().min(1).max(64) }).strict(),
  z.object({ payment: z.literal('CASH'), priceCents: z.number().int().positive().max(100_000_00).optional(), expectedNetCents: z.number().int().min(0).max(100_000_00).optional() }).strict(),
]);

/** What the check-out screen shows: price, balance before and after, and every way this visit can be paid. */
fdRouter.get('/fd/appointments/:id/checkout-preview', requireFrontDesk, async (req, res) => {
  const id = req.params.id ?? '';
  const preview = await checkoutPreview(basePrisma as never, id, now());
  if (!preview) return res.status(404).json({ error: 'Unknown appointment.', code: 'not_found' });
  audit.read('appointment', id, { section: 'checkout' });
  if (preview.patient) audit.read('credit_ledger', preview.patient.id, { section: 'checkout' });
  res.json({ preview });
});

fdRouter.post('/fd/appointments/:id/check-out', requireFrontDesk, async (req, res) => {
  const bookingId = req.params.id ?? '';
  const parsed = checkoutBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose how this visit was paid: credits, a perk, or cash.', code: 'bad_request' });
  try {
    const checkout = await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId, accountId: req.auth!.account.id, now: now(), ...parsed.data }));
    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: APPT_INCLUDE });
    res.json({ appointment: appointmentView(row), checkout });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});
