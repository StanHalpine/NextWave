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
import { balance, clinicDay, CreditError, lockPatient, perkStates, takeCredits, usePerk, type PerkState } from './credits.js';
import { openMembership } from './membership.js';
import { memberDiscount } from './pricing.js';
import type { Rec } from './staffTx.js';

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

export interface CheckoutSummary {
  paymentType: 'MEMBER' | 'CASH';
  memberBenefit: 'CREDITS' | 'PERK' | null;
  /** What the visit is worth at list price, before any discount. */
  listPriceCents: number | null;
  /** The tier's discount that applied (0 unless an active member paid cash), and what it took off. */
  discountPercent: number;
  discountCents: number;
  /** What the patient owes in money: list − discount for cash, 0 when the membership covered it. */
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
async function categoryDiscount(
  tx: Tx, planId: string,
  category: { id: string; code: string; name: string; active: boolean } | null,
): Promise<{ percent: number; code: string | null; name: string | null }> {
  if (!category || !category.active) return { percent: 0, code: null, name: null };
  const row = await tx.planCategoryDiscount.findUnique({ where: { planId_categoryId: { planId, categoryId: category.id } } });
  return { percent: row?.percent ?? 0, code: category.code, name: category.name };
}

const SERVICE_INCLUDE = {
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

export async function checkoutVisit(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; now: Date } & PaymentChoice): Promise<CheckoutSummary> {
  const locked = await lockedBooking(tx, a.bookingId);                // 1. the Booking row
  const enc = locked.encounter;
  if (!enc || enc.status === 'SCHEDULED' || enc.status === 'NO_SHOW') throw fail(409, 'not_checked_in', 'This patient has not been checked in.');

  const existing = await tx.revenueEvent.findUnique({ where: { encounterId: enc.id } });
  if (enc.status === 'CHECKED_OUT') {
    if (!existing) throw fail(409, 'checked_out_without_record', 'This visit was checked out before check-out recorded a payment, so there is nothing to add to.');
    return summarise(tx, existing, true);
  }
  if (existing) throw fail(409, 'already_recorded', 'A payment is already recorded for this visit.');

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
    // Only an ACTIVE member is discounted (paused and cancelled are not), and only on what they pay
    // in money: credits and perks are not priced in dollars, so there is nothing to take a percent of.
    // The percent is the member's TIER's for this service's CATEGORY; a service in no category is not discounted.
    const found = membership?.status === 'ACTIVE' ? await categoryDiscount(tx, membership.planId, b.service.discountCategory) : { percent: 0, code: null, name: null };
    discountPercent = found.percent;
    discountCategory = found.percent > 0 ? found.code : null;
    ({ discountCents, netCents } = memberDiscount(recordedPrice, discountPercent));
    if (a.expectedNetCents != null && a.expectedNetCents !== netCents) {
      throw fail(409, 'price_changed', 'The price changed since this screen opened (the membership or its discount was edited). Review the new amount and check out again.',
        { listPriceCents: recordedPrice, discountPercent, discountCents, netPriceCents: netCents });
    }
  }

  const row = await tx.revenueEvent.create({
    data: {
      id: eventId, encounterId: enc.id, bookingId: b.id, patientId, serviceId: b.serviceId,
      serviceName: b.service.name, serviceCategory: b.service.category, subOption: b.subOption,
      listPriceCents: recordedPrice, paymentType, memberBenefit, creditsRedeemed: credits,
      discountPercent, discountCents, netPriceCents: netCents, discountCategory, staffId: b.staffId,
      planCode: membership && (paymentType === 'MEMBER' || membership.status === 'ACTIVE') ? membership.plan.code : null,
      occurredAt: a.now, recordedById: a.accountId,
    },
  });
  await rec({ action: 'CREATE', resourceType: 'revenue_event', resourceId: row.id, meta: { paymentType, memberBenefit, credits, discountPercent, discountCategory, discountCents, netPriceCents: netCents } });

  await checkOut(tx, rec, { bookingId: a.bookingId, accountId: a.accountId, now: a.now });

  return {
    paymentType, memberBenefit, listPriceCents: recordedPrice, discountPercent, discountCents, netPriceCents: netCents, creditsRedeemed: credits,
    balanceBefore, balanceAfter, perkLabel: perk?.label ?? null,
    planName: membership?.plan.name ?? null, recordedAt: a.now.toISOString(), alreadyCheckedOut: false,
  };
}

async function summarise(tx: Tx, e: Prisma.RevenueEventGetPayload<object>, alreadyCheckedOut: boolean): Promise<CheckoutSummary> {
  const perk = e.memberBenefit === 'PERK' ? await tx.perkUsage.findFirst({ where: { revenueEventId: e.id }, include: { perk: { select: { label: true } } } }) : null;
  return {
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
    /** What the patient owes after the discount; null while the amount is still to be entered. */
    netPriceCents: number | null;
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
  const discountPercent = found.percent;
  const disc = price != null ? memberDiscount(price, discountPercent) : null;
  return {
    alreadyCheckedOut: done,
    service: { id: b.service.id, name: b.service.name, category: b.service.category, subOption: b.subOption },
    listPriceCents: price, priceNote: b.service.priceNote, creditCost: cost,
    patient: b.patient ? { id: b.patient.id, name: `${b.patient.firstName} ${b.patient.lastName}` } : null,
    membership: membership ? { planCode: membership.plan.code, planName: membership.plan.name, status: membership.status } : null,
    balance: bal,
    credits: { available: reason === null, cost, balanceAfter: reason === null && bal != null && cost != null ? bal - cost : null, reason },
    perks,
    cash: { priceCents: price, priceKnown: price != null, discountPercent, discountCategory: found.percent > 0 ? found.name : null, discountCents: disc?.discountCents ?? null, netPriceCents: disc?.netCents ?? null },
  };
}
