/**
 * Check-out: settle the visit and finish it, in ONE transaction.
 *
 * A visit is paid one of three ways:
 *   CREDITS — a member redeems the service's credit cost (oldest lot first);
 *   PERK    — a member uses an included perk (monthly shot or IV, quarterly body composition, …);
 *   CASH    — paid at the desk. The price is RECORDED; nothing is processed or charged here.
 * Whichever it is, exactly one RevenueEvent row is written (service, price, member/cash, encounter),
 * the credits or perk are taken, and the encounter becomes CHECKED_OUT — all or nothing.
 *
 * Idempotent: a second submit for the same visit (a double click, a retry) changes nothing and
 * returns what was recorded the first time. The unique RevenueEvent.encounterId is the backstop.
 *
 * Lock order: Booking (lockedBooking) → Patient (lockPatient) → Membership (usePerk).
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { lockedBooking, checkOut } from './encounters.js';
import { toLocalDateISO } from './time.js';
import { balance, clinicDay, CreditError, lockPatient, perkStates, takeCredits, usePerk, type PerkState } from './credits.js';
import { openMembership } from './membership.js';
import { adjustmentRefusal, betterOf, deskAdjustmentCap, looksLikeCardNumber } from './moneyMath.js';
import { promotionsFor } from './promotions.js';
import type { Rec } from './staffTx.js';
import { SUPPLEMENTS_CATEGORY_CODE } from './discountConfig.js';
import { visitProviderId } from './visitProvider.js';

type Tx = Prisma.TransactionClient;
const fail = (status: 400 | 404 | 409, code: string, message: string, extra: Record<string, unknown> = {}) => new CreditError(status, code, message, extra);

export type PaymentChoice =
  | { payment: 'CREDITS' }
  | { payment: 'PERK'; perkId: string }
  /**
   * `priceCents` is the LIST price, and only for a service that has none of its own (peptide
   * therapy); a member discount comes off it. `expectedNetCents` is the net the desk was shown:
   * if the server works out something different (the membership changed since the screen opened)
   * it refuses rather than record a figure the desk did not see.
   */
  | { payment: 'CASH'; priceCents?: number; expectedNetCents?: number };

/**
 * A one-off adjustment at check-out (rev 2.2, decision 3): a reason code always; a note required for OTHER; never in the audit log.
 * Positive `cents` takes money off (the desk within its cap). Negative raises the price above list — an admin only (rev 2.3, decision 5).
 */
export interface AdjustmentInput { cents: number; reason: AdjustmentReasonCode; note?: string | null }
export type AdjustmentReasonCode = 'SERVICE_RECOVERY' | 'PRICE_MATCH' | 'COURTESY' | 'BILLING_ERROR' | 'OTHER' | 'EXTENDED_SERVICE';
/** The reasons for taking money off, and for raising a price above list. */
export const REDUCTION_REASONS: readonly AdjustmentReasonCode[] = ['SERVICE_RECOVERY', 'PRICE_MATCH', 'COURTESY', 'BILLING_ERROR', 'OTHER'];
export const INCREASE_REASONS: readonly AdjustmentReasonCode[] = ['BILLING_ERROR', 'EXTENDED_SERVICE', 'OTHER'];

/**
 * The adjustment rules, for a visit and for an add-on line alike: returns what to record, or refuses. `listCents` is the line's list
 * price; `afterDiscountsCents` what is left after the tier discount or promotion.
 */
export function checkAdjustment(adj: AdjustmentInput, a: { listCents: number; afterDiscountsCents: number; byAdmin: boolean }): { cents: number; reason: AdjustmentReasonCode; note: string | null } {
  const why = adjustmentRefusal({ listCents: a.listCents, afterDiscountsCents: a.afterDiscountsCents, cents: adj.cents, byAdmin: a.byAdmin });
  if (why === 'bad_amount') throw fail(400, 'bad_adjustment', 'An adjustment is a whole number of cents, not zero.');
  if (why === 'adjustment_too_large') throw fail(400, 'adjustment_too_large', 'An adjustment cannot take a visit below zero.', { maxCents: a.afterDiscountsCents });
  if (why === 'adjustment_needs_admin') {
    throw new CreditError(403 as never, 'adjustment_needs_admin', 'The front desk may adjust a visit by at most 20% of its list price or $25.00, whichever is less. An administrator must make a larger adjustment.', { capCents: deskAdjustmentCap(a.listCents) });
  }
  if (why === 'increase_needs_admin') throw new CreditError(403 as never, 'increase_needs_admin', 'Only an administrator can raise a price above its list price.');
  if (adj.cents < 0 && !INCREASE_REASONS.includes(adj.reason)) throw fail(400, 'bad_adjustment_reason', 'A price increase needs its own reason: billing error, extended service, or other.');
  if (adj.cents > 0 && !REDUCTION_REASONS.includes(adj.reason)) throw fail(400, 'bad_adjustment_reason', 'That reason is for a price increase, not a reduction.');
  const note = adj.note?.trim() || null;
  if (adj.reason === 'OTHER' && !note) throw fail(400, 'adjustment_note_required', 'Say why, in a few words, when the reason is "Other".');
  if (note && note.length > 200) throw fail(400, 'adjustment_note_too_long', 'Keep the note to 200 characters.');
  if (looksLikeCardNumber(note)) throw fail(400, 'card_number_refused', 'That looks like a card number. Card details are never recorded here.');
  return { cents: adj.cents, reason: adj.reason, note };
}

export interface CheckoutSummary {
  /** The charge this check-out recorded. */
  revenueEventId: string;
  paymentType: 'MEMBER' | 'CASH';
  memberBenefit: 'CREDITS' | 'PERK' | null;
  /** What the visit is worth at list price, before any discount. */
  listPriceCents: number | null;
  /** The tier's discount that applied (0 unless an active member paid cash), and what it took off. */
  discountPercent: number;
  discountCents: number;
  /** The promotion that applied instead of the tier discount (never both, decision 1). */
  promotion: { id: string; name: string; cents: number } | null;
  /** The one-off adjustment taken off, and its reason. */
  adjustmentCents: number;
  adjustmentReason: AdjustmentInput['reason'] | null;
  /** What the patient owes in money: list − discount − promotion − adjustment for cash, 0 when the membership covered it. */
  netPriceCents: number;
  creditsRedeemed: number;
  /** The patient's spendable credits before and after (null when there is no patient record). */
  balanceBefore: number | null;
  balanceAfter: number | null;
  perkLabel: string | null;
  planName: string | null;
  recordedAt: string;
  /** True when this call found the visit already checked out and changed nothing. */
  alreadyCheckedOut: boolean;
}

/** What the visit is worth at list price: the chosen option's price, else the service's. */
function listPrice(service: { priceCents: number | null; options: Array<{ label: string; priceCents: number }> }, subOption: string | null): number | null {
  const opt = subOption ? service.options.find((o) => o.label === subOption) : undefined;
  return opt?.priceCents ?? service.priceCents ?? null;
}

/** What an ACTIVE member of `planId` gets off the list price of a service in this category: the tier's percent for it, else 0. */
export async function categoryDiscount(
  tx: Tx, planId: string,
  category: { id: string; code: string; name: string; active: boolean } | null,
): Promise<{ percent: number; code: string | null; name: string | null }> {
  if (!category || !category.active) return { percent: 0, code: null, name: null };
  // One place for supplements (rev 2.3 review): this category reads the member discount on products.
  if (category.code === SUPPLEMENTS_CATEGORY_CODE) {
    const shared = await tx.planProductDiscount.findUnique({ where: { planId } });
    return { percent: shared?.percent ?? 0, code: category.code, name: category.name };
  }
  const row = await tx.planCategoryDiscount.findUnique({ where: { planId_categoryId: { planId, categoryId: category.id } } });
  return { percent: row?.percent ?? 0, code: category.code, name: category.name };
}

export const SERVICE_INCLUDE = {
  options: { select: { label: true, priceCents: true } },
  discountCategory: { select: { id: true, code: true, name: true, active: true } },
} as const;

async function loadVisit(tx: Tx, bookingId: string) {
  return tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      encounter: true,
      service: { include: SERVICE_INCLUDE },
    },
  });
}

/**
 * `adjustment`, `byAdmin` and `batchId` come from the combined check-out (lib/money.ts): an adjustment is allowed only on a visit paid in
 * money, up to the desk's cap unless `byAdmin` (an admin on an MFA-verified session).
 */
export async function checkoutVisit(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; now: Date; adjustment?: AdjustmentInput | null; byAdmin?: boolean; batchId?: string | null } & PaymentChoice): Promise<CheckoutSummary> {
  const locked = await lockedBooking(tx, a.bookingId);                // 1. the Booking row
  const enc = locked.encounter;
  if (!enc || enc.status === 'SCHEDULED' || enc.status === 'NO_SHOW') throw fail(409, 'not_checked_in', 'This patient has not been checked in.');

  const existing = await tx.revenueEvent.findUnique({ where: { encounterId: enc.id } });
  if (enc.status === 'CHECKED_OUT') {
    if (!existing) throw fail(409, 'checked_out_without_record', 'This visit was checked out before check-out recorded a payment, so there is nothing to add to.');
    return summarise(tx, existing, true);
  }
  if (existing) throw fail(409, 'already_recorded', 'A payment is already recorded for this visit.');
  if (a.adjustment && a.payment !== 'CASH') throw fail(400, 'adjustment_only_for_money', 'An adjustment applies only to a visit paid in money, not with credits or a perk.');

  const b = await loadVisit(tx, a.bookingId);
  const patientId = b.patientId;
  const today = clinicDay(a.now);
  const price = listPrice(b.service, b.subOption);
  const eventId = randomUUID();

  let balanceBefore: number | null = null;
  let balanceAfter: number | null = null;
  let membership: Awaited<ReturnType<typeof openMembership>> = null;
  if (patientId) {
    await lockPatient(tx, patientId);                                  // 2. the Patient row
    membership = await openMembership(tx, patientId);
    balanceBefore = await balance(tx, patientId, today);
    balanceAfter = balanceBefore;
  }

  let paymentType: 'MEMBER' | 'CASH' = 'CASH';
  let memberBenefit: 'CREDITS' | 'PERK' | null = null;
  let credits = 0;
  let discountPercent = 0;
  let discountCategory: string | null = null;
  let discountCents = 0;
  let promotion: { id: string; name: string; cents: number } | null = null;
  let adjustmentCents = 0;
  let netCents = 0;
  let recordedPrice = price;
  let perk: PerkState | null = null;

  if (a.payment === 'CREDITS') {
    if (!patientId) throw fail(409, 'no_patient', 'Link this visit to a patient record before using credits.');
    const cost = b.service.creditCost;
    if (cost == null) throw fail(409, 'not_credit_eligible', `${b.service.name} cannot be paid with Wellness Credits.`);
    const taken = await takeCredits(tx, rec, { patientId, amount: cost, reason: 'REDEMPTION', today, now: a.now, actorAccountId: a.accountId, encounterId: enc.id, revenueEventId: eventId }); // 3. the ledger
    paymentType = 'MEMBER'; memberBenefit = 'CREDITS'; credits = cost; balanceAfter = taken.after;
  } else if (a.payment === 'PERK') {
    if (!patientId) throw fail(409, 'no_patient', 'Link this visit to a patient record before using a perk.');
    if (!membership || membership.status !== 'ACTIVE') throw fail(409, 'membership_not_active', 'Perks are available only to a patient with an active membership.');
    const covers = await tx.planPerkService.findFirst({ where: { perkId: a.perkId, serviceId: b.serviceId, perk: { planId: membership.planId, active: true } } });
    if (!covers) throw fail(409, 'perk_not_for_service', `That perk does not cover ${b.service.name}.`);
    perk = await usePerk(tx, rec, { membershipId: membership.id, perkId: a.perkId, patientId, today, now: a.now, actorAccountId: a.accountId, revenueEventId: eventId });
    paymentType = 'MEMBER'; memberBenefit = 'PERK';
  } else {
    if (price == null) {
      if (a.priceCents == null) throw fail(400, 'price_required', 'This service has no set price — enter the amount before any member discount.', { priceKnown: false });
      recordedPrice = a.priceCents;
    } else if (a.priceCents != null && a.priceCents !== price) {
      throw fail(400, 'price_mismatch', 'That is not this service\'s price. Prices are changed by an administrator.', { priceCents: price });
    }
    if (recordedPrice == null || !Number.isInteger(recordedPrice) || recordedPrice <= 0) throw fail(400, 'bad_price', 'Enter the amount as a whole number of cents above zero.');
    // Only an ACTIVE member is discounted (paused and cancelled are not), and only on what they pay in money: credits and perks are
    // not priced in dollars. The tier's percent is for the service's CATEGORY. A promotion for the service, by the VISIT's clinic date
    // (decision 2), applies instead when it is better for the patient — never both (decision 1).
    const found = membership?.status === 'ACTIVE' ? await categoryDiscount(tx, membership.planId, b.service.discountCategory) : { percent: 0, code: null, name: null };
    const promos = await promotionsFor(tx, b.serviceId, toLocalDateISO(b.startTime));
    const red = betterOf(recordedPrice, found.percent, promos);
    discountPercent = red.discountPercent;
    discountCents = red.discountCents;
    discountCategory = red.discountCents > 0 ? found.code : null;
    if (red.promotionId) promotion = { id: red.promotionId, name: promos.find((p) => p.id === red.promotionId)!.name, cents: red.promotionCents };
    const afterDiscounts = recordedPrice - discountCents - (promotion?.cents ?? 0);
    if (a.adjustment) adjustmentCents = checkAdjustment(a.adjustment, { listCents: recordedPrice, afterDiscountsCents: afterDiscounts, byAdmin: !!a.byAdmin }).cents;
    netCents = afterDiscounts - adjustmentCents;
    if (a.expectedNetCents != null && a.expectedNetCents !== netCents) {
      throw fail(409, 'price_changed', 'The price changed since this screen opened (the membership, its discount or a promotion was edited). Review the new amount and check out again.',
        { listPriceCents: recordedPrice, discountPercent, discountCents, promotionCents: promotion?.cents ?? 0, adjustmentCents, netPriceCents: netCents });
    }
  }

  const row = await tx.revenueEvent.create({
    data: {
      id: eventId, encounterId: enc.id, bookingId: b.id, patientId, serviceId: b.serviceId,
      serviceName: b.service.name, serviceCategory: b.service.category, subOption: b.subOption,
      listPriceCents: recordedPrice, paymentType, memberBenefit, creditsRedeemed: credits,
      // The visit's provider (rev 2.1): the covering provider when one saw the patient, else the one it was booked with.
      discountPercent, discountCents, netPriceCents: netCents, discountCategory, staffId: visitProviderId(b),
      promotionId: promotion?.id ?? null, promotionCents: promotion?.cents ?? 0,
      adjustmentCents, adjustmentReason: adjustmentCents !== 0 ? a.adjustment!.reason : null,
      adjustmentNote: adjustmentCents !== 0 ? (a.adjustment!.note?.trim() || null) : null, adjustedById: adjustmentCents !== 0 ? a.accountId : null,
      batchId: a.batchId ?? null,
      planCode: membership && (paymentType === 'MEMBER' || membership.status === 'ACTIVE') ? membership.plan.code : null,
      occurredAt: a.now, recordedById: a.accountId,
    },
  });
  // Ids, codes and counts only — no amounts and no note text (rev 2.2 hard rule): the figures are on the row itself.
  await rec({ action: 'CREATE', resourceType: 'revenue_event', resourceId: row.id, meta: {
    paymentType, memberBenefit, credits, discountCategory, tierDiscount: discountCents > 0, promotionId: promotion?.id ?? null,
    adjustmentReason: adjustmentCents !== 0 ? a.adjustment!.reason : null, batchId: a.batchId ?? null,
  } });

  await checkOut(tx, rec, { bookingId: a.bookingId, accountId: a.accountId, now: a.now });

  return {
    revenueEventId: row.id, promotion, adjustmentCents, adjustmentReason: adjustmentCents !== 0 ? a.adjustment!.reason : null,
    paymentType, memberBenefit, listPriceCents: recordedPrice, discountPercent, discountCents, netPriceCents: netCents, creditsRedeemed: credits,
    balanceBefore, balanceAfter, perkLabel: perk?.label ?? null,
    planName: membership?.plan.name ?? null, recordedAt: a.now.toISOString(), alreadyCheckedOut: false,
  };
}

async function summarise(tx: Tx, e: Prisma.RevenueEventGetPayload<object>, alreadyCheckedOut: boolean): Promise<CheckoutSummary> {
  const perk = e.memberBenefit === 'PERK' ? await tx.perkUsage.findFirst({ where: { revenueEventId: e.id }, include: { perk: { select: { label: true } } } }) : null;
  const promo = e.promotionId ? await tx.promotion.findUnique({ where: { id: e.promotionId }, select: { name: true } }) : null;
  return {
    revenueEventId: e.id, promotion: e.promotionId ? { id: e.promotionId, name: promo?.name ?? '', cents: e.promotionCents } : null,
    adjustmentCents: e.adjustmentCents, adjustmentReason: e.adjustmentReason,
    // Found by its encounter, so never dues (the RevenueEvent_kind CHECK: dues have no visit).
    paymentType: e.paymentType as 'MEMBER' | 'CASH', memberBenefit: e.memberBenefit, listPriceCents: e.listPriceCents, discountPercent: e.discountPercent,
    discountCents: e.discountCents, netPriceCents: e.netPriceCents, creditsRedeemed: e.creditsRedeemed,
    balanceBefore: null, balanceAfter: null, perkLabel: perk?.perk.label ?? null,
    planName: null, recordedAt: e.occurredAt.toISOString(), alreadyCheckedOut,
  };
}

// ---- the check-out screen's read ----------------------------------------------------------------

export interface CheckoutPreview {
  alreadyCheckedOut: boolean;
  service: { id: string; name: string; category: string; subOption: string | null };
  listPriceCents: number | null;
  priceNote: string | null;
  creditCost: number | null;
  patient: { id: string; name: string } | null;
  membership: { planCode: string; planName: string; status: string } | null;
  /** Spendable credits now; null with no patient record. */
  balance: number | null;
  credits: { available: boolean; cost: number | null; balanceAfter: number | null; reason: string | null };
  perks: Array<{ perkId: string; label: string; remaining: number; period: string }>;
  cash: {
    /** The list price (what a non-member pays). */
    priceCents: number | null;
    priceKnown: boolean;
    /** The member discount that WOULD apply to cash (0 for a non-member, a paused membership, or a service in no discounted category). */
    discountPercent: number;
    /** Which category it comes from (its name), when one applies. */
    discountCategory: string | null;
    discountCents: number | null;
    /** What the patient owes after the discount or promotion; null while the amount is still to be entered. */
    netPriceCents: number | null;
    /** Rev 2.2. The member's tier percent for this service before the better-of rule (the applied one is `discountPercent`). */
    tierPercent: number;
    /** The promotion that applies instead of the tier discount, when it is better for the patient (never both). */
    promotion: { id: string; name: string; cents: number } | null;
    /** Every promotion this visit qualifies for (by its clinic date), so a price typed at the desk is priced the same way. */
    promotions: Array<{ id: string; name: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number }>;
    /** The most the front desk may adjust this visit by (decision 3); an admin may go further. Null while the price is unknown. */
    adjustmentCapCents: number | null;
  };
}

export async function checkoutPreview(tx: Tx, bookingId: string, now: Date): Promise<CheckoutPreview | null> {
  const b = await tx.booking.findUnique({
    where: { id: bookingId },
    include: {
      encounter: { select: { id: true, status: true } },
      service: { include: SERVICE_INCLUDE },
      patient: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!b) return null;
  const today = clinicDay(now);
  const price = listPrice(b.service, b.subOption);
  const done = b.encounter?.status === 'CHECKED_OUT';

  let bal: number | null = null;
  let membership: Awaited<ReturnType<typeof openMembership>> = null;
  if (b.patientId) {
    bal = await balance(tx, b.patientId, today);
    membership = await openMembership(tx, b.patientId);
  }
  const cost = b.service.creditCost;
  let reason: string | null = null;
  if (!b.patientId) reason = 'Link a patient record to use credits.';
  else if (cost == null) reason = `${b.service.name} is not credit-eligible.`;
  else if ((bal ?? 0) < cost) reason = `Needs ${cost} credits; ${bal ?? 0} available.`;

  const perks: CheckoutPreview['perks'] = [];
  if (membership && membership.status === 'ACTIVE') {
    for (const p of await perkStates(tx, membership, today)) {
      if (p.serviceIds.includes(b.serviceId) && p.remaining > 0) perks.push({ perkId: p.perkId, label: p.label, remaining: p.remaining, period: p.period });
    }
  }
  const found = membership?.status === 'ACTIVE' ? await categoryDiscount(tx, membership.planId, b.service.discountCategory) : { percent: 0, code: null, name: null };
  const promos = await promotionsFor(tx, b.serviceId, toLocalDateISO(b.startTime));
  const red = price != null ? betterOf(price, found.percent, promos) : null;
  const promotion = red?.promotionId ? { id: red.promotionId, name: promos.find((p) => p.id === red.promotionId)!.name, cents: red.promotionCents } : null;
  // With the price still to be typed, the tier percent is what would apply unless a promotion beats it; the screen prices it the same way.
  const discountPercent = red ? red.discountPercent : found.percent;
  return {
    alreadyCheckedOut: done,
    service: { id: b.service.id, name: b.service.name, category: b.service.category, subOption: b.subOption },
    listPriceCents: price, priceNote: b.service.priceNote, creditCost: cost,
    patient: b.patient ? { id: b.patient.id, name: `${b.patient.firstName} ${b.patient.lastName}` } : null,
    membership: membership ? { planCode: membership.plan.code, planName: membership.plan.name, status: membership.status } : null,
    balance: bal,
    credits: { available: reason === null, cost, balanceAfter: reason === null && bal != null && cost != null ? bal - cost : null, reason },
    perks,
    cash: {
      priceCents: price, priceKnown: price != null, discountPercent,
      discountCategory: discountPercent > 0 ? found.name : null,
      discountCents: red ? red.discountCents : null,
      netPriceCents: red && price != null ? price - red.discountCents - red.promotionCents : null,
      tierPercent: found.percent, promotion, promotions: promos.map((p) => ({ id: p.id, name: p.name, kind: p.kind, value: p.value })),
      adjustmentCapCents: price != null ? deskAdjustmentCap(price) : null,
    },
  };
}
