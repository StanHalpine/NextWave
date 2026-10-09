/**
 * Schedule module (front desk + admin): the calendar, and creating / moving /
 * cancelling appointments.
 *
 * Creating and moving go through lib/scheduling.ts, which re-proves the slot under the
 * same row locks the booking engine uses. The public availability endpoint is reused
 * as-is for the slot picker. Approving or declining a patient's online REQUEST uses the
 * existing PATCH /api/bookings/:id, which this module does not replace.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { CLINIC_HOURS, config } from '../config.js';
import { now } from '../lib/clock.js';
import { isoWeekday, localDayBounds, toLocalDateISO } from '../lib/time.js';
import { staffTransaction } from '../lib/staffTx.js';
import { APPT_INCLUDE, appointmentView } from '../lib/appointmentView.js';
import { CANCEL_REASONS, cancelAppointment, createAppointment, moveAppointment, slotsForDay } from '../lib/scheduling.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { sendSchedulingError } from './http.js';

export const scheduleRouter = Router();

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const MAX_RANGE_DAYS = 14;

const calendarQuery = z.object({
  from: isoDay,
  to: isoDay,
  includeCancelled: z.enum(['true', 'false']).optional(),
});

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T12:00:00Z`);
  for (let d = new Date(`${from}T12:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
}

// ---- calendar --------------------------------------------------------------

scheduleRouter.get('/schedule/calendar', requireFrontDesk, async (req, res) => {
  const q = calendarQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD).', code: 'bad_request' });
  const { from, to } = q.data;
  const dates = daysBetween(from, to);
  if (dates.length < 1 || dates.length > MAX_RANGE_DAYS) {
    return res.status(400).json({ error: `Ask for between 1 and ${MAX_RANGE_DAYS} days.`, code: 'bad_range' });
  }
  const t = now();

  const statuses = q.data.includeCancelled === 'true'
    ? (['HOLD', 'PENDING_REVIEW', 'CONFIRMED', 'CANCELLED'] as const)
    : (['HOLD', 'PENDING_REVIEW', 'CONFIRMED'] as const);

  const [rows, staff, rooms] = await Promise.all([
    prisma.booking.findMany({
      where: {
        startTime: { gte: localDayBounds(from).dayStart, lt: localDayBounds(to).dayEnd },
        status: { in: [...statuses] },
        // An expired hold reserves nothing and is only noise on a calendar.
        NOT: { status: 'HOLD', holdExpiresAt: { lte: t } },
      },
      include: APPT_INCLUDE,
      orderBy: { startTime: 'asc' },
    }),
    // Providers = active staff someone can be booked with, with their shifts.
    prisma.staff.findMany({
      where: { active: true, services: { some: {} } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, role: true, schedules: { select: { dayOfWeek: true, startTime: true, endTime: true } } },
    }),
    prisma.resource.findMany({ where: { active: true }, orderBy: [{ type: 'asc' }, { name: 'asc' }], select: { id: true, name: true, type: true } }),
  ]);

  audit.read('appointment', null, { count: rows.length, scope: 'calendar' }, `calendar:${from}:${to}`);
  res.json({
    timezone: config.clinicTimezone,
    today: toLocalDateISO(t),
    days: dates.map((date) => {
      const hours = CLINIC_HOURS[isoWeekday(date)] ?? null;
      return { date, open: hours?.open ?? null, close: hours?.close ?? null, closed: hours === null };
    }),
    staff: staff.map((s) => ({
      id: s.id, name: s.name, role: s.role,
      shifts: Object.fromEntries(dates.map((date) => [
        date,
        s.schedules.filter((x) => x.dayOfWeek === isoWeekday(date)).map((x) => ({ start: x.startTime, end: x.endTime })),
      ])),
    })),
    rooms,
    appointments: rows.map(appointmentView),
  });
});

// ---- open slots (for the pickers) ---------------------------------------------------

const slotsQuery = z.object({
  serviceId: z.string().min(1).max(64),
  date: isoDay,
  /** Moving: treat this appointment as not there, so its own time and neighbours are offered. */
  forAppointmentId: z.string().min(1).max(64).optional(),
});

/**
 * Which starts are bookable. Returns availability only — no names — and which providers
 * could take each start, so the desk can choose one. Uses the app clock, so a slot that
 * has already begun is never offered.
 */
scheduleRouter.get('/schedule/slots', requireFrontDesk, async (req, res) => {
  const q = slotsQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'serviceId and date (YYYY-MM-DD) are required.', code: 'bad_request' });
  try {
    const day = await slotsForDay(q.data.serviceId, q.data.date, now(), q.data.forAppointmentId);
    if (!day) return res.status(404).json({ error: 'Unknown service.', code: 'unknown_service' });
    audit.read('appointment', null, { scope: 'slots' }, 'slots');
    res.json({
      date: day.date, durationMin: day.durationMin, closedReason: day.closedReason ?? null,
      slots: day.slots.map((s) => ({ start: s.start, localTime: s.localTime, staffIds: s.staffIds, resourceIds: s.resourceIds })),
    });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- one appointment ---------------------------------------------------------

scheduleRouter.get('/schedule/appointments/:id', requireFrontDesk, async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.id },
    include: { ...APPT_INCLUDE, user: { select: { name: true, phone: true, email: true } }, messages: { orderBy: { queuedAt: 'desc' } } },
  });
  if (!b) return res.status(404).json({ error: 'Unknown appointment.', code: 'not_found' });
  audit.read('appointment', b.id);
  res.json({
    appointment: appointmentView(b),
    // The contact the booking was made under — useful when no patient is linked yet.
    contact: { name: b.user.name, phone: b.user.phone, email: b.user.email },
    patientNote: b.patientNote,
    // Delivery status of texts only. Never the number, never the message.
    messages: b.messages.map((m) => ({ kind: m.kind, status: m.status, forStart: m.forStart, sentAt: m.sentAt, failureCode: m.failureCode })),
  });
});

// ---- create ------------------------------------------------------------------

const createBody = z.object({
  serviceId: z.string().min(1).max(64),
  start: z.string().datetime({ offset: true }),
  patientId: z.string().min(1).max(64),
  subOption: z.string().trim().min(1).max(120).optional(),
  staffId: z.string().min(1).max(64).optional(),
  source: z.enum(['PHONE', 'FRONT_DESK']).default('PHONE'),
}).strict();

scheduleRouter.post('/schedule/appointments', requireFrontDesk, async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid appointment.', code: 'bad_request' });
  const b = parsed.data;

  try {
    const id = await staffTransaction(async (tx, rec) => {
      const patient = await tx.patient.findFirst({ where: { id: b.patientId, deletedAt: null } });
      if (!patient) throw Object.assign(new Error('patient'), { notFound: true });
      const { booking } = await createAppointment(tx, rec, {
        serviceId: b.serviceId, start: new Date(b.start), now: now(),
        staffId: b.staffId, subOption: b.subOption, source: b.source,
        createdByAccountId: req.auth!.account.id,
        patient: { id: patient.id, firstName: patient.firstName, lastName: patient.lastName, phone: patient.phone, email: patient.email },
      });
      return booking.id;
    });
    const row = await prisma.booking.findUniqueOrThrow({ where: { id }, include: APPT_INCLUDE });
    res.status(201).json({ appointment: appointmentView(row) });
  } catch (err) {
    if ((err as { notFound?: boolean }).notFound) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- move --------------------------------------------------------------------

const moveBody = z.object({
  start: z.string().datetime({ offset: true }),
  staffId: z.string().min(1).max(64).optional(),
  resourceId: z.string().min(1).max(64).optional(),
}).strict();

scheduleRouter.post('/schedule/appointments/:id/move', requireFrontDesk, async (req, res) => {
  const id = req.params.id ?? '';
  const parsed = moveBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a new start time.', code: 'bad_request' });
  try {
    await staffTransaction((tx, rec) =>
      moveAppointment(tx, rec, { bookingId: id, start: new Date(parsed.data.start), now: now(), staffId: parsed.data.staffId, resourceId: parsed.data.resourceId }));
    const row = await prisma.booking.findUniqueOrThrow({ where: { id }, include: APPT_INCLUDE });
    res.json({ appointment: appointmentView(row) });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- cancel ------------------------------------------------------------------

const cancelBody = z.object({ reason: z.enum(CANCEL_REASONS) }).strict();

scheduleRouter.post('/schedule/appointments/:id/cancel', requireFrontDesk, async (req, res) => {
  const id = req.params.id ?? '';
  const parsed = cancelBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a reason.', code: 'bad_request', reasons: CANCEL_REASONS });
  try {
    await staffTransaction((tx, rec) => cancelAppointment(tx, rec, { bookingId: id, reason: parsed.data.reason }));
    const row = await prisma.booking.findUniqueOrThrow({ where: { id }, include: APPT_INCLUDE });
    res.json({ appointment: appointmentView(row) });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});
