/**
 * The money layer's arithmetic (Phase 2b, rev 2.2) — pure functions, whole cents, no database, no floating point.
 * Every figure the desk sees and every figure that is recorded comes from these; the tests drive them at their boundaries
 * (tests/money-math.test.ts). docs/MONEY_LAYER_DESIGN.md §0 has the owner's decisions they implement.
 */

/** `percent` of `cents`, to the cent, halves rounding UP — the same rule as the tier discount (lib/pricing.ts). */
export function percentOf(cents: number, percent: number): number {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('An amount is a whole number of cents, zero or more.');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('A percent is a whole number from 0 to 100.');
  return Math.floor((cents * percent + 50) / 100);
}

export interface PromotionTerms { id: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number }

/** What one promotion takes off a list price: a percent of it, or a fixed amount capped at the price. */
export function promotionOff(listCents: number, p: PromotionTerms): number {
  return p.kind === 'PERCENT' ? percentOf(listCents, p.value) : Math.min(p.value, listCents);
}

export interface Reduction {
  /** The tier discount that applied (0 when a promotion was better). */
  discountPercent: number;
  discountCents: number;
  /** The promotion that applied (null when the tier discount was at least as good). */
  promotionId: string | null;
  promotionCents: number;
}

/**
 * Decision 1: the member tier discount OR the single best promotion — whichever is better for the patient, never both, and never two
 * promotions together. On a tie the tier discount is recorded (the price is the same either way). Among promotions giving the same
 * amount, the one with the smallest id, so the choice is the same every time.
 */
export function betterOf(listCents: number, tierPercent: number, promotions: PromotionTerms[]): Reduction {
  const tierCents = percentOf(listCents, tierPercent);
  let best: { id: string; cents: number } | null = null;
  for (const p of [...promotions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const cents = promotionOff(listCents, p);
    if (cents > 0 && (!best || cents > best.cents)) best = { id: p.id, cents };
  }
  if (best && best.cents > tierCents) return { discountPercent: 0, discountCents: 0, promotionId: best.id, promotionCents: best.cents };
  return { discountPercent: tierCents > 0 ? tierPercent : 0, discountCents: tierCents, promotionId: null, promotionCents: 0 };
}

/** Decision 3: the most the FRONT DESK may take off one visit — 20% of its list price or $25.00, whichever is less (20% rounds down). */
export const DESK_ADJUSTMENT_PERCENT = 20;
export const DESK_ADJUSTMENT_MAX_CENTS = 2500;
export function deskAdjustmentCap(listCents: number): number {
  return Math.min(Math.floor((listCents * DESK_ADJUSTMENT_PERCENT) / 100), DESK_ADJUSTMENT_MAX_CENTS);
}

export type AdjustmentRefusal = 'bad_amount' | 'adjustment_too_large' | 'adjustment_needs_admin';

/**
 * Whether an adjustment of `cents` may be made on a visit with this list price and this much left after discounts. An admin on an
 * MFA-verified session may go above the desk's cap; nobody may take a visit below zero.
 */
export function adjustmentRefusal(a: { listCents: number; afterDiscountsCents: number; cents: number; byAdmin: boolean }): AdjustmentRefusal | null {
  if (!Number.isInteger(a.cents) || a.cents <= 0) return 'bad_amount';
  if (a.cents > a.afterDiscountsCents) return 'adjustment_too_large';
  if (!a.byAdmin && a.cents > deskAdjustmentCap(a.listCents)) return 'adjustment_needs_admin';
  return null;
}

/**
 * Decision 8: settle charges OLDEST FIRST. `charges` must already be in order (oldest first); returns what each receives and what is
 * left over. Never gives a charge more than it has outstanding.
 */
export function allocateOldestFirst(charges: Array<{ id: string; outstandingCents: number }>, amountCents: number): { allocations: Array<{ id: string; cents: number }>; leftCents: number } {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError('An amount is a whole number of cents, zero or more.');
  let left = amountCents;
  const allocations: Array<{ id: string; cents: number }> = [];
  for (const c of charges) {
    if (left === 0) break;
    const take = Math.min(left, Math.max(0, c.outstandingCents));
    if (take > 0) { allocations.push({ id: c.id, cents: take }); left -= take; }
  }
  return { allocations, leftCents: left };
}

/** Luhn check over a string of digits. */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/**
 * Decision 5: no card data in the app. A payment reference or note that contains a card-number-shaped run — 13 to 19 digits, spaces
 * and dashes ignored, passing the Luhn check — is refused, so a number typed into the wrong box is never stored.
 */
export function looksLikeCardNumber(text: string | null | undefined): boolean {
  if (!text) return false;
  // Whole runs only: scanning every window of a long run would refuse almost any long reference by chance.
  const runs = text.replace(/[\s-]/g, '').match(/\d+/g) ?? [];
  return runs.some((run) => run.length >= 13 && run.length <= 19 && luhnOk(run));
}
