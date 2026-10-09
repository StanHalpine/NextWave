/**
 * Wellness Credits: the ledger, lots, FIFO redemption, expiry and perk counters.
 *
 * ── The model ─────────────────────────────────────────────────────────────────────────────
 * CreditLedger is APPEND-ONLY (database triggers reject UPDATE / DELETE / TRUNCATE).
 *   • a POSITIVE row is a LOT: one per monthly grant (or a manual add), with a last-usable day;
 *   • a NEGATIVE row (redemption, expiry, manual removal) is spread over lots by CreditAllocation
 *     rows, oldest lot first (FIFO);
 *   • what is left in a lot is always  lot.delta − SUM(its allocations)  — computed, never stored,
 *     so no row is ever edited;
 *   • balance = the sum of what is left in lots that have not passed their last day.
 * Expiry is therefore true the moment a lot's day passes, with or without the expiry job; the
 * job only WRITES the expiry down (an EXPIRATION row) so the history says so and SUM(delta)
 * equals the balance again.
 *
 * ── Concurrency ───────────────────────────────────────────────────────────────────────────
 * Anything that takes credits out holds the patient's row lock (`lockPatient`) for the length
 * of its transaction, so two checkouts for one patient cannot both take the last credit. Lock
 * order across the module is Booking → Patient → Membership. As a backstop a DEFERRED constraint
 * trigger (migration 20261012100000) refuses a commit that would overdraw a lot, evaluated
 * against what other transactions committed — it would catch a bug in this file.
 *
 * Dates are clinic-local calendar dates ("2026-11-02"): a 9 p.m. grant belongs to that day.
 */

import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { toLocalDateISO } from './time.js';
import { SchedulingError } from './scheduling.js';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;
type Read = Pick<Tx, '$queryRaw' | 'creditLedger' | 'membership' | 'perkUsage' | 'planPerk'>;

export class CreditError extends SchedulingError {}
const fail = (status: 400 | 404 | 409, code: string, message: string, extra: Record<string, unknown> = {}) => new CreditError(status, code, message, extra);

/** Short controlled vocabulary for a manual adjustment — never free text, which is where PHI would end up. */
export const ADJUSTMENT_REASONS = ['correction', 'goodwill', 'opening_balance', 'lost_credits', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const DEFAULT_ROLLOVER_DAYS = 90;
export const EXPIRING_SOON_DAYS = 30;

// ---- dates (clinic-local "YYYY-MM-DD" strings) --------------------------------------------------

export const clinicDay = (at: Date): string => toLocalDateISO(at);
const utc = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });
export const addDaysISO = (iso: string, n: number): string => utc(iso).plus({ days: n }).toISODate()!;
/** Calendar-month arithmetic; a day that does not exist in the target month clamps to its last day (31 Jan + 1 → 28 Feb). */
export const addMonthsISO = (iso: string, n: number): string => utc(iso).plus({ months: n }).toISODate()!;
/** A Prisma `@db.Date` value from a clinic date. */
export const toDateOnly = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
export const fromDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

/** Whole calendar months from one date to a later one (by year and month, which clamping never changes). */
export function monthsBetween(fromISO: string, toISO: string): number {
  return (Number(toISO.slice(0, 4)) - Number(fromISO.slice(0, 4))) * 12 + (Number(toISO.slice(5, 7)) - Number(fromISO.slice(5, 7)));
}
/** The grant date of the n-th month of a membership that started on `startedOn`. Anchored on the start, so Jan 31 → Feb 28 → Mar 31. */
export const grantDate = (startedOn: string, n: number): string => addMonthsISO(startedOn, n);
/** The first grant date at or after `onOrAfter` (used when a membership resumes — missed months are not made up). */
export function firstGrantOnOrAfter(startedOn: string, onOrAfter: string): string {
  let n = Math.max(0, monthsBetween(startedOn, onOrAfter) - 1);
  while (grantDate(startedOn, n) < onOrAfter) n++;
  return grantDate(startedOn, n);
}

// ---- locks ---------------------------------------------------------------------------------------

/** Serialise everything that moves this patient's credits. Throws 404 for an unknown patient. */
export async function lockPatient(tx: Tx, patientId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Patient" WHERE id = ${patientId} FOR UPDATE`;
  if (rows.length === 0) throw fail(404, 'unknown_patient', 'Unknown patient.');
}

// ---- lots --------------------------------------------------------------------------------------

export type LotStatus = 'ACTIVE' | 'LAPSED' | 'USED' | 'EXPIRED';
export interface Lot {
  id: string;
  /** Clinic date the lot was granted. */
  grantedOn: string;
  /** The month a monthly grant is FOR (its anchor date); null for a manual add. */
  period: string | null;
  /** Last day the credits can be used (inclusive). */
  expiresOn: string;
  source: 'MONTHLY_GRANT' | 'ADJUSTMENT';
  granted: number;
  redeemed: number;
  removed: number;
  expired: number;
  remaining: number;
  /** ACTIVE: usable · LAPSED: past its day, expiry not yet written down · USED: all spent · EXPIRED: written off. */
  status: LotStatus;
}

interface LotRow {
  id: string; createdAt: Date; period: string | null; expiresOn: string; reason: string; granted: number;
  redeemed: number; removed: number; expired: number;
}

/** Every lot a patient has ever had, oldest-expiring first, with what happened to each. */
export async function getLots(db: Read, patientId: string, today: string): Promise<Lot[]> {
  const rows = await lotRows(db, patientId);
  return rows.map((r) => {
    const remaining = r.granted - r.redeemed - r.removed - r.expired;
    const status: LotStatus = remaining > 0 ? (r.expiresOn >= today ? 'ACTIVE' : 'LAPSED') : r.expired > 0 ? 'EXPIRED' : 'USED';
    return {
      id: r.id, grantedOn: clinicDay(r.createdAt), period: r.period, expiresOn: r.expiresOn, source: r.reason as Lot['source'],
      granted: r.granted, redeemed: r.redeemed, removed: r.removed, expired: r.expired, remaining, status,
    };
  });
}

async function lotRows(db: Read, patientId: string): Promise<LotRow[]> {
  return db.$queryRaw<LotRow[]>`
    SELECT l.id::text AS id, l."createdAt", l."periodStart"::text AS period, l."lotExpiresOn"::text AS "expiresOn", l.reason::text AS reason, l.delta::int AS granted,
           COALESCE(SUM(a.amount) FILTER (WHERE r.reason = 'REDEMPTION'), 0)::int AS redeemed,
           COALESCE(SUM(a.amount) FILTER (WHERE r.reason = 'ADJUSTMENT'), 0)::int AS removed,
           COALESCE(SUM(a.amount) FILTER (WHERE r.reason = 'EXPIRATION'), 0)::int AS expired
    FROM "CreditLedger" l
    LEFT JOIN "CreditAllocation" a ON a."lotId" = l.id
    LEFT JOIN "CreditLedger" r ON r.id = a."ledgerId"
    WHERE l."patientId" = ${patientId} AND l.delta > 0
    GROUP BY l.id
    ORDER BY l."lotExpiresOn" ASC, l.id ASC`;
}

/** Credits that can be spent today: what is left in lots that have not passed their last day. */
export const spendable = (lots: Lot[]): number => lots.filter((l) => l.status === 'ACTIVE').reduce((n, l) => n + l.remaining, 0);

export async function balance(db: Read, patientId: string, today: string): Promise<number> {
  return spendable(await getLots(db, patientId, today));
}

/** The earliest day (within `days`) on which some credits expire, and how many do that day or earlier. */
export function expiringSoon(lots: Lot[], today: string, days = EXPIRING_SOON_DAYS): { on: string; credits: number } | null {
  const horizon = addDaysISO(today, days);
  const soon = lots.filter((l) => l.status === 'ACTIVE' && l.expiresOn <= horizon);
  if (soon.length === 0) return null;
  return { on: soon[0]!.expiresOn, credits: soon.reduce((n, l) => n + l.remaining, 0) };
}

// ---- writing -----------------------------------------------------------------------------------

/**
 * Grant one month's credits. Idempotent: the unique key (membership, period, reason) means a re-run
 * — or two runners at once — gets `false` and writes nothing. Returns whether THIS call created the lot.
 */
export async function grantMonthly(tx: Tx, rec: Rec, a: { patientId: string; membershipId: string; credits: number; rolloverDays: number; periodStart: string; now: Date; actorAccountId?: string | null }): Promise<boolean> {
  if (a.credits <= 0) return false; // a tier with no monthly credits grants nothing (the period still advances)
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "CreditLedger" ("patientId", "membershipId", "reason", "delta", "lotExpiresOn", "periodStart", "actorAccountId", "createdAt")
    VALUES (${a.patientId}, ${a.membershipId}, 'MONTHLY_GRANT'::"LedgerReason", ${a.credits},
            (${a.periodStart}::date + ${a.rolloverDays}::int), ${a.periodStart}::date, ${a.actorAccountId ?? null}, ${a.now})
    ON CONFLICT ("membershipId", "periodStart", "reason") DO NOTHING
    RETURNING id::text AS id`;
  if (rows.length === 0) return false;
  await rec({ action: 'CREATE', resourceType: 'credit_ledger', resourceId: a.patientId, meta: { reason: 'MONTHLY_GRANT', credits: a.credits, period: a.periodStart } });
  return true;
}

export interface TakeResult { before: number; after: number; ledgerId: bigint; drawnFrom: Array<{ lotId: string; amount: number }> }

/**
 * Take `amount` credits out, oldest lot first. The caller MUST already hold lockPatient().
 * Throws 409 `insufficient_credits` (writing nothing) if the spendable balance is short.
 */
export async function takeCredits(tx: Tx, rec: Rec, a: {
  patientId: string; amount: number; reason: 'REDEMPTION' | 'ADJUSTMENT'; today: string; now: Date;
  actorAccountId: string | null; encounterId?: string | null; revenueEventId?: string | null; reasonCode?: string | null;
}): Promise<TakeResult> {
  if (!Number.isInteger(a.amount) || a.amount <= 0) throw fail(400, 'bad_amount', 'Enter a whole number of credits above zero.');
  const lots = (await getLots(tx, a.patientId, a.today)).filter((l) => l.status === 'ACTIVE');
  const have = spendable(lots);
  if (have < a.amount) throw fail(409, 'insufficient_credits', `Only ${have} credit${have === 1 ? '' : 's'} available.`, { balance: have, needed: a.amount });

  let need = a.amount;
  const plan: Array<{ lotId: string; amount: number }> = [];
  for (const lot of lots) {                       // already ordered: soonest-expiring (= oldest) first
    if (need === 0) break;
    const take = Math.min(lot.remaining, need);
    plan.push({ lotId: lot.id, amount: take });
    need -= take;
  }

  const row = await tx.creditLedger.create({
    data: {
      patientId: a.patientId, reason: a.reason, delta: -a.amount, actorAccountId: a.actorAccountId, createdAt: a.now,
      encounterId: a.encounterId ?? null, revenueEventId: a.revenueEventId ?? null, reasonCode: a.reasonCode ?? null,
    },
  });
  await tx.creditAllocation.createMany({ data: plan.map((p) => ({ ledgerId: row.id, lotId: BigInt(p.lotId), amount: p.amount })) });
  await rec({
    action: 'CREATE', resourceType: 'credit_ledger', resourceId: a.patientId,
    meta: { reason: a.reason, credits: a.amount, lots: plan.length, ...(a.reasonCode ? { reasonCode: a.reasonCode } : {}) },
  });
  return { before: have, after: have - a.amount, ledgerId: row.id, drawnFrom: plan };
}

/** Add credits as a new lot (an admin's manual adjustment). Caller holds lockPatient(). */
export async function addCredits(tx: Tx, rec: Rec, a: {
  patientId: string; amount: number; today: string; now: Date; rolloverDays: number; actorAccountId: string; reasonCode: AdjustmentReason;
}): Promise<{ before: number; after: number }> {
  if (!Number.isInteger(a.amount) || a.amount <= 0) throw fail(400, 'bad_amount', 'Enter a whole number of credits above zero.');
  const before = await balance(tx, a.patientId, a.today);
  await tx.creditLedger.create({
    data: {
      patientId: a.patientId, reason: 'ADJUSTMENT', delta: a.amount, lotExpiresOn: toDateOnly(addDaysISO(a.today, a.rolloverDays)),
      actorAccountId: a.actorAccountId, reasonCode: a.reasonCode, createdAt: a.now,
    },
  });
  await rec({ action: 'CREATE', resourceType: 'credit_ledger', resourceId: a.patientId, meta: { reason: 'ADJUSTMENT', credits: a.amount, reasonCode: a.reasonCode } });
  return { before, after: before + a.amount };
}

/** Write down lots whose last day has passed (one EXPIRATION row per lot). Caller holds lockPatient(). Returns credits expired. */
export async function expireLapsed(tx: Tx, rec: Rec, patientId: string, today: string, now: Date): Promise<number> {
  let total = 0;
  for (const lot of (await getLots(tx, patientId, today)).filter((l) => l.status === 'LAPSED')) {
    const row = await tx.creditLedger.create({ data: { patientId, reason: 'EXPIRATION', delta: -lot.remaining, actorAccountId: null, createdAt: now } });
    await tx.creditAllocation.create({ data: { ledgerId: row.id, lotId: BigInt(lot.id), amount: lot.remaining } });
    total += lot.remaining;
  }
  if (total > 0) await rec({ action: 'CREATE', resourceType: 'credit_ledger', resourceId: patientId, meta: { reason: 'EXPIRATION', credits: total } });
  return total;
}

// ---- perks (monthly / quarterly / annual entitlement counters) -----------------------------------

/** "2026-11" | "2026-Q4" | "2026" — the calendar period a perk use is counted in (clinic time). */
export function periodKey(period: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL', day: string): string {
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  return period === 'MONTHLY' ? day.slice(0, 7) : period === 'QUARTERLY' ? `${year}-Q${Math.floor((month - 1) / 3) + 1}` : year;
}

export interface PerkState {
  perkId: string; key: string; label: string; period: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  quantity: number; used: number; remaining: number; periodKey: string; serviceIds: string[]; serviceNames: string[];
}

/** The ACTIVE perks of a membership's plan with what has been used in the current period. */
export async function perkStates(db: Read & Pick<Tx, 'planPerk'>, membership: { id: string; planId: string }, today: string): Promise<PerkState[]> {
  const perks = await db.planPerk.findMany({
    where: { planId: membership.planId, active: true },
    orderBy: { sortOrder: 'asc' },
    include: { services: { include: { service: { select: { id: true, name: true } } } } },
  });
  const out: PerkState[] = [];
  for (const p of perks) {
    const key = periodKey(p.period, today);
    const agg = await db.perkUsage.aggregate({ where: { membershipId: membership.id, perkId: p.id, periodKey: key }, _sum: { quantity: true } });
    const used = agg._sum.quantity ?? 0;
    out.push({
      perkId: p.id, key: p.key, label: p.label, period: p.period, quantity: p.quantity, used, remaining: Math.max(0, p.quantity - used), periodKey: key,
      serviceIds: p.services.map((s) => s.service.id), serviceNames: p.services.map((s) => s.service.name),
    });
  }
  return out;
}

/**
 * Use one of a perk. Locks the membership row (Booking → Patient → Membership order), so two
 * check-outs cannot both take the last guest pass.
 */
export async function usePerk(tx: Tx, rec: Rec, a: {
  membershipId: string; perkId: string; patientId: string; today: string; now: Date; actorAccountId: string; revenueEventId?: string | null;
}): Promise<PerkState> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Membership" WHERE id = ${a.membershipId} FOR UPDATE`;
  if (locked.length === 0) throw fail(404, 'unknown_membership', 'Unknown membership.');
  const m = await tx.membership.findUniqueOrThrow({ where: { id: a.membershipId } });
  if (m.status !== 'ACTIVE') throw fail(409, 'membership_not_active', 'Perks are available only while the membership is active.');
  const state = (await perkStates(tx, m, a.today)).find((p) => p.perkId === a.perkId);
  if (!state) throw fail(409, 'perk_unavailable', 'That perk is not part of this membership (or is switched off).');
  if (state.remaining < 1) throw fail(409, 'perk_used_up', `No ${state.label.toLowerCase()} left this ${state.period === 'MONTHLY' ? 'month' : state.period === 'QUARTERLY' ? 'quarter' : 'year'}.`, { used: state.used, quantity: state.quantity });
  await tx.perkUsage.create({
    data: { membershipId: m.id, perkId: a.perkId, patientId: a.patientId, periodKey: state.periodKey, quantity: 1, revenueEventId: a.revenueEventId ?? null, actorAccountId: a.actorAccountId, createdAt: a.now },
  });
  await rec({ action: 'CREATE', resourceType: 'perk_usage', resourceId: a.patientId, meta: { perk: state.key, periodKey: state.periodKey } });
  return { ...state, used: state.used + 1, remaining: state.remaining - 1 };
}
