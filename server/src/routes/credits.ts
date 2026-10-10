/**
 * Patient credits and memberships (front desk + admin; manual adjustment is admin only).
 *
 *   GET   /api/fd/patients/:id/credits            membership, balance, lots, perks, history
 *   POST  /api/fd/patients/:id/credits/adjust     admin: add or remove credits, with a reason CODE
 *   POST  /api/fd/patients/:id/membership         enrol in a plan (first month's credits granted at once)
 *   PATCH /api/fd/patients/:id/membership         change plan / pause / resume / cancel
 *   POST  /api/fd/patients/:id/perks/:perkId/use  use a perk that is not tied to a service (guest passes)
 *   GET   /api/membership-plans                   the tiers, for the enrol dialog
 *
 * Reads call audit.read(); every write goes through staffTransaction() so its audit row is in the
 * same transaction. Nothing here takes payment.
 */

import { Router } from 'express';
import { z } from 'zod';
import { basePrisma } from '../lib/prismaBase.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import {
  ADJUSTMENT_REASONS, addCredits, clinicDay, DEFAULT_ROLLOVER_DAYS, expiringSoon, fromDateOnly, getLots, lockPatient,
  perkStates, spendable, takeCredits, usePerk,
} from '../lib/credits.js';
import { enroll, openMembership, updateMembership } from '../lib/membership.js';
import { requireRole } from '../middleware/session.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { sendSchedulingError } from './http.js';

export const creditsRouter = Router();

const PAGE = 50;

interface HistoryRow {
  id: string; createdAt: Date; reason: string; delta: number; lotExpiresOn: string | null; reasonCode: string | null;
  actor: string | null; serviceName: string | null; running: number;
}

creditsRouter.get('/fd/patients/:id/credits', requireFrontDesk, async (req, res) => {
  const patientId = req.params.id ?? '';
  const patient = await basePrisma.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true } });
  if (!patient) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });

  const before = typeof req.query.before === 'string' && /^\d{1,18}$/.test(req.query.before) ? req.query.before : null;
  const t = now();
  const today = clinicDay(t);

  const lots = await getLots(basePrisma, patientId, today);
  const m = await openMembership(basePrisma, patientId);
  const perks = m ? await perkStates(basePrisma, m, today) : [];

  // The running total is SUM(delta) in ledger order — it equals the spendable balance once the
  // expiry job has written expiries down, and is shown beside each row so the history adds up.
  const rows = await basePrisma.$queryRaw<HistoryRow[]>`
    SELECT * FROM (
      SELECT l.id::text AS id, l."createdAt", l.reason::text AS reason, l.delta::int AS delta, l."lotExpiresOn"::text AS "lotExpiresOn",
             l."reasonCode", a."displayName" AS actor, e."serviceName" AS "serviceName",
             SUM(l.delta) OVER (ORDER BY l.id)::int AS running
      FROM "CreditLedger" l
      LEFT JOIN "Account" a ON a.id = l."actorAccountId"
      LEFT JOIN "RevenueEvent" e ON e.id = l."revenueEventId"
      WHERE l."patientId" = ${patientId}
    ) t
    WHERE (${before}::bigint IS NULL OR t.id::bigint < ${before}::bigint)
    ORDER BY t.id::bigint DESC
    LIMIT ${PAGE + 1}`;

  audit.read('credit_ledger', patientId, { section: 'credits' });
  res.json({
    membership: m && {
      id: m.id, status: m.status, startedOn: fromDateOnly(m.startedOn), nextGrantOn: fromDateOnly(m.nextGrantOn),
      plan: { code: m.plan.code, name: m.plan.name, priceCents: m.plan.priceCents, creditsPerMonth: m.plan.creditsPerMonth, rolloverDays: m.plan.rolloverDays, discountPercent: m.plan.discountPercent },
    },
    balance: spendable(lots),
    expiringSoon: expiringSoon(lots, today),
    today,
    lots,
    perks: perks.map((p) => ({ perkId: p.perkId, label: p.label, period: p.period, quantity: p.quantity, used: p.used, remaining: p.remaining, periodKey: p.periodKey, services: p.serviceNames, usedAtCheckout: p.serviceIds.length > 0 })),
    history: {
      entries: rows.slice(0, PAGE).map((r) => ({
        id: r.id, at: r.createdAt.toISOString(), date: clinicDay(r.createdAt), reason: r.reason, delta: r.delta, lotExpiresOn: r.lotExpiresOn,
        reasonCode: r.reasonCode, by: r.actor, service: r.serviceName, runningTotal: r.running,
      })),
      nextBefore: rows.length > PAGE ? rows[PAGE - 1]!.id : null,
    },
  });
});

// ---- manual adjustment (admin) --------------------------------------------------------------------

const adjustBody = z.object({
  /** Positive adds a new lot; negative removes, oldest lot first. */
  amount: z.number().int().min(-1000).max(1000).refine((n) => n !== 0, 'Enter a number other than zero.'),
  reasonCode: z.enum(ADJUSTMENT_REASONS),
}).strict();

creditsRouter.post('/fd/patients/:id/credits/adjust', requireRole('ADMIN'), async (req, res) => {
  const patientId = req.params.id ?? '';
  const parsed = adjustBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a whole number of credits (not zero) and choose a reason.', code: 'bad_request', reasons: ADJUSTMENT_REASONS });
  const { amount, reasonCode } = parsed.data;
  const t = now();
  try {
    const out = await staffTransaction(async (tx, rec) => {
      await lockPatient(tx, patientId);
      const p = await tx.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true } });
      if (!p) return null;
      const today = clinicDay(t);
      if (amount > 0) {
        const m = await openMembership(tx, patientId);
        return addCredits(tx, rec, { patientId, amount, today, now: t, rolloverDays: m?.plan.rolloverDays ?? DEFAULT_ROLLOVER_DAYS, actorAccountId: req.auth!.account.id, reasonCode });
      }
      const r = await takeCredits(tx, rec, { patientId, amount: -amount, reason: 'ADJUSTMENT', today, now: t, actorAccountId: req.auth!.account.id, reasonCode });
      return { before: r.before, after: r.after };
    });
    if (!out) return res.status(404).json({ error: 'Unknown patient.', code: 'not_found' });
    res.json({ balanceBefore: out.before, balanceAfter: out.after });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- membership ------------------------------------------------------------------------------------

const enrollBody = z.object({ planCode: z.string().min(1).max(40) }).strict();
const updateBody = z.object({
  action: z.enum(['change_plan', 'pause', 'resume', 'cancel']),
  planCode: z.string().min(1).max(40).optional(),
}).strict();

creditsRouter.post('/fd/patients/:id/membership', requireFrontDesk, async (req, res) => {
  const parsed = enrollBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose a plan.', code: 'bad_request' });
  try {
    const out = await staffTransaction((tx, rec) => enroll(tx, rec, { patientId: req.params.id ?? '', planCode: parsed.data.planCode, accountId: req.auth!.account.id, now: now() }));
    res.status(201).json({ membershipId: out.membership.id, plan: out.plan.name, firstGrant: out.firstGrant, balance: out.balance });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

creditsRouter.patch('/fd/patients/:id/membership', requireFrontDesk, async (req, res) => {
  const parsed = updateBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose what to do.', code: 'bad_request' });
  try {
    const out = await staffTransaction((tx, rec) => updateMembership(tx, rec, { patientId: req.params.id ?? '', ...parsed.data, now: now() }));
    res.json({ status: out.membership.status, changed: out.changed });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- perks used by hand (guest passes) -----------------------------------------------------------------

creditsRouter.post('/fd/patients/:id/perks/:perkId/use', requireFrontDesk, async (req, res) => {
  const patientId = req.params.id ?? '';
  const perkId = req.params.perkId ?? '';
  try {
    const out = await staffTransaction(async (tx, rec) => {
      await lockPatient(tx, patientId);                       // Patient → Membership
      const m = await openMembership(tx, patientId);
      if (!m) return { status: 404 as const };
      const perk = await tx.planPerk.findFirst({ where: { id: perkId, planId: m.planId }, include: { services: { select: { serviceId: true } } } });
      if (!perk) return { status: 404 as const };
      // A perk that covers a service is used by CHECKING OUT that service, which also writes the revenue event.
      if (perk.services.length > 0) return { status: 409 as const, code: 'used_at_checkout', error: 'That perk is used by checking out the service it covers.' };
      const state = await usePerk(tx, rec, { membershipId: m.id, perkId, patientId, today: clinicDay(now()), now: now(), actorAccountId: req.auth!.account.id });
      return { status: 200 as const, remaining: state.remaining };
    });
    if (out.status === 404) return res.status(404).json({ error: 'No such perk on this patient\'s membership.', code: 'not_found' });
    if (out.status === 409) return res.status(409).json({ error: out.error, code: out.code });
    res.json({ remaining: out.remaining });
  } catch (err) {
    if (!sendSchedulingError(res, err)) throw err;
  }
});

// ---- the tiers ---------------------------------------------------------------------------------------

creditsRouter.get('/membership-plans', requireRole(), async (_req, res) => {
  const plans = await prisma.membershipPlan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
  res.json({ plans: plans.map((p) => ({ code: p.code, name: p.name, priceCents: p.priceCents, creditsPerMonth: p.creditsPerMonth, rolloverDays: p.rolloverDays, discountPercent: p.discountPercent })) });
});

