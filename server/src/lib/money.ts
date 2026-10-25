/**
 * The money layer (Phase 2b, rev 2.2): the derived balance, the Ledger version, and the writes — a combined check-out with an optional
 * payment, a payment on its own, a payment reversal, and an admin's refund of account credit. docs/MONEY_LAYER_DESIGN.md.
 *
 * Rules every write here keeps:
 *   • integer cents; nothing derivable is stored — the balance and the account credit are sums of rows (balanceOf, accountCreditOf);
 *   • ONE transaction per write; locks in the house order: the named BOOKINGS by id, then the PATIENT, then the money tables;
 *   • the screen's `expectedVersion` is checked UNDER the patient lock — a mismatch is 409 `ledger_changed` and nothing is written;
 *   • every lookup is scoped by the patient: a booking or payment of anyone else is "unknown";
 *   • audit rows carry ids, codes and counts only — never an amount, a note or a name;
 *   • account credit (dollars) and membership credits (CreditLedger) never meet: nothing here reads or writes the credit ledger except
 *     through check-out's own `takeCredits` for a visit paid with membership credits.
 * The database backs the arithmetic with commit-time guards (nw_money_guard): a payment must be accounted for exactly, a charge can
 * never be paid more than its net, account credit can never go below zero.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { checkoutVisit, type AdjustmentInput, type CheckoutSummary } from './checkout.js';
import { checkoutCharge, WITH_QUANTITY, type ChargeSummary } from './charges.js';
import { openMembership } from './membership.js';
import { clinicDay, CreditError, lockPatient, toDateOnly } from './credits.js';
import { lockedBooking } from './encounters.js';
import { allocateOldestFirst, looksLikeCardNumber } from './moneyMath.js';
import type { Rec } from './staffTx.js';
import { SchedulingError } from './scheduling.js';
import { config } from '../config.js';

const CLINIC_TZ = config.clinicTimezone;

type Tx = Prisma.TransactionClient;
type Status = 400 | 403 | 404 | 409;

export class MoneyError extends CreditError {}
const fail = (status: Status, code: string, message: string, extra: Record<string, unknown> = {}) => new MoneyError(status as never, code, message, extra);

export const TENDERS = ['CASH', 'CARD', 'CHECK', 'HSA_FSA', 'OTHER'] as const;
export type Tender = (typeof TENDERS)[number];
export const REVERSAL_REASONS = ['ENTERED_IN_ERROR', 'DECLINED', 'CHECK_RETURNED', 'DUPLICATE', 'OTHER'] as const;
export type ReversalReasonCode = (typeof REVERSAL_REASONS)[number];

/** Who is acting, as far as money is concerned. `mfaAdmin`: an ADMIN on an MFA-verified session — the only one past the desk's limits. */
export interface Actor { accountId: string; mfaAdmin: boolean }

// ---- reading: charges, balance, account credit, version -----------------------------------------------------------------------

export interface ChargeRow {
  id: string; occurredAt: Date; bookingId: string | null; serviceName: string;
  /** What the line owes: its net plus its sales tax (rev 2.3; tax only on a taxable product). */
  owedCents: number;
  preTracking: boolean; paidCents: number; creditAppliedCents: number; outstandingCents: number;
}

/**
 * Every charge of the patient — visits, add-on services and products — OLDEST FIRST, with what has settled it. Reversed payments do
 * not count. Dues are not charges here. "Oldest" is when it was recorded, then — for lines checked out together, which share that
 * instant — when the visit was, and for add-on lines (after the visits) when each was added.
 */
export async function chargesOf(db: Pick<Tx, '$queryRaw'>, patientId: string): Promise<ChargeRow[]> {
  const rows = await db.$queryRaw<Array<{ id: string; occurredAt: Date; bookingId: string | null; serviceName: string; owed: number; pre: boolean; paid: number; credit: number }>>`
    SELECT e."id", e."occurredAt", e."bookingId", e."serviceName", (e."netPriceCents" + e."taxCents")::int AS owed,
           EXISTS (SELECT 1 FROM "PreTrackingSettlement" s WHERE s."revenueEventId" = e."id") AS pre,
           COALESCE((SELECT SUM(a."amountCents") FROM "PaymentAllocation" a
                      WHERE a."revenueEventId" = e."id"
                        AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" r WHERE r."paymentId" = a."paymentId")), 0)::int AS paid,
           COALESCE((SELECT SUM(-c."deltaCents") FROM "AccountCreditEntry" c WHERE c."revenueEventId" = e."id" AND c."kind" = 'APPLIED'), 0)::int AS credit
    FROM "RevenueEvent" e LEFT JOIN "Booking" b ON b."id" = e."bookingId" LEFT JOIN "OpenCharge" o ON o."id" = e."openChargeId"
    WHERE e."patientId" = ${patientId} AND e."paymentType" <> 'DUES'
    ORDER BY e."occurredAt" ASC, b."startTime" ASC NULLS LAST, o."addedAt" ASC NULLS LAST, o."createdAt" ASC NULLS LAST, e."id" ASC`;
  return rows.map((r) => ({
    id: r.id, occurredAt: r.occurredAt, bookingId: r.bookingId, serviceName: r.serviceName, owedCents: r.owed, preTracking: r.pre,
    paidCents: r.paid, creditAppliedCents: r.credit,
    outstandingCents: r.pre ? 0 : r.owed - r.paid - r.credit,
  }));
}

/** What the patient owes: Σ outstanding over their charges, tax included. Derived, never stored. */
export const balanceOf = async (db: Pick<Tx, '$queryRaw'>, patientId: string): Promise<number> =>
  (await chargesOf(db, patientId)).reduce((n, c) => n + c.outstandingCents, 0);

/** ACCOUNT CREDIT in dollars (decision 4): Σ of the patient's account-credit rows. Nothing to do with membership credits. */
export async function accountCreditOf(db: Pick<Tx, 'accountCreditEntry'>, patientId: string): Promise<number> {
  const r = await db.accountCreditEntry.aggregate({ where: { patientId }, _sum: { deltaCents: true } });
  return r._sum.deltaCents ?? 0;
}

/**
 * The Ledger's VERSION: a hash over everything a money decision about this patient rests on — their charges, payments, allocations,
 * reversals, refunds, account-credit rows, and the state of today's visits. A screen sends the version it was showing; a write
 * recomputes it under the patient lock and refuses a mismatch, so nothing is applied to a state the person did not see.
 */
export async function ledgerVersion(db: Pick<Tx, '$queryRaw'>, patientId: string, today: string): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ v: string }>>`
    SELECT md5(concat_ws('|',
      (SELECT string_agg(e."id" || ':' || e."netPriceCents", ',' ORDER BY e."id") FROM "RevenueEvent" e WHERE e."patientId" = ${patientId} AND e."paymentType" <> 'DUES'),
      (SELECT string_agg(p."id", ',' ORDER BY p."id") FROM "Payment" p WHERE p."patientId" = ${patientId}),
      (SELECT string_agg(a."id"::text, ',' ORDER BY a."id") FROM "PaymentAllocation" a JOIN "Payment" p ON p."id" = a."paymentId" WHERE p."patientId" = ${patientId}),
      (SELECT string_agg(r."id", ',' ORDER BY r."id") FROM "PaymentReversal" r JOIN "Payment" p ON p."id" = r."paymentId" WHERE p."patientId" = ${patientId}),
      (SELECT string_agg(f."id", ',' ORDER BY f."id") FROM "Refund" f WHERE f."patientId" = ${patientId}),
      (SELECT string_agg(c."id"::text, ',' ORDER BY c."id") FROM "AccountCreditEntry" c WHERE c."patientId" = ${patientId}),
      -- Rev 2.3: the open lines, and whether each was removed — a charge added by anyone changes what the desk is checking out.
      (SELECT string_agg(o."id" || ':' || CASE WHEN r."openChargeId" IS NULL THEN 'o' ELSE 'r' END, ',' ORDER BY o."id")
         FROM "OpenCharge" o LEFT JOIN "OpenChargeRemoval" r ON r."openChargeId" = o."id" WHERE o."patientId" = ${patientId}),
      (SELECT string_agg(q."id"::text, ',' ORDER BY q."id") FROM "OpenChargeQuantity" q JOIN "OpenCharge" o ON o."id" = q."openChargeId" WHERE o."patientId" = ${patientId}),
      (SELECT string_agg(b."id" || ':' || COALESCE(n."status"::text, '-'), ',' ORDER BY b."id")
         FROM "Booking" b LEFT JOIN "Encounter" n ON n."bookingId" = b."id"
        WHERE b."patientId" = ${patientId} AND b."status" = 'CONFIRMED'
          AND (b."startTime" AT TIME ZONE 'UTC' AT TIME ZONE ${CLINIC_TZ})::date = ${today}::date)
    )) AS v`;
  return `v:${row!.v}`;
}
/** A soft-deleted patient takes no new money. (Called after lockPatient, which already refuses an unknown id.) */
async function assertPatient(tx: Tx, patientId: string): Promise<void> {
  const p = await tx.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true } });
  if (!p) throw fail(404, 'unknown_patient', 'Unknown patient.');
}

async function assertVersion(tx: Tx, patientId: string, today: string, expected: string): Promise<void> {
  const now = await ledgerVersion(tx, patientId, today);
  if (now !== expected) {
    throw fail(409, 'ledger_changed', 'This patient\'s ledger changed since the screen was loaded — someone else checked out a visit or took a payment. Review it and confirm again.', { version: now });
  }
}

// ---- idempotency ----------------------------------------------------------------------------------------------------------------

/** SHA-256 of the request body with its keys sorted, so the same request always hashes the same. */
export function requestHash(body: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return createHash('sha256').update(JSON.stringify(canon(body))).digest('hex');
}

export interface Stored { status: number; body: unknown }

/** A previously recorded answer for this key: the same request gets it back; the same key with a different request is refused. */
export async function priorAnswer(db: Pick<Tx, 'idempotencyRecord'>, key: string, scope: string, patientId: string, hash: string): Promise<Stored | null> {
  const r = await db.idempotencyRecord.findUnique({ where: { key } });
  if (!r) return null;
  if (r.scope !== scope || r.patientId !== patientId || r.requestHash !== hash) {
    throw fail(409, 'idempotency_key_reused', 'That confirmation was already used for a different request. Reload and confirm again.');
  }
  return { status: r.responseStatus, body: r.response };
}

async function remember(tx: Tx, a: { key: string; scope: string; patientId: string; hash: string; actor: string; body: unknown }): Promise<void> {
  await tx.idempotencyRecord.create({
    data: { key: a.key, scope: a.scope, patientId: a.patientId, requestHash: a.hash, responseStatus: 200, response: a.body as Prisma.InputJsonValue, createdById: a.actor },
  });
}

// ---- the combined check-out (and a payment on its own) ----------------------------------------------------------------------

export interface VisitLine {
  bookingId: string;
  pay: 'MONEY' | 'CREDITS' | 'PERK';
  perkId?: string;
  /** The list price typed at the desk, only for a service with no set price. */
  priceCents?: number;
  /** The net the screen showed; a different figure on the server is 409 price_changed. */
  expectedNetCents?: number;
  adjustment?: AdjustmentInput | null;
}

/** Rev 2.3: an open line (add-on service or product) to check out, and how it is paid. CREDITS and PERK are for a service only. */
export interface ChargeLine {
  openChargeId: string;
  pay: 'MONEY' | 'CREDITS' | 'PERK';
  perkId?: string;
  expectedNetCents?: number;
  adjustment?: AdjustmentInput | null;
}

export interface SettleInput {
  patientId: string;
  idempotencyKey: string;
  expectedVersion: string;
  visits: VisitLine[];
  /** Rev 2.3: open lines checked out with the visits (or on their own). */
  charges?: ChargeLine[];
  /** Account credit ($) the desk chose to apply, oldest charge first (decision 4). */
  applyAccountCreditCents?: number;
  payment?: { tender: Tender; amountCents: number; reference?: string | null; note?: string | null } | null;
  /** Required when the payment is less than what is due (decision 8). */
  confirmPartial?: boolean;
  /** Required when the payment is MORE than is due: what to do with the rest (decision 4). */
  overpayment?: { as: 'REFUND'; tender?: Tender; note?: string | null } | { as: 'ACCOUNT_CREDIT' } | null;
}

export interface SettleResult {
  batchId: string | null;
  visits: Array<{ bookingId: string } & Omit<CheckoutSummary, 'balanceBefore' | 'balanceAfter' | 'alreadyCheckedOut' | 'recordedAt'>>;
  /** Rev 2.3: the add-on services and products checked out — itemized, with each one's tax (decision 6). */
  charges: ChargeSummary[];
  accountCreditApplied: Array<{ revenueEventId: string; cents: number }>;
  payment: null | {
    id: string; tender: Tender; amountCents: number; collectedOn: string;
    allocations: Array<{ revenueEventId: string; cents: number }>;
    refund: { id: string; tender: Tender; amountCents: number } | null;
    toAccountCreditCents: number;
  };
  balanceCents: number;
  accountCreditCents: number;
  recordedAt: string;
}

const isCheckedIn = (s: string | undefined) => s === 'CHECKED_IN' || s === 'IN_PROGRESS' || s === 'SEEN';

function checkTender(t: { tender: Tender; reference?: string | null; note?: string | null }, what: string) {
  const ref = t.reference?.trim() || null;
  const note = t.note?.trim() || null;
  if (looksLikeCardNumber(ref) || looksLikeCardNumber(note)) throw fail(400, 'card_number_refused', 'That looks like a card number. Card details are never recorded here — leave the reference blank or use the terminal receipt number.');
  if (t.tender === 'OTHER' && !note) throw fail(400, 'tender_note_required', `Say what "Other" was for this ${what}.`);
  if (ref && ref.length > 60) throw fail(400, 'reference_too_long', 'Keep the reference to 60 characters.');
  if (note && note.length > 200) throw fail(400, 'note_too_long', 'Keep the note to 200 characters.');
  return { reference: ref, note };
}

export async function settle(tx: Tx, rec: Rec, actor: Actor, now: Date, a: SettleInput): Promise<SettleResult> {
  const today = clinicDay(now);
  const ids = a.visits.map((v) => v.bookingId);
  if (new Set(ids).size !== ids.length) throw fail(400, 'duplicate_visit', 'A visit is listed twice.');
  const chargeLines = a.charges ?? [];
  if (new Set(chargeLines.map((c) => c.openChargeId)).size !== chargeLines.length) throw fail(400, 'duplicate_charge', 'An item is listed twice.');
  const pay = a.payment && a.payment.amountCents > 0 ? a.payment : null;
  const applyCredit = a.applyAccountCreditCents ?? 0;
  if (a.visits.length === 0 && chargeLines.length === 0 && !pay && applyCredit === 0) throw fail(400, 'nothing_to_do', 'Choose a visit or an item to check out, or enter a payment.');
  if (!Number.isInteger(applyCredit) || applyCredit < 0) throw fail(400, 'bad_amount', 'Account credit is a whole number of cents.');
  if (a.payment && (!Number.isInteger(a.payment.amountCents) || a.payment.amountCents < 0)) throw fail(400, 'bad_amount', 'A payment is a whole number of cents.');
  const tenderFields = pay ? checkTender(pay, 'payment') : null;

  // 1. Locks, in the house order: every named booking BY ID, then the patient.
  const bookings = [];
  for (const id of [...ids].sort()) {
    const b = await lockedBooking(tx, id).catch((e: unknown) => {
      if (e instanceof SchedulingError && e.status === 404) throw fail(404, 'unknown_visit', 'One of these visits does not exist.');
      throw e;
    });
    if (b.patientId !== a.patientId) throw fail(404, 'unknown_visit', 'One of these visits does not belong to this patient.');
    bookings.push(b);
  }
  await lockPatient(tx, a.patientId);
  await assertPatient(tx, a.patientId);

  // 2. What the screen was showing is still true.
  await assertVersion(tx, a.patientId, today, a.expectedVersion);

  // 3. The visits: each priced by check-out's own function and checked out (still the only writer of CHECKED_OUT), oldest visit first.
  const batchId = a.visits.length || chargeLines.length ? randomUUID() : null;
  if (batchId) {
    await tx.checkoutBatch.create({ data: { id: batchId, patientId: a.patientId, createdById: actor.accountId } });
    await rec({ action: 'CREATE', resourceType: 'checkout_batch', resourceId: batchId, meta: { visits: a.visits.length, charges: chargeLines.length } });
  }
  const byId = new Map(a.visits.map((v) => [v.bookingId, v]));
  const visits: SettleResult['visits'] = [];
  for (const b of [...bookings].sort((x, y) => x.startTime.getTime() - y.startTime.getTime() || (x.id < y.id ? -1 : 1))) {
    if (!isCheckedIn(b.encounter?.status)) {
      throw fail(409, b.encounter?.status === 'CHECKED_OUT' ? 'already_checked_out' : 'not_checked_in',
        b.encounter?.status === 'CHECKED_OUT' ? 'One of these visits is already checked out.' : 'One of these visits is not checked in.');
    }
    const line = byId.get(b.id)!;
    const choice = line.pay === 'CREDITS' ? { payment: 'CREDITS' as const } : line.pay === 'PERK' ? { payment: 'PERK' as const, perkId: line.perkId ?? '' }
      : { payment: 'CASH' as const, priceCents: line.priceCents, expectedNetCents: line.expectedNetCents };
    const s = await checkoutVisit(tx, rec, { bookingId: b.id, accountId: actor.accountId, now, adjustment: line.adjustment ?? null, byAdmin: actor.mfaAdmin, batchId, ...choice });
    const { balanceBefore: _b, balanceAfter: _a, alreadyCheckedOut: _c, recordedAt: _r, ...rest } = s;
    visits.push({ bookingId: b.id, ...rest });
  }

  // 3b. Rev 2.3: the open lines — each this patient's, still open — oldest added first, priced by charges.ts.
  const checkedOutCharges: ChargeSummary[] = [];
  if (chargeLines.length) {
    const lines = [];
    for (const c of chargeLines) {
      const oc = await tx.openCharge.findFirst({ where: { id: c.openChargeId, patientId: a.patientId }, include: { removal: true, charge: { select: { id: true } }, ...WITH_QUANTITY } });
      if (!oc) throw fail(404, 'unknown_charge', 'One of these items does not belong to this patient.');
      if (oc.removal) throw fail(409, 'charge_removed', `${oc.name} was removed from the charges.`);
      if (oc.charge) throw fail(409, 'already_checked_out', `${oc.name} is already checked out.`);
      const { removal: _r, charge: _c, ...line } = oc;
      lines.push({ line, choice: c });
    }
    lines.sort((x, y) => x.line.addedAt.getTime() - y.line.addedAt.getTime() || x.line.createdAt.getTime() - y.line.createdAt.getTime() || (x.line.id < y.line.id ? -1 : 1));
    const membership = await openMembership(tx, a.patientId);
    for (const { line, choice } of lines) {
      checkedOutCharges.push(await checkoutCharge(tx, rec, {
        line, pay: choice.pay, perkId: choice.perkId, expectedNetCents: choice.expectedNetCents, adjustment: choice.adjustment ?? null,
        byAdmin: actor.mfaAdmin, batchId, accountId: actor.accountId, now, membership,
      }));
    }
  }

  // 4. What is due now, oldest first — an old carried-forward balance before today's visits.
  let charges = (await chargesOf(tx, a.patientId)).filter((c) => c.outstandingCents > 0);
  const due = charges.reduce((n, c) => n + c.outstandingCents, 0);

  // 5. Account credit, when the desk chose to apply it.
  const accountCreditApplied: SettleResult['accountCreditApplied'] = [];
  if (applyCredit > 0) {
    const have = await accountCreditOf(tx, a.patientId);
    if (applyCredit > have) throw fail(409, 'account_credit_insufficient', 'That is more account credit than the patient has.', { accountCreditCents: have });
    if (applyCredit > due) throw fail(400, 'account_credit_exceeds_due', 'That is more account credit than is due.', { dueCents: due });
    const { allocations } = allocateOldestFirst(charges.map((c) => ({ id: c.id, outstandingCents: c.outstandingCents })), applyCredit);
    for (const x of allocations) {
      await tx.accountCreditEntry.create({ data: { patientId: a.patientId, kind: 'APPLIED', deltaCents: -x.cents, revenueEventId: x.id, entryOn: toDateOnly(today), createdById: actor.accountId } });
      accountCreditApplied.push({ revenueEventId: x.id, cents: x.cents });
    }
    await rec({ action: 'CREATE', resourceType: 'account_credit', resourceId: a.patientId, meta: { kind: 'APPLIED', rows: allocations.length } });
    charges = (await chargesOf(tx, a.patientId)).filter((c) => c.outstandingCents > 0);
  }
  const dueNow = charges.reduce((n, c) => n + c.outstandingCents, 0);

  // 6. The payment: partial needs confirmation; more than is due needs the patient's choice for the rest.
  let payment: SettleResult['payment'] = null;
  if (pay) {
    if (pay.amountCents < dueNow && !a.confirmPartial) {
      throw fail(400, 'partial_needs_confirmation', 'This is less than is due. Confirm that it is a partial payment; the rest carries forward.', { dueCents: dueNow });
    }
    const overCents = Math.max(0, pay.amountCents - dueNow);
    if (overCents > 0 && !a.overpayment) {
      throw fail(400, 'overpayment_choice_required', 'This is more than is due. Ask the patient: refund the difference, or keep it as account credit?', { dueCents: dueNow, overCents });
    }
    const paymentId = randomUUID();
    await tx.payment.create({
      data: { id: paymentId, patientId: a.patientId, collectedOn: toDateOnly(today), receivedAt: now, recordedById: actor.accountId, tender: pay.tender,
        amountCents: pay.amountCents, reference: tenderFields!.reference, note: tenderFields!.note, batchId },
    });
    const { allocations } = allocateOldestFirst(charges.map((c) => ({ id: c.id, outstandingCents: c.outstandingCents })), pay.amountCents - overCents);
    for (const x of allocations) await tx.paymentAllocation.create({ data: { paymentId, revenueEventId: x.id, amountCents: x.cents } });
    let refund: { id: string; tender: Tender; amountCents: number } | null = null;
    let toCredit = 0;
    if (overCents > 0 && a.overpayment!.as === 'REFUND') {
      const choice = a.overpayment as { tender?: Tender; note?: string | null };
      const tender = choice.tender ?? pay.tender;
      // "Other" needs a note saying how the difference was handed back — the same rule as a payment's tender.
      const { note: refundNote } = checkTender({ tender, note: choice.note }, 'refund');
      const id = randomUUID();
      await tx.refund.create({ data: { id, patientId: a.patientId, source: 'OVERPAYMENT', paymentId, tender, amountCents: overCents, refundedOn: toDateOnly(today), refundedAt: now, recordedById: actor.accountId, note: refundNote } });
      await rec({ action: 'CREATE', resourceType: 'refund', resourceId: id, meta: { source: 'OVERPAYMENT', tender, paymentId } });
      refund = { id, tender, amountCents: overCents };
    } else if (overCents > 0) {
      await tx.accountCreditEntry.create({ data: { patientId: a.patientId, kind: 'OVERPAYMENT', deltaCents: overCents, paymentId, entryOn: toDateOnly(today), createdById: actor.accountId } });
      await rec({ action: 'CREATE', resourceType: 'account_credit', resourceId: a.patientId, meta: { kind: 'OVERPAYMENT', paymentId } });
      toCredit = overCents;
    }
    await rec({ action: 'CREATE', resourceType: 'payment', resourceId: paymentId, meta: {
      tender: pay.tender, allocations: allocations.length, partial: pay.amountCents < dueNow, overpayment: overCents > 0 ? a.overpayment!.as : null, batchId,
    } });
    payment = { id: paymentId, tender: pay.tender, amountCents: pay.amountCents, collectedOn: today, allocations: allocations.map((x) => ({ revenueEventId: x.id, cents: x.cents })), refund, toAccountCreditCents: toCredit };
  }

  return {
    batchId, visits, charges: checkedOutCharges, accountCreditApplied, payment,
    balanceCents: await balanceOf(tx, a.patientId), accountCreditCents: await accountCreditOf(tx, a.patientId), recordedAt: now.toISOString(),
  };
}

/** Run a money write with its idempotency key: a retry of the same request gets the stored answer; the record commits with the money. */
export async function idempotent<T>(
  tx: Tx, a: { key: string; scope: string; patientId: string; body: unknown; actor: string },
  run: () => Promise<T>,
): Promise<{ replay: boolean; body: unknown }> {
  const hash = requestHash(a.body);
  const prior = await priorAnswer(tx, a.key, a.scope, a.patientId, hash);
  if (prior) return { replay: true, body: prior.body };
  const result = await run();
  const body = JSON.parse(JSON.stringify(result)) as unknown;
  await remember(tx, { key: a.key, scope: a.scope, patientId: a.patientId, hash, actor: a.actor, body });
  return { replay: false, body };
}

// ---- reversing a payment (decision 6) ------------------------------------------------------------------------------------------

export async function reversePayment(tx: Tx, rec: Rec, actor: Actor, now: Date, a: {
  patientId: string; paymentId: string; expectedVersion: string; reason: ReversalReasonCode; note?: string | null; deskMayReverse: boolean;
}) {
  const today = clinicDay(now);
  await lockPatient(tx, a.patientId);
  await assertPatient(tx, a.patientId);
  const p = await tx.payment.findFirst({ where: { id: a.paymentId, patientId: a.patientId }, include: { reversal: true, refunds: true } });
  if (!p) throw fail(404, 'unknown_payment', 'Unknown payment.');
  if (p.reversal) throw fail(409, 'already_reversed', 'This payment has already been reversed.');
  await assertVersion(tx, a.patientId, today, a.expectedVersion);
  // Decision 6: the front desk on the payment's own clinic day; after that, an admin on an MFA-verified session.
  const sameDay = p.collectedOn.toISOString().slice(0, 10) === today;
  if (!actor.mfaAdmin && !(sameDay && a.deskMayReverse)) {
    throw fail(403, 'reversal_needs_admin', 'A payment can be reversed by the front desk only on the day it was taken. After that, an administrator must reverse it.');
  }
  if (p.refunds.length) throw fail(409, 'payment_refunded', 'Part of this payment was already handed back as a refund, so it cannot be reversed here.');
  const note = a.note?.trim() || null;
  if (a.reason === 'OTHER' && !note) throw fail(400, 'reversal_note_required', 'Say why, in a few words, when the reason is "Other".');
  if (note && note.length > 200) throw fail(400, 'note_too_long', 'Keep the note to 200 characters.');
  if (looksLikeCardNumber(note)) throw fail(400, 'card_number_refused', 'That looks like a card number. Card details are never recorded here.');

  // The account credit this payment created goes back too — refused if the patient has since used it.
  const fromIt = await tx.accountCreditEntry.aggregate({ where: { paymentId: p.id, kind: 'OVERPAYMENT' }, _sum: { deltaCents: true } });
  const credit = fromIt._sum.deltaCents ?? 0;
  if (credit > 0 && (await accountCreditOf(tx, a.patientId)) < credit) {
    throw fail(409, 'account_credit_used', 'The account credit this payment created has already been used, so the payment cannot be reversed here.');
  }
  const reversalId = randomUUID();
  await tx.paymentReversal.create({ data: { id: reversalId, paymentId: p.id, reason: a.reason, note, reversedById: actor.accountId, reversedAt: now, reversedOn: toDateOnly(today) } });
  if (credit > 0) {
    await tx.accountCreditEntry.create({ data: { patientId: a.patientId, kind: 'REVERSED', deltaCents: -credit, paymentId: p.id, reversalId, entryOn: toDateOnly(today), createdById: actor.accountId } });
  }
  await rec({ action: 'CREATE', resourceType: 'payment_reversal', resourceId: reversalId, meta: { paymentId: p.id, reason: a.reason, sameDay, byAdmin: actor.mfaAdmin } });
  return { reversalId, paymentId: p.id, reversedOn: today, balanceCents: await balanceOf(tx, a.patientId), accountCreditCents: await accountCreditOf(tx, a.patientId) };
}

// ---- an admin refunds account credit (decision 4) ----------------------------------------------------------------------------

export async function refundAccountCredit(tx: Tx, rec: Rec, actor: Actor, now: Date, a: {
  patientId: string; expectedVersion: string; amountCents: number; tender: Tender; note?: string | null;
}) {
  if (!actor.mfaAdmin) throw fail(403, 'admin_required', 'Only an administrator can refund account credit.');
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw fail(400, 'bad_amount', 'A refund is a whole number of cents above zero.');
  const today = clinicDay(now);
  await lockPatient(tx, a.patientId);
  await assertPatient(tx, a.patientId);
  await assertVersion(tx, a.patientId, today, a.expectedVersion);
  const { note } = checkTender({ tender: a.tender, note: a.note }, 'refund');
  const have = await accountCreditOf(tx, a.patientId);
  if (a.amountCents > have) throw fail(409, 'account_credit_insufficient', 'That is more account credit than the patient has.', { accountCreditCents: have });
  const refundId = randomUUID();
  await tx.refund.create({ data: { id: refundId, patientId: a.patientId, source: 'ACCOUNT_CREDIT', tender: a.tender, amountCents: a.amountCents, refundedOn: toDateOnly(today), refundedAt: now, recordedById: actor.accountId, note } });
  await tx.accountCreditEntry.create({ data: { patientId: a.patientId, kind: 'REFUNDED', deltaCents: -a.amountCents, refundId, entryOn: toDateOnly(today), createdById: actor.accountId } });
  await rec({ action: 'CREATE', resourceType: 'refund', resourceId: refundId, meta: { source: 'ACCOUNT_CREDIT', tender: a.tender } });
  return { refundId, refundedOn: today, accountCreditCents: await accountCreditOf(tx, a.patientId), balanceCents: await balanceOf(tx, a.patientId) };
}

/** Prisma's unique-violation code, for the idempotency race (two identical requests at once). */
export const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
