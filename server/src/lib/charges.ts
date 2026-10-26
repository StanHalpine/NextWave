/**
 * Charges (Phase 2c-A, SPEC rev 2.3; docs/CHARGES_DESIGN.md): add-on services and retail products, added in the Charges window as OPEN
 * lines and turned into charges at check-out.
 *
 *   an ADD-ON SERVICE  an existing Service offered as a quick-add (InBody = body composition): charged with NO booking, so it never
 *                      touches the schedule. Priced exactly as a booked visit of that service — its credit cost, its perks, its tier
 *                      discount category, its promotions — and never taxed.
 *   a PRODUCT          a retail item from the catalog (Product). Paid in money only (never credits or perks); the member tier discount
 *                      on products when it is marked eligible (PlanProductDiscount); promotions that name it; sales tax when taxable.
 *
 * An open line SNAPSHOTS its name, unit price and tax rate when it is added (decision 1): a catalog edit afterwards never changes it,
 * nor the charge it becomes. It has a QUANTITY (1 to 99, rev 2.3 review): a click on an item already open today, at the same price and
 * for the same performer, raises it rather than adding a second line; the price, any discount, adjustment and tax are worked out on the
 * line total (unit price × quantity), still rounded per line. A quantity change is an append-only OpenChargeQuantity row. Discounts and promotions are worked out at check-out, as for a visit — a promotion by the clinic day the
 * line was ADDED (the add-on's "visit date", rev 2.2 decision 2).
 *
 * Open lines are append-only: removing one adds a removal row; checking one out writes the RevenueEvent that names it (once — the
 * unique openChargeId). The database backs both (nw_open_charge_guard). Every lookup is scoped by the patient. Audit rows carry ids and
 * flags only — never a name, an amount or a note.
 */
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { balance, clinicDay, CreditError, fromDateOnly, lockPatient, perkStates, takeCredits, toDateOnly, usePerk, type PerkState } from './credits.js';
import { openMembership } from './membership.js';
import { betterOf, deskAdjustmentCap, taxOf } from './moneyMath.js';
import { promotionsFor, promotionsForProduct, type ApplicablePromotion } from './promotions.js';
import { categoryDiscount, checkAdjustment, type AdjustmentInput, type AdjustmentReasonCode } from './checkout.js';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;
type Status = 400 | 403 | 404 | 409;
const fail = (status: Status, code: string, message: string, extra: Record<string, unknown> = {}) => new CreditError(status as never, code, message, extra);

export const SALES_TAX_CODE = 'SALES';
/** What a product's tier discount is recorded as (RevenueEvent.discountCategory), so Accounting can tell it from a service category. */
export const PRODUCT_DISCOUNT_CODE = 'PRODUCTS';
export const ADD_ON_GROUP = 'Service add-ons';

type Membership = Awaited<ReturnType<typeof openMembership>>;
/** An open line with its newest quantity change, if any (WITH_QUANTITY). */
type OpenLine = Prisma.OpenChargeGetPayload<{ include: { quantities: true } }>;

/** The most units one line may carry. */
export const MAX_QUANTITY = 99;
/** Read an open line with its newest quantity change: its quantity is that, else the quantity it was added with. */
export const WITH_QUANTITY = { quantities: { orderBy: { id: 'desc' as const }, take: 1 } } as const;
export const quantityOf = (l: { quantity: number; quantities: Array<{ quantity: number }> }): number => l.quantities[0]?.quantity ?? l.quantity;

/** The clinic's sales-tax rate in thousandths of a percent (5.5% = 5500); 0 when none is set. */
export async function salesTaxRate(db: Pick<Tx, 'taxRate'>): Promise<number> {
  const r = await db.taxRate.findUnique({ where: { code: SALES_TAX_CODE }, select: { rateMilli: true } });
  return r?.rateMilli ?? 0;
}

// ---- the catalog: what the Charges window offers ---------------------------------------------------------------------------------

export interface CatalogItem {
  kind: 'SERVICE' | 'PRODUCT';
  id: string;
  name: string;
  group: string;
  priceCents: number;
  taxable: boolean;
}

/** The quick-add buttons, grouped: service add-ons first, then products by their group. Inactive products are not offered. */
export async function chargeCatalog(db: Pick<Tx, 'service' | 'product' | 'taxRate'>): Promise<{ groups: Array<{ name: string; items: CatalogItem[] }>; taxRateMilli: number }> {
  const services = await db.service.findMany({
    where: { offerAsAddOn: true, requiresNote: false, priceCents: { not: null } },
    select: { id: true, name: true, priceCents: true }, orderBy: { name: 'asc' },
  });
  const products = await db.product.findMany({ where: { active: true }, orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
  const groups: Array<{ name: string; items: CatalogItem[] }> = [];
  if (services.length) groups.push({ name: ADD_ON_GROUP, items: services.map((s) => ({ kind: 'SERVICE', id: s.id, name: s.name, group: ADD_ON_GROUP, priceCents: s.priceCents!, taxable: false })) });
  for (const p of products) {
    let g = groups.find((x) => x.name === p.category);
    if (!g) { g = { name: p.category, items: [] }; groups.push(g); }
    g.items.push({ kind: 'PRODUCT', id: p.id, name: p.name, group: p.category, priceCents: p.priceCents, taxable: p.taxable });
  }
  return { groups, taxRateMilli: await salesTaxRate(db) };
}

// ---- adding and removing open lines --------------------------------------------------------------------------------------------

export type ChargeItem = { serviceId: string } | { productId: string };

async function assertLivePatient(tx: Tx, patientId: string): Promise<void> {
  const p = await tx.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true } });
  if (!p) throw fail(404, 'unknown_patient', 'Unknown patient.');
}

/**
 * Add one line (one unit) to the patient's open charges. `bookingId` is the visit it was added from, when there is one (a provider's
 * workspace, the desk's card); `performedByStaffId` who performed an add-on service. Locks the patient, so it waits for a check-out
 * in progress and the check-out sees it or not — never half of it.
 */
export async function addOpenCharge(tx: Tx, rec: Rec, a: {
  patientId: string; item: ChargeItem; accountId: string; now: Date; performedByStaffId?: string | null; bookingId?: string | null;
}): Promise<{ id: string; quantity: number }> {
  await lockPatient(tx, a.patientId);
  await assertLivePatient(tx, a.patientId);
  let snap: { serviceId: string | null; productId: string | null; name: string; category: string; unitPriceCents: number; taxRateMilli: number };
  if ('serviceId' in a.item) {
    const s = await tx.service.findUnique({ where: { id: a.item.serviceId }, select: { id: true, name: true, category: true, priceCents: true, offerAsAddOn: true, requiresNote: true } });
    if (!s || !s.offerAsAddOn) throw fail(404, 'unknown_item', 'That is not on the Charges menu.');
    // An add-on has no encounter, so nothing to write a note against: a service that needs one is booked as a visit (A-36).
    if (s.requiresNote) throw fail(409, 'needs_a_visit', `${s.name} needs a signed note, so it is booked as a visit, not added as a charge.`);
    if (s.priceCents == null) throw fail(409, 'no_price', `${s.name} has no set price, so it cannot be a quick-add.`);
    // A service is never taxed (decision 2).
    snap = { serviceId: s.id, productId: null, name: s.name, category: s.category, unitPriceCents: s.priceCents, taxRateMilli: 0 };
  } else {
    const p = await tx.product.findUnique({ where: { id: a.item.productId } });
    if (!p || !p.active) throw fail(404, 'unknown_item', 'That product is not on the Charges menu.');
    snap = { serviceId: null, productId: p.id, name: p.name, category: p.category, unitPriceCents: p.priceCents, taxRateMilli: p.taxable ? await salesTaxRate(tx) : 0 };
  }
  if (a.performedByStaffId) {
    if (!snap.serviceId) throw fail(400, 'performer_only_for_services', 'Only a service has someone who performed it.');
    const st = await tx.staff.findFirst({ where: { id: a.performedByStaffId, active: true }, select: { id: true } });
    if (!st) throw fail(400, 'unknown_staff', 'Unknown staff member.');
  }
  if (a.bookingId) {
    const b = await tx.booking.findFirst({ where: { id: a.bookingId, patientId: a.patientId }, select: { id: true } });
    if (!b) throw fail(404, 'unknown_visit', 'That visit does not belong to this patient.');
  }
  // The same item already open today, at the same snapshots and for the same performer: one more unit on that line, not a second line.
  const addedOn = toDateOnly(clinicDay(a.now));
  const same = (await tx.openCharge.findMany({
    where: {
      patientId: a.patientId, serviceId: snap.serviceId, productId: snap.productId, name: snap.name, unitPriceCents: snap.unitPriceCents,
      taxRateMilli: snap.taxRateMilli, addedOn, performedByStaffId: a.performedByStaffId ?? null, removal: { is: null }, charge: { is: null },
    },
    include: WITH_QUANTITY, orderBy: [{ addedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  }))[0];
  if (same) {
    const quantity = quantityOf(same) + 1;
    if (quantity > MAX_QUANTITY) throw fail(409, 'quantity_max', `A line holds at most ${MAX_QUANTITY}.`);
    await tx.openChargeQuantity.create({ data: { openChargeId: same.id, quantity, changedById: a.accountId, changedAt: a.now } });
    await rec({ action: 'UPDATE', resourceType: 'open_charge', resourceId: same.id, meta: { fields: ['quantity'], quantity, fromVisit: !!a.bookingId } });
    return { id: same.id, quantity };
  }
  const id = randomUUID();
  await tx.openCharge.create({
    data: {
      id, patientId: a.patientId, ...snap, addedOn, addedAt: a.now, addedById: a.accountId,
      performedByStaffId: a.performedByStaffId ?? null, bookingId: a.bookingId ?? null,
    },
  });
  await rec({ action: 'CREATE', resourceType: 'open_charge', resourceId: id, meta: {
    kind: snap.productId ? 'PRODUCT' : 'SERVICE', itemId: snap.productId ?? snap.serviceId, fromVisit: !!a.bookingId, performer: !!a.performedByStaffId,
  } });
  return { id, quantity: 1 };
}

/** Set an open line's quantity (1 to 99) before check-out: an append-only change row. To take a line off entirely, remove it. */
export async function setOpenChargeQuantity(tx: Tx, rec: Rec, a: { patientId: string; openChargeId: string; quantity: number; accountId: string; now: Date; bookingId?: string | null }): Promise<{ id: string; quantity: number }> {
  if (!Number.isInteger(a.quantity) || a.quantity < 1 || a.quantity > MAX_QUANTITY) throw fail(400, 'bad_quantity', `A quantity is a whole number from 1 to ${MAX_QUANTITY}. To take the item off, remove it.`);
  await lockPatient(tx, a.patientId);
  await assertLivePatient(tx, a.patientId);
  const oc = await tx.openCharge.findFirst({ where: { id: a.openChargeId, patientId: a.patientId }, include: { removal: true, charge: { select: { id: true } }, ...WITH_QUANTITY } });
  if (!oc) throw fail(404, 'unknown_charge', 'Unknown charge.');
  if (oc.removal) throw fail(409, 'already_removed', 'That item was removed.');
  if (oc.charge) throw fail(409, 'already_checked_out', 'That item has been checked out; it is a charge now.');
  if (quantityOf(oc) === a.quantity) return { id: oc.id, quantity: a.quantity };
  await tx.openChargeQuantity.create({ data: { openChargeId: oc.id, quantity: a.quantity, changedById: a.accountId, changedAt: a.now } });
  await rec({ action: 'UPDATE', resourceType: 'open_charge', resourceId: oc.id, meta: { fields: ['quantity'], quantity: a.quantity, fromVisit: !!a.bookingId } });
  return { id: oc.id, quantity: a.quantity };
}

/** Remove an open line before check-out (decision 4): a removal row, never a delete. Refused once it has been checked out. */
export async function removeOpenCharge(tx: Tx, rec: Rec, a: { patientId: string; openChargeId: string; accountId: string; now: Date; bookingId?: string | null }): Promise<{ id: string }> {
  await lockPatient(tx, a.patientId);
  await assertLivePatient(tx, a.patientId);
  const oc = await tx.openCharge.findFirst({ where: { id: a.openChargeId, patientId: a.patientId }, include: { removal: true, charge: { select: { id: true } } } });
  if (!oc) throw fail(404, 'unknown_charge', 'Unknown charge.');
  if (oc.removal) throw fail(409, 'already_removed', 'That item was already removed.');
  if (oc.charge) throw fail(409, 'already_checked_out', 'That item has been checked out; it is a charge now and is not removed here.');
  await tx.openChargeRemoval.create({ data: { openChargeId: oc.id, removedById: a.accountId, removedAt: a.now } });
  await rec({ action: 'DELETE', resourceType: 'open_charge', resourceId: oc.id, meta: { by: 'removal_row', fromVisit: !!a.bookingId } });
  return { id: oc.id };
}

/** The patient's open lines (not removed, not checked out), oldest first — by when added, then when written (two in one instant). */
export function openChargesOf(db: Pick<Tx, 'openCharge'>, patientId: string): Promise<OpenLine[]> {
  return db.openCharge.findMany({ where: { patientId, removal: { is: null }, charge: { is: null } }, include: WITH_QUANTITY, orderBy: [{ addedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
}

// ---- pricing a line ------------------------------------------------------------------------------------------------------------

/** The member tier percent for this line: the service's discount category, or — for an eligible product — the tier's product percent. */
async function tierFor(tx: Tx, line: OpenLine, membership: Membership): Promise<{ percent: number; code: string | null; name: string | null }> {
  if (!membership || membership.status !== 'ACTIVE') return { percent: 0, code: null, name: null };
  if (line.serviceId) {
    const s = await tx.service.findUnique({ where: { id: line.serviceId }, select: { discountCategory: { select: { id: true, code: true, name: true, active: true } } } });
    return categoryDiscount(tx, membership.planId, s?.discountCategory ?? null);
  }
  const p = await tx.product.findUnique({ where: { id: line.productId! }, select: { tierDiscount: true } });
  if (!p?.tierDiscount) return { percent: 0, code: null, name: null };
  const row = await tx.planProductDiscount.findUnique({ where: { planId: membership.planId } });
  return { percent: row?.percent ?? 0, code: PRODUCT_DISCOUNT_CODE, name: 'Products' };
}

/**
 * The promotions a line qualifies for, as they apply to THAT line. On a PRODUCT a fixed-amount promotion comes off per unit — "$5 off" on
 * a quantity of 2 is $10 off (owner's decision at the rev 2.3 review) — and betterOf caps any promotion at the line total, so a line never
 * goes below $0.00. A percentage is unchanged (it is already on the line total), and a SERVICE add-on keeps one amount per line.
 */
async function promotionsOf(tx: Tx, line: OpenLine, quantity: number): Promise<ApplicablePromotion[]> {
  if (line.serviceId) return promotionsFor(tx, line.serviceId, fromDateOnly(line.addedOn));
  const promos = await promotionsForProduct(tx, line.productId!, fromDateOnly(line.addedOn));
  return promos.map((p) => (p.kind === 'FIXED_CENTS' ? { ...p, value: p.value * quantity } : p));
}

export interface OpenLineView {
  id: string;
  kind: 'SERVICE' | 'PRODUCT';
  serviceId: string | null;
  productId: string | null;
  name: string;
  category: string;
  unitPriceCents: number;
  /** Units on the line, and their total — the figure every discount, adjustment and tax below is worked out on. */
  quantity: number;
  listCents: number;
  taxRateMilli: number;
  addedOn: string;
  addedAt: string;
  addedBy: string | null;
  performedBy: { id: string; name: string } | null;
  bookingId: string | null;
  /** Paid in money: the member's tier percent before the better-of rule, what applied, the promotions it qualifies for. */
  tierPercent: number;
  discountPercent: number;
  discountCents: number;
  promotion: { id: string; name: string; cents: number } | null;
  /** As they apply to this line: a product's fixed amount is already × its quantity, so the screen prices it the same way. */
  promotions: Array<{ id: string; name: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number }>;
  netCents: number;
  taxCents: number;
  /** The most the front desk may take off (decision 3 of rev 2.2); an admin may go further, or raise the price. */
  adjustmentCapCents: number;
  /** A service only: whether membership credits or a perk could pay for it instead. Products: null / []. */
  credits: { cost: number | null; available: boolean; reason: string | null } | null;
  perks: Array<{ perkId: string; label: string; remaining: number; period: string }>;
}

/** The open lines priced as check-out would price them if paid in money — the Charges window's and the check-out window's figures. */
export async function openLinesView(tx: Tx, patientId: string, now: Date): Promise<{ lines: OpenLineView[]; totals: { listCents: number; discountCents: number; promotionCents: number; netCents: number; taxCents: number; totalCents: number } }> {
  const today = clinicDay(now);
  const open = await openChargesOf(tx, patientId);
  const membership = open.length ? await openMembership(tx, patientId) : null;
  const bal = open.some((l) => l.serviceId) ? await balance(tx, patientId, today) : 0;
  const perkList: PerkState[] = membership && membership.status === 'ACTIVE' && open.some((l) => l.serviceId) ? await perkStates(tx, membership, today) : [];
  const accounts = new Map((await tx.account.findMany({ where: { id: { in: [...new Set(open.map((l) => l.addedById))] } }, select: { id: true, displayName: true } })).map((x) => [x.id, x.displayName]));
  const staff = new Map((await tx.staff.findMany({ where: { id: { in: open.map((l) => l.performedByStaffId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
  const lines: OpenLineView[] = [];
  for (const l of open) {
    const tier = await tierFor(tx, l, membership);
    const promos = await promotionsOf(tx, l, quantityOf(l));
    const quantity = quantityOf(l);
    const listCents = l.unitPriceCents * quantity;
    const red = betterOf(listCents, tier.percent, promos);
    const netCents = listCents - red.discountCents - red.promotionCents;
    let credits: OpenLineView['credits'] = null;
    let perks: OpenLineView['perks'] = [];
    if (l.serviceId) {
      const s = await tx.service.findUnique({ where: { id: l.serviceId }, select: { name: true, creditCost: true } });
      // Credits: the service's cost for each unit. A perk covers one unit, so it is offered only for a line of one.
      const cost = s?.creditCost != null ? s.creditCost * quantity : null;
      const reason = cost == null ? `${s?.name ?? 'This service'} is not credit-eligible.` : bal < cost ? `Needs ${cost} credits; ${bal} available.` : null;
      credits = { cost, available: reason === null, reason };
      perks = quantity === 1 ? perkList.filter((p) => p.serviceIds.includes(l.serviceId!) && p.remaining > 0).map((p) => ({ perkId: p.perkId, label: p.label, remaining: p.remaining, period: p.period })) : [];
    }
    lines.push({
      id: l.id, kind: l.productId ? 'PRODUCT' : 'SERVICE', serviceId: l.serviceId, productId: l.productId, name: l.name, category: l.category,
      unitPriceCents: l.unitPriceCents, quantity, listCents, taxRateMilli: l.taxRateMilli, addedOn: fromDateOnly(l.addedOn), addedAt: l.addedAt.toISOString(),
      addedBy: accounts.get(l.addedById) ?? null, performedBy: l.performedByStaffId ? { id: l.performedByStaffId, name: staff.get(l.performedByStaffId) ?? '' } : null,
      bookingId: l.bookingId, tierPercent: tier.percent, discountPercent: red.discountPercent, discountCents: red.discountCents,
      promotion: red.promotionId ? { id: red.promotionId, name: promos.find((p) => p.id === red.promotionId)!.name, cents: red.promotionCents } : null,
      promotions: promos.map((p) => ({ id: p.id, name: p.name, kind: p.kind, value: p.value })),
      netCents, taxCents: taxOf(netCents, l.taxRateMilli), adjustmentCapCents: deskAdjustmentCap(listCents), credits, perks,
    });
  }
  const sum = (f: (l: OpenLineView) => number) => lines.reduce((n, l) => n + f(l), 0);
  const totals = {
    listCents: sum((l) => l.listCents), discountCents: sum((l) => l.discountCents), promotionCents: sum((l) => l.promotion?.cents ?? 0),
    netCents: sum((l) => l.netCents), taxCents: sum((l) => l.taxCents), totalCents: 0,
  };
  totals.totalCents = totals.netCents + totals.taxCents;
  return { lines, totals };
}

// ---- checking a line out -------------------------------------------------------------------------------------------------------

export interface ChargeSummary {
  openChargeId: string;
  revenueEventId: string;
  kind: 'SERVICE' | 'PRODUCT';
  name: string;
  quantity: number;
  unitPriceCents: number;
  paymentType: 'CASH' | 'MEMBER';
  memberBenefit: 'CREDITS' | 'PERK' | null;
  listPriceCents: number;
  discountPercent: number;
  discountCents: number;
  promotion: { id: string; name: string; cents: number } | null;
  adjustmentCents: number;
  adjustmentReason: AdjustmentReasonCode | null;
  netPriceCents: number;
  taxRateMilli: number;
  taxCents: number;
  creditsRedeemed: number;
  perkLabel: string | null;
}

/**
 * Turn one open line into a charge (called by the combined check-out, under its patient lock, in its transaction). Priced like a visit:
 * MONEY gets the better of the tier discount and a promotion, then any adjustment (the desk within its cap; an admin beyond it, or
 * above list), then tax on the net for a taxable product. CREDITS and PERK are for a service only — never a product (decision 3a).
 */
export async function checkoutCharge(tx: Tx, rec: Rec, a: {
  line: OpenLine; pay: 'MONEY' | 'CREDITS' | 'PERK'; perkId?: string | undefined; expectedNetCents?: number | undefined; adjustment?: AdjustmentInput | null | undefined;
  byAdmin: boolean; batchId: string | null; accountId: string; now: Date; membership: Membership;
}): Promise<ChargeSummary> {
  const l = a.line;
  const today = clinicDay(a.now);
  const eventId = randomUUID();
  const quantity = quantityOf(l);
  const listCents = l.unitPriceCents * quantity;
  let paymentType: 'MEMBER' | 'CASH' = 'CASH';
  let memberBenefit: 'CREDITS' | 'PERK' | null = null;
  let credits = 0;
  let discountPercent = 0;
  let discountCents = 0;
  let discountCategory: string | null = null;
  let promotion: ChargeSummary['promotion'] = null;
  let adjustment: { cents: number; reason: AdjustmentReasonCode; note: string | null } | null = null;
  let netCents = 0;
  let taxCents = 0;
  let perkLabel: string | null = null;

  if (a.pay !== 'MONEY') {
    if (l.productId) throw fail(400, 'credits_not_for_products', 'Membership credits and perks pay for services only, never for a product.');
    if (a.adjustment) throw fail(400, 'adjustment_only_for_money', 'An adjustment applies only to a line paid in money, not with credits or a perk.');
    const s = await tx.service.findUniqueOrThrow({ where: { id: l.serviceId! }, select: { name: true, creditCost: true } });
    if (a.pay === 'CREDITS') {
      if (s.creditCost == null) throw fail(409, 'not_credit_eligible', `${s.name} cannot be paid with Wellness Credits.`);
      // The service's credit cost for each unit on the line.
      await takeCredits(tx, rec, { patientId: l.patientId, amount: s.creditCost * quantity, reason: 'REDEMPTION', today, now: a.now, actorAccountId: a.accountId, revenueEventId: eventId });
      paymentType = 'MEMBER'; memberBenefit = 'CREDITS'; credits = s.creditCost * quantity;
    } else {
      if (quantity > 1) throw fail(409, 'perk_one_unit', 'A perk covers one. Set the quantity to 1, or pay for the line in money or credits.');
      const m = a.membership;
      if (!m || m.status !== 'ACTIVE') throw fail(409, 'membership_not_active', 'Perks are available only to a patient with an active membership.');
      const covers = await tx.planPerkService.findFirst({ where: { perkId: a.perkId ?? '', serviceId: l.serviceId!, perk: { planId: m.planId, active: true } } });
      if (!covers) throw fail(409, 'perk_not_for_service', `That perk does not cover ${s.name}.`);
      const perk = await usePerk(tx, rec, { membershipId: m.id, perkId: a.perkId!, patientId: l.patientId, today, now: a.now, actorAccountId: a.accountId, revenueEventId: eventId });
      paymentType = 'MEMBER'; memberBenefit = 'PERK'; perkLabel = perk.label;
    }
  } else {
    const tier = await tierFor(tx, l, a.membership);
    const promos = await promotionsOf(tx, l, quantityOf(l));
    const red = betterOf(listCents, tier.percent, promos);
    discountPercent = red.discountPercent;
    discountCents = red.discountCents;
    discountCategory = red.discountCents > 0 ? tier.code : null;
    if (red.promotionId) promotion = { id: red.promotionId, name: promos.find((p) => p.id === red.promotionId)!.name, cents: red.promotionCents };
    const afterDiscounts = listCents - discountCents - (promotion?.cents ?? 0);
    if (a.adjustment) adjustment = checkAdjustment(a.adjustment, { listCents, afterDiscountsCents: afterDiscounts, byAdmin: a.byAdmin });
    netCents = afterDiscounts - (adjustment?.cents ?? 0);
    taxCents = taxOf(netCents, l.taxRateMilli);
    if (a.expectedNetCents != null && a.expectedNetCents !== netCents) {
      throw fail(409, 'price_changed', `The price of ${l.name} changed since this screen opened (the membership, its discount or a promotion was edited). Review the new amount and check out again.`,
        { openChargeId: l.id, quantity, listPriceCents: listCents, discountPercent, discountCents, promotionCents: promotion?.cents ?? 0, adjustmentCents: adjustment?.cents ?? 0, netPriceCents: netCents, taxCents });
    }
  }

  const m = a.membership;
  await tx.revenueEvent.create({
    data: {
      id: eventId, patientId: l.patientId, serviceId: l.serviceId, productId: l.productId, openChargeId: l.id,
      // The snapshots taken when the line was added (decision 1) — never the catalog as it is now.
      serviceName: l.name, serviceCategory: l.category, quantity, listPriceCents: listCents, taxRateMilli: l.taxRateMilli, taxCents,
      paymentType, memberBenefit, creditsRedeemed: credits, discountPercent, discountCents, netPriceCents: netCents, discountCategory,
      staffId: l.performedByStaffId, promotionId: promotion?.id ?? null, promotionCents: promotion?.cents ?? 0,
      adjustmentCents: adjustment?.cents ?? 0, adjustmentReason: adjustment?.reason ?? null, adjustmentNote: adjustment?.note ?? null,
      adjustedById: adjustment ? a.accountId : null, batchId: a.batchId,
      planCode: m && (paymentType === 'MEMBER' || m.status === 'ACTIVE') ? m.plan.code : null,
      occurredAt: a.now, recordedById: a.accountId,
    },
  });
  // Ids, codes and flags only — no amounts, names or note text (rev 2.2 hard rule).
  await rec({ action: 'CREATE', resourceType: 'revenue_event', resourceId: eventId, meta: {
    lineKind: l.productId ? 'PRODUCT' : 'ADDON_SERVICE', openChargeId: l.id, paymentType, memberBenefit, credits, discountCategory,
    tierDiscount: discountCents > 0, promotionId: promotion?.id ?? null, adjustmentReason: adjustment?.reason ?? null, taxed: taxCents > 0, quantity, batchId: a.batchId,
  } });
  return {
    openChargeId: l.id, revenueEventId: eventId, kind: l.productId ? 'PRODUCT' : 'SERVICE', name: l.name, quantity, unitPriceCents: l.unitPriceCents,
    paymentType, memberBenefit, listPriceCents: listCents, discountPercent, discountCents, promotion, adjustmentCents: adjustment?.cents ?? 0, adjustmentReason: adjustment?.reason ?? null,
    netPriceCents: netCents, taxRateMilli: l.taxRateMilli, taxCents, creditsRedeemed: credits, perkLabel,
  };
}
