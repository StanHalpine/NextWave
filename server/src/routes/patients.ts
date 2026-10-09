/**
 * Patient management (front desk + admin).
 *
 * There is no patient login: patients are records the front desk keeps. Every route
 * here either returns or changes personal data, so every one writes an audit row.
 * Writes go through staffTransaction() so the audit row commits atomically with the
 * change; reads call audit.read() explicitly.
 *
 * Search is POST. A name, phone number or birth date in a URL ends up in access logs,
 * proxy logs and browser history; a request body does not.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { staffTransaction } from '../lib/staffTx.js';
import { phoneDigits } from '../lib/phone.js';
import { patientFields, patientSummary, patientView, searchWhere, toPatientData } from '../lib/patients.js';
import { requireRole } from '../middleware/session.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';

export const patientsRouter = Router();

const PAGE = 25;

// ---- directory search --------------------------------------------------------

const searchBody = z.object({
  q: z.string().trim().max(100).default(''),
  page: z.number().int().min(0).max(1000).default(0),
}).strict();

patientsRouter.post('/fd/patients/search', requireFrontDesk, async (req, res) => {
  const parsed = searchBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid search.', code: 'bad_request' });
  const { q, page } = parsed.data;

  const rows = await prisma.patient.findMany({
    where: searchWhere(q),
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
    skip: page * PAGE,
    take: PAGE + 1,
  });
  // Every search is its own disclosure (a different person each time), so none is
  // deduplicated. The search TERM is never recorded — only that a search happened.
  audit.record({ action: 'READ', resourceType: 'patient', meta: { search: true, resultCount: Math.min(rows.length, PAGE) } });
  res.json({ patients: rows.slice(0, PAGE).map(patientSummary), page, hasMore: rows.length > PAGE });
});

// ---- create -----------------------------------------------------------------

const createBody = patientFields.extend({ confirmNotDuplicate: z.boolean().optional() });

patientsRouter.post('/fd/patients', requireFrontDesk, async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid patient.', code: 'bad_request' });
  const { confirmNotDuplicate, ...input } = parsed.data;
  const digits = phoneDigits(input.phone);

  if (!confirmNotDuplicate) {
    // Same phone AND same last name, or same email. Warn, never block: two people
    // can share a phone (a household) and a real duplicate costs less than a refusal.
    const dupes = await prisma.patient.findMany({
      where: {
        deletedAt: null,
        OR: [
          { phoneDigits: digits, lastName: { equals: input.lastName, mode: 'insensitive' } },
          ...(input.email ? [{ email: { equals: input.email, mode: 'insensitive' as const } }] : []),
        ],
      },
      take: 5,
    });
    if (dupes.length) {
      return res.status(409).json({
        error: 'This may be a patient who is already on file.',
        code: 'possible_duplicate',
        matches: dupes.map(patientSummary),
      });
    }
  }

  const account = req.auth!.account;
  const created = await staffTransaction(async (tx, rec) => {
    const p = await tx.patient.create({
      data: { ...(toPatientData(input) as object), createdById: account.id } as never,
    });
    await rec({ action: 'CREATE', resourceType: 'patient', resourceId: p.id, meta: { fields: Object.keys(input) } });
    return p;
  });
  res.status(201).json({ patient: patientView(created) });
});

// ---- read / update / soft-delete ----------------------------------------------

patientsRouter.get('/fd/patients/:id', requireFrontDesk, async (req, res) => {
  const p = await prisma.patient.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!p) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
  audit.read('patient', p.id);
  res.json({ patient: patientView(p) });
});

patientsRouter.patch('/fd/patients/:id', requireFrontDesk, async (req, res) => {
  const parsed = patientFields.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid patient.', code: 'bad_request' });
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to change.', code: 'bad_request' });

  const updated = await staffTransaction(async (tx, rec) => {
    const existing = await tx.patient.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) return null;
    const p = await tx.patient.update({ where: { id: existing.id }, data: toPatientData(parsed.data) });
    await rec({ action: 'UPDATE', resourceType: 'patient', resourceId: p.id, meta: { fields } });
    return p;
  });
  if (!updated) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
  res.json({ patient: patientView(updated) });
});

patientsRouter.delete('/fd/patients/:id', requireRole('ADMIN'), async (req, res) => {
  const result = await staffTransaction(async (tx, rec) => {
    const p = await tx.patient.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!p) return { status: 404 as const };
    const upcoming = await tx.booking.count({
      where: { patientId: p.id, status: { in: ['CONFIRMED', 'PENDING_REVIEW'] }, startTime: { gte: new Date() } },
    });
    if (upcoming > 0) return { status: 409 as const, upcoming };
    // Soft delete: the record, its history and its audit trail all remain.
    await tx.patient.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    await rec({ action: 'DELETE', resourceType: 'patient', resourceId: p.id, meta: { soft: true } });
    return { status: 200 as const };
  });
  if (result.status === 404) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
  if (result.status === 409) {
    return res.status(409).json({ error: `This patient has ${result.upcoming} upcoming appointment(s). Cancel them first.`, code: 'has_upcoming' });
  }
  res.json({ ok: true });
});

// ---- visits ----------------------------------------------------------------

patientsRouter.get('/fd/patients/:id/visits', requireFrontDesk, async (req, res) => {
  const p = await prisma.patient.findFirst({ where: { id: req.params.id, deletedAt: null }, select: { id: true } });
  if (!p) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });

  const rows = await prisma.booking.findMany({
    where: { patientId: p.id, status: { in: ['CONFIRMED', 'PENDING_REVIEW', 'CANCELLED'] } },
    orderBy: { startTime: 'desc' },
    take: 100,
    include: {
      service: { select: { name: true, color: true } },
      staff: { select: { name: true } },
      encounter: { select: { status: true } },
    },
  });
  audit.read('patient', p.id, { section: 'visits' });
  res.json({
    visits: rows.map((b) => ({
      id: b.id, status: b.status, start: b.startTime.toISOString(), end: b.endTime.toISOString(),
      service: b.service.name, subOption: b.subOption, provider: b.staff?.name ?? null,
      source: b.source, encounterStatus: b.encounter?.status ?? null,
    })),
  });
});

// ---- SMS consent -------------------------------------------------------------

const consentBody = z.object({
  optIn: z.boolean(),
  /** How the patient gave (or withdrew) consent. Kept in the append-only audit trail as the record. */
  source: z.enum(['verbal', 'written', 'online', 'other']),
}).strict();

/**
 * Record that a patient agreed to — or withdrew from — appointment texts. Its own
 * endpoint, not a field on PATCH, so it cannot be flipped by accident while editing
 * an address. The anonymous widget has no consent checkbox, so a text is only ever
 * sent to a patient whose consent a person recorded here.
 */
patientsRouter.post('/fd/patients/:id/sms-consent', requireFrontDesk, async (req, res) => {
  const parsed = consentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Say whether the patient opts in and how it was obtained.', code: 'bad_request' });
  const { optIn, source } = parsed.data;

  const result = await staffTransaction(async (tx, rec) => {
    const p = await tx.patient.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!p) return { status: 404 as const };
    if (p.smsOptIn === optIn) return { status: 200 as const, patient: p };
    const updated = await tx.patient.update({
      where: { id: p.id },
      data: optIn
        ? { smsOptIn: true, smsOptInAt: new Date(), smsConsentRecordedById: req.auth!.account.id }
        : { smsOptIn: false, smsOptInAt: null, smsConsentRecordedById: req.auth!.account.id },
    });
    await rec({ action: 'UPDATE', resourceType: 'patient', resourceId: p.id, meta: { fields: ['smsOptIn'], optIn, source } });
    return { status: 200 as const, patient: updated };
  });
  if (result.status === 404) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
  res.json({ patient: patientView(result.patient) });
});

// ---- linking an online booking to a patient --------------------------------------

patientsRouter.get('/fd/bookings/:id/patient-matches', requireFrontDesk, async (req, res) => {
  const b = await prisma.booking.findUnique({
    where: { id: req.params.id },
    select: { id: true, patientId: true, user: { select: { name: true, email: true, phone: true } } },
  });
  if (!b) return res.status(404).json({ error: 'Unknown appointment.', code: 'not_found' });

  const digits = phoneDigits(b.user.phone);
  const matches = await prisma.patient.findMany({
    where: {
      deletedAt: null,
      OR: [
        ...(digits.length >= 10 ? [{ phoneDigits: digits }] : []),
        ...(b.user.email ? [{ email: { equals: b.user.email, mode: 'insensitive' as const } }] : []),
      ],
    },
    take: 10,
  });
  audit.read('appointment', b.id, { section: 'patient-matches' });
  // Suggestions only. Merging two records is a human decision, never automatic.
  res.json({
    linkedPatientId: b.patientId,
    contact: { name: b.user.name, phone: b.user.phone, email: b.user.email },
    matches: matches.map(patientSummary),
  });
});

const linkBody = z.object({ patientId: z.string().min(1).max(64) }).strict();

patientsRouter.post('/fd/bookings/:id/link-patient', requireFrontDesk, async (req, res) => {
  const parsed = linkBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a patient.', code: 'bad_request' });

  const result = await staffTransaction(async (tx, rec) => {
    const [b, p] = await Promise.all([
      tx.booking.findUnique({ where: { id: req.params.id }, select: { id: true } }),
      tx.patient.findFirst({ where: { id: parsed.data.patientId, deletedAt: null }, select: { id: true } }),
    ]);
    if (!b) return { status: 404 as const, error: 'Unknown appointment.' };
    if (!p) return { status: 404 as const, error: 'Unknown patient.' };
    await tx.booking.update({ where: { id: b.id }, data: { patientId: p.id } });
    await rec({ action: 'UPDATE', resourceType: 'appointment', resourceId: b.id, meta: { fields: ['patientId'] } });
    return { status: 200 as const };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error, code: 'not_found' });
  res.json({ ok: true });
});
