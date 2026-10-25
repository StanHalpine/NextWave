/**
 * The Charges window (Phase 2c-A, SPEC rev 2.3; docs/CHARGES_DESIGN.md).
 *
 *   GET  /api/charges/catalog                                the quick-add buttons, grouped (front desk, admin, providers)
 *   GET  /api/fd/patients/:id/charges                        the patient's open lines, priced as check-out would price them (desk, admin)
 *   POST /api/fd/patients/:id/charges                        add one line: { serviceId | productId, performedByStaffId?, bookingId?, idempotencyKey }
 *   POST /api/fd/patients/:id/charges/:chargeId/remove       remove an open line before check-out: { idempotencyKey }
 *   GET  /api/provider/visits/:id/charges                    the same, for the patient of a visit the provider may document
 *   POST /api/provider/visits/:id/charges                    add one line from the visit workspace
 *   POST /api/provider/visits/:id/charges/:chargeId/remove   remove an open line
 *
 * Decision 4: front desk, admins and providers may add charges, and remove open ones before check-out; a provider through a visit
 * they may document (the rev 2.1 rule: the visit's provider), before it is checked out. Every write is idempotent (a double click adds
 * one line) and audited by ids only. Checking the lines out — and paying — is the desk's combined check-out (routes/money.ts).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { now } from '../lib/clock.js';
import { addOpenCharge, chargeCatalog, openLinesView, removeOpenCharge, type ChargeItem } from '../lib/charges.js';
import { basePrisma } from '../lib/prismaBase.js';
import { idempotent, isUniqueViolation, priorAnswer, requestHash } from '../lib/money.js';
import { PROVIDER_ROLES } from '../lib/sessions.js';
import { staffTransaction, type Rec } from '../lib/staffTx.js';
import { writeRefusal } from '../lib/visitProvider.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { actingRole, requireClinicalWrite } from '../middleware/clinical.js';
import { requireRole } from '../middleware/session.js';
import { sendSchedulingError } from './http.js';
import type { Prisma } from '@prisma/client';

export const chargesRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = z.string().min(1).max(64);
const key = z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9_-]+$/);
const addBody = z.object({
  serviceId: ID.optional(),
  productId: ID.optional(),
  performedByStaffId: ID.nullish(),
  bookingId: z.string().regex(UUID).nullish(),
  idempotencyKey: key,
  role: z.string().max(40).optional(),
}).strict().refine((b) => !!b.serviceId !== !!b.productId, 'Choose one service or one product.');
const removeBody = z.object({ idempotencyKey: key, role: z.string().max(40).optional() }).strict();

const itemOf = (b: { serviceId?: string | undefined; productId?: string | undefined }): ChargeItem => (b.serviceId ? { serviceId: b.serviceId } : { productId: b.productId! });

/** One idempotent write: a retry of the same request gets the first answer back; errors go out as their status and code. */
async function chargeWrite(res: Response, scope: string, patientId: string, idemKey: string, body: unknown, accountId: string, run: (tx: Prisma.TransactionClient, rec: Rec) => Promise<unknown>) {
  try {
    const out = await staffTransaction((tx, rec) => idempotent(tx, { key: idemKey, scope, patientId, body, actor: accountId }, () => run(tx, rec)));
    return res.json(out.body);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const prior = await priorAnswer(basePrisma, idemKey, scope, patientId, requestHash(body)).catch(() => null);
      if (prior) return res.json(prior.body);
    }
    if (sendSchedulingError(res, err)) return;
    throw err;
  }
}

chargesRouter.get('/charges/catalog', requireRole('FRONT_DESK', 'ADMIN', ...PROVIDER_ROLES), async (_req, res) => {
  res.json(await chargeCatalog(basePrisma));
});

// ---- the front desk (and admins): by patient ----------------------------------------------------------------------------------

chargesRouter.get('/fd/patients/:id/charges', requireFrontDesk, async (req, res) => {
  const patientId = req.params.id ?? '';
  const p = UUID.test(patientId) ? await basePrisma.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true } }) : null;
  if (!p) return res.status(404).json({ error: 'Unknown patient.', code: 'unknown_patient' });
  const open = await basePrisma.$transaction((tx) => openLinesView(tx, patientId, now()), { isolationLevel: 'RepeatableRead' });
  res.json({ ...open, catalog: await chargeCatalog(basePrisma), timezone: config.clinicTimezone });
});

chargesRouter.post('/fd/patients/:id/charges', requireFrontDesk, async (req, res) => {
  const parsed = addBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  const patientId = req.params.id ?? '';
  if (!UUID.test(patientId)) return res.status(404).json({ error: 'Unknown patient.', code: 'unknown_patient' });
  const accountId = req.auth!.account.id;
  return chargeWrite(res, 'charge-add', patientId, b.idempotencyKey, b, accountId, (tx, rec) => addOpenCharge(tx, rec, {
    patientId, item: itemOf(b), accountId, now: now(), performedByStaffId: b.performedByStaffId ?? null, bookingId: b.bookingId ?? null,
  }));
});

chargesRouter.post('/fd/patients/:id/charges/:chargeId/remove', requireFrontDesk, async (req, res) => {
  const parsed = removeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const patientId = req.params.id ?? '';
  const chargeId = req.params.chargeId ?? '';
  if (!UUID.test(patientId) || !UUID.test(chargeId)) return res.status(404).json({ error: 'Unknown charge.', code: 'unknown_charge' });
  const accountId = req.auth!.account.id;
  return chargeWrite(res, `charge-remove:${chargeId}`, patientId, parsed.data.idempotencyKey, parsed.data, accountId, (tx, rec) => removeOpenCharge(tx, rec, {
    patientId, openChargeId: chargeId, accountId, now: now(),
  }));
});

// ---- providers: through a visit they may document -------------------------------------------------------------------------------

const BEFORE_CHECK_OUT = ['CHECKED_IN', 'IN_PROGRESS', 'SEEN'];

/**
 * The patient of this visit, when the signed-in provider may add charges to it: the visit is linked to a patient, checked in and not yet
 * checked out, and they are its provider (the same rule as writing its note). Otherwise the refusal is sent and null returned.
 */
async function visitPatient(req: Request, res: Response, requestedRole: unknown): Promise<string | null> {
  const r = actingRole(req, requestedRole);
  if ('error' in r) { res.status(400).json({ error: r.error, code: 'role_required' }); return null; }
  if (!r.role) { res.status(403).json({ error: 'Only a provider adds charges from a visit.', code: 'read_only' }); return null; }
  const bookingId = req.params.id ?? '';
  const b = UUID.test(bookingId) ? await basePrisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      patientId: true, status: true, staffId: true, staff: { select: { id: true, name: true, role: true } },
      encounter: { select: { status: true, coveringStaffId: true, coveringStaff: { select: { id: true, name: true, role: true } } } },
    },
  }) : null;
  if (!b) { res.status(404).json({ error: 'Unknown appointment.', code: 'not_found' }); return null; }
  if (!b.patientId) { res.status(409).json({ error: 'Link this visit to a patient record before adding charges.', code: 'no_patient' }); return null; }
  if (b.status !== 'CONFIRMED' || !b.encounter || !BEFORE_CHECK_OUT.includes(b.encounter.status)) {
    res.status(409).json({ error: 'Charges are added to a visit that is checked in and not yet checked out.', code: 'not_open' }); return null;
  }
  const refused = writeRefusal(b, { role: r.role, staffId: req.auth!.account.staffId });
  if (refused) { res.status(403).json({ error: refused.message, code: refused.code }); return null; }
  return b.patientId;
}

chargesRouter.get('/provider/visits/:id/charges', ...requireClinicalWrite, async (req, res) => {
  const patientId = await visitPatient(req, res, typeof req.query.role === 'string' ? req.query.role : undefined);
  if (!patientId) return;
  const open = await basePrisma.$transaction((tx) => openLinesView(tx, patientId, now()), { isolationLevel: 'RepeatableRead' });
  // A provider sees what was added and what it comes to — not the patient's credits or perks.
  res.json({ lines: open.lines.map(({ credits: _c, perks: _p, ...l }) => l), totals: open.totals, catalog: await chargeCatalog(basePrisma), timezone: config.clinicTimezone });
});

chargesRouter.post('/provider/visits/:id/charges', ...requireClinicalWrite, async (req, res) => {
  const parsed = addBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  const patientId = await visitPatient(req, res, b.role);
  if (!patientId) return;
  const accountId = req.auth!.account.id;
  return chargeWrite(res, 'charge-add', patientId, b.idempotencyKey, b, accountId, (tx, rec) => addOpenCharge(tx, rec, {
    patientId, item: itemOf(b), accountId, now: now(), performedByStaffId: b.performedByStaffId ?? null, bookingId: req.params.id ?? null,
  }));
});

chargesRouter.post('/provider/visits/:id/charges/:chargeId/remove', ...requireClinicalWrite, async (req, res) => {
  const parsed = removeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const patientId = await visitPatient(req, res, parsed.data.role);
  if (!patientId) return;
  const chargeId = req.params.chargeId ?? '';
  if (!UUID.test(chargeId)) return res.status(404).json({ error: 'Unknown charge.', code: 'unknown_charge' });
  const accountId = req.auth!.account.id;
  return chargeWrite(res, `charge-remove:${chargeId}`, patientId, parsed.data.idempotencyKey, parsed.data, accountId, (tx, rec) => removeOpenCharge(tx, rec, {
    patientId, openChargeId: chargeId, accountId, now: now(), bookingId: req.params.id ?? null,
  }));
});
