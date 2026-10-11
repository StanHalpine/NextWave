/**
 * Membership lifecycle and the monthly credit grant.
 *
 *   enroll → ACTIVE (first month's credits granted at once)
 *   pause  → PAUSED  (no grants; credits already granted stay usable)
 *   resume → ACTIVE  (grants continue from the next grant date; missed months are NOT made up)
 *   cancel → CANCELLED (no new grants; credits already granted run out their rollover — spec A-11)
 *   change plan: takes effect at the NEXT grant — nothing is prorated or clawed back.
 *
 * Nothing here takes payment. Dues are collected outside this system; the front desk enrols,
 * pauses or cancels to match. Each month's dues are BILLED (a RevenueEvent, lib/dues.ts) when its credits are granted.
 *
 * Lock order: Patient → Membership (and Booking before both in a check-out).
 */

import type { Prisma } from '@prisma/client';
import {
  addMonthsISO, balance, clinicDay, CreditError, firstGrantOnOrAfter, fromDateOnly, grantDate, grantMonthly,
  lockPatient, monthsBetween, toDateOnly,
} from './credits.js';
import { billDues } from './dues.js';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;
const fail = (status: 400 | 404 | 409, code: string, message: string) => new CreditError(status, code, message);

/** Longest catch-up in one run (a job that was down for a year grants a year, not more). */
const MAX_PERIODS_PER_RUN = 12;

export async function openMembership(db: Pick<Tx, 'membership'>, patientId: string) {
  return db.membership.findFirst({ where: { patientId, status: { in: ['ACTIVE', 'PAUSED'] } }, include: { plan: true } });
}

/** Grant every month that has come due for ONE membership (normally exactly one). Idempotent. Returns months granted. */
export async function grantDue(tx: Tx, rec: Rec, membershipId: string, now: Date, opts: { actorAccountId?: string | null; skipLocked?: boolean } = {}): Promise<number> {
  const today = clinicDay(now);
  // Lock the membership row so two runners cannot work it at once. SKIP LOCKED: if another job
  // holds it, it is being granted — move on rather than wait.
  const rows = opts.skipLocked
    ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Membership" WHERE id = ${membershipId} FOR UPDATE SKIP LOCKED`
    : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Membership" WHERE id = ${membershipId} FOR UPDATE`;
  if (rows.length === 0) return 0;

  const m = await tx.membership.findUniqueOrThrow({ where: { id: membershipId }, include: { plan: true } });
  if (m.status !== 'ACTIVE') return 0;

  const startedOn = fromDateOnly(m.startedOn);
  let next = fromDateOnly(m.nextGrantOn);
  let granted = 0;
  for (let i = 0; i < MAX_PERIODS_PER_RUN && next <= today; i++) {
    const made = await grantMonthly(tx, rec, {
      patientId: m.patientId, membershipId: m.id, credits: m.plan.creditsPerMonth, rolloverDays: m.plan.rolloverDays,
      periodStart: next, now, actorAccountId: opts.actorAccountId ?? null,
    });
    if (made) granted++;
    // The month's dues are billed with its credits (lib/dues.ts) — also when the tier grants none.
    await billDues(tx, rec, { membership: m, plan: m.plan, periodStart: next, actorAccountId: opts.actorAccountId ?? null });
    next = grantDate(startedOn, monthsBetween(startedOn, next) + 1);
  }
  if (next !== fromDateOnly(m.nextGrantOn)) {
    await tx.membership.update({ where: { id: m.id }, data: { nextGrantOn: toDateOnly(next) } });
  }
  return granted;
}

export async function enroll(tx: Tx, rec: Rec, a: { patientId: string; planCode: string; accountId: string; now: Date }) {
  await lockPatient(tx, a.patientId);
  const patient = await tx.patient.findFirst({ where: { id: a.patientId, deletedAt: null }, select: { id: true } });
  if (!patient) throw fail(404, 'unknown_patient', 'Unknown patient.');
  if (await openMembership(tx, a.patientId)) throw fail(409, 'already_member', 'This patient already has a membership. Change its plan, or cancel it first.');

  const plan = await tx.membershipPlan.findFirst({ where: { code: a.planCode, active: true } });
  if (!plan) throw fail(400, 'unknown_plan', 'Choose one of the available membership plans.');

  const today = clinicDay(a.now);
  const m = await tx.membership.create({
    data: { patientId: a.patientId, planId: plan.id, status: 'ACTIVE', startedOn: toDateOnly(today), nextGrantOn: toDateOnly(today), createdById: a.accountId },
  });
  await rec({ action: 'CREATE', resourceType: 'membership', resourceId: m.id, meta: { plan: plan.code, startedOn: today } });
  const granted = await grantDue(tx, rec, m.id, a.now, { actorAccountId: a.accountId });
  return { membership: m, plan, firstGrant: granted > 0 ? plan.creditsPerMonth : 0, balance: await balance(tx, a.patientId, today) };
}

export type MembershipAction = 'change_plan' | 'pause' | 'resume' | 'cancel';

export async function updateMembership(tx: Tx, rec: Rec, a: { patientId: string; action: MembershipAction; planCode?: string; now: Date }) {
  await lockPatient(tx, a.patientId);
  const m = await openMembership(tx, a.patientId);
  if (!m) throw fail(404, 'no_membership', 'This patient has no current membership.');
  const today = clinicDay(a.now);

  switch (a.action) {
    case 'change_plan': {
      if (!a.planCode) throw fail(400, 'bad_request', 'Choose a plan.');
      const plan = await tx.membershipPlan.findFirst({ where: { code: a.planCode, active: true } });
      if (!plan) throw fail(400, 'unknown_plan', 'Choose one of the available membership plans.');
      if (plan.id === m.planId) return { membership: m, changed: false as const };
      const updated = await tx.membership.update({ where: { id: m.id }, data: { planId: plan.id } });
      await rec({ action: 'UPDATE', resourceType: 'membership', resourceId: m.id, meta: { fields: ['planId'], from: m.plan.code, to: plan.code } });
      return { membership: updated, changed: true as const };
    }
    case 'pause': {
      if (m.status !== 'ACTIVE') throw fail(409, 'not_active', 'Only an active membership can be paused.');
      const updated = await tx.membership.update({ where: { id: m.id }, data: { status: 'PAUSED', pausedAt: a.now } });
      await rec({ action: 'UPDATE', resourceType: 'membership', resourceId: m.id, meta: { fields: ['status'], to: 'PAUSED' } });
      return { membership: updated, changed: true as const };
    }
    case 'resume': {
      if (m.status !== 'PAUSED') throw fail(409, 'not_paused', 'Only a paused membership can be resumed.');
      // Months missed while paused are not made up: grants restart on the next grant date.
      const next = firstGrantOnOrAfter(fromDateOnly(m.startedOn), today);
      const updated = await tx.membership.update({ where: { id: m.id }, data: { status: 'ACTIVE', pausedAt: null, nextGrantOn: toDateOnly(next) } });
      await rec({ action: 'UPDATE', resourceType: 'membership', resourceId: m.id, meta: { fields: ['status', 'nextGrantOn'], to: 'ACTIVE' } });
      const granted = await grantDue(tx, rec, m.id, a.now, { actorAccountId: null });
      return { membership: updated, changed: true as const, granted };
    }
    case 'cancel': {
      const updated = await tx.membership.update({ where: { id: m.id }, data: { status: 'CANCELLED', cancelledAt: a.now } });
      await rec({ action: 'UPDATE', resourceType: 'membership', resourceId: m.id, meta: { fields: ['status'], to: 'CANCELLED' } });
      return { membership: updated, changed: true as const };
    }
  }
}

/** For tests and the job: the date a membership's n-th month is granted. */
export { addMonthsISO };
