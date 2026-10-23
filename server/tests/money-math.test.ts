import { describe, expect, it } from 'vitest';
import {
  adjustmentRefusal, allocateOldestFirst, betterOf, DESK_ADJUSTMENT_MAX_CENTS, deskAdjustmentCap, looksLikeCardNumber, luhnOk, percentOf, promotionOff,
} from '../src/lib/moneyMath.js';

/** lib/moneyMath.ts — the money layer's arithmetic, at its boundaries (Phase 2b, rev 2.2). */

describe('percentOf: to the cent, halves up (the tier discount\'s rule)', () => {
  it('rounds', () => {
    expect(percentOf(1999, 15)).toBe(300);          // 299.85 → 300
    expect(percentOf(1990, 15)).toBe(299);          // 298.5 → 299 (half up)
    expect(percentOf(1, 49)).toBe(0);               // 0.49 → 0
    expect(percentOf(1, 50)).toBe(1);               // 0.5 → 1
    expect(percentOf(5500, 0)).toBe(0);
    expect(percentOf(5500, 100)).toBe(5500);
  });
  it('refuses what is not whole cents or a whole percent', () => {
    for (const [c, p] of [[1.5, 10], [-1, 10], [100, -1], [100, 101], [100, 2.5]] as const) expect(() => percentOf(c, p)).toThrow(RangeError);
  });
});

describe('promotionOff and betterOf (decision 1: the better of tier and promotion, never both, never two promotions)', () => {
  const pct = (id: string, value: number) => ({ id, kind: 'PERCENT' as const, value });
  const fixed = (id: string, value: number) => ({ id, kind: 'FIXED_CENTS' as const, value });

  it('a fixed promotion is capped at the price; a percent rounds like the tier', () => {
    expect(promotionOff(5500, fixed('a', 9000))).toBe(5500);
    expect(promotionOff(5500, fixed('a', 1000))).toBe(1000);
    expect(promotionOff(1999, pct('a', 15))).toBe(300);
  });

  it('takes the promotion when it is better, and then no tier discount at all', () => {
    expect(betterOf(5500, 10, [pct('p', 20)])).toEqual({ discountPercent: 0, discountCents: 0, promotionId: 'p', promotionCents: 1100 });
  });
  it('keeps the tier discount when it is better, and then no promotion', () => {
    expect(betterOf(5500, 20, [pct('p', 10)])).toEqual({ discountPercent: 20, discountCents: 1100, promotionId: null, promotionCents: 0 });
  });
  it('on a tie records the tier discount (the price is the same)', () => {
    expect(betterOf(5500, 20, [fixed('p', 1100)])).toEqual({ discountPercent: 20, discountCents: 1100, promotionId: null, promotionCents: 0 });
    // one cent better for the patient tips it
    expect(betterOf(5500, 20, [fixed('p', 1101)])).toMatchObject({ discountCents: 0, promotionId: 'p', promotionCents: 1101 });
  });
  it('of several promotions takes only the single best; equal ones by smallest id, the same every time', () => {
    expect(betterOf(5500, 0, [pct('b', 10), fixed('a', 1000), pct('c', 30)])).toMatchObject({ promotionId: 'c', promotionCents: 1650 });
    expect(betterOf(5500, 0, [fixed('z', 1000), fixed('m', 1000)])).toMatchObject({ promotionId: 'm' });
    expect(betterOf(5500, 0, [fixed('m', 1000), fixed('z', 1000)])).toMatchObject({ promotionId: 'm' });
  });
  it('a non-member with no promotion pays list; a zero list price takes nothing', () => {
    expect(betterOf(5500, 0, [])).toEqual({ discountPercent: 0, discountCents: 0, promotionId: null, promotionCents: 0 });
    expect(betterOf(0, 20, [pct('p', 50)])).toEqual({ discountPercent: 0, discountCents: 0, promotionId: null, promotionCents: 0 });
  });
});

describe('the desk adjustment cap (decision 3): 20% of list or $25.00, whichever is less', () => {
  it('is 20% below $125.00 of list, and $25.00 at and above it', () => {
    expect(DESK_ADJUSTMENT_MAX_CENTS).toBe(2500);
    expect(deskAdjustmentCap(5500)).toBe(1100);      // $55 → $11
    expect(deskAdjustmentCap(12499)).toBe(2499);     // 20% = 2499.8, rounded DOWN: never above 20%
    expect(deskAdjustmentCap(12500)).toBe(2500);     // the crossover: both rules give $25
    expect(deskAdjustmentCap(12501)).toBe(2500);
    expect(deskAdjustmentCap(20000)).toBe(2500);     // 20% would be $40
    expect(deskAdjustmentCap(0)).toBe(0);
  });

  it('refuses one cent over the cap for the desk — and not for an admin', () => {
    const at = (cents: number, byAdmin = false, list = 5500, after = 5500) => adjustmentRefusal({ listCents: list, afterDiscountsCents: after, cents, byAdmin });
    expect(at(1100)).toBeNull();
    expect(at(1101)).toBe('adjustment_needs_admin');
    expect(at(1101, true)).toBeNull();
    expect(at(2500, false, 20000, 20000)).toBeNull();
    expect(at(2501, false, 20000, 20000)).toBe('adjustment_needs_admin');
    expect(at(4000, true, 20000, 20000)).toBeNull();
  });

  it('never takes a visit below zero, for anyone; and an amount is whole cents above zero', () => {
    expect(adjustmentRefusal({ listCents: 5500, afterDiscountsCents: 500, cents: 501, byAdmin: true })).toBe('adjustment_too_large');
    expect(adjustmentRefusal({ listCents: 5500, afterDiscountsCents: 500, cents: 500, byAdmin: false })).toBeNull();
    for (const c of [0, -1, 1.5]) expect(adjustmentRefusal({ listCents: 5500, afterDiscountsCents: 5500, cents: c, byAdmin: true })).toBe('bad_amount');
  });
});

describe('allocateOldestFirst (decision 8)', () => {
  const charges = [{ id: 'oldest', outstandingCents: 1500 }, { id: 'middle', outstandingCents: 0 }, { id: 'newest', outstandingCents: 5500 }];
  it('pays the oldest first, skips what is settled, and says what is left over', () => {
    expect(allocateOldestFirst(charges, 4000)).toEqual({ allocations: [{ id: 'oldest', cents: 1500 }, { id: 'newest', cents: 2500 }], leftCents: 0 });
    expect(allocateOldestFirst(charges, 1000)).toEqual({ allocations: [{ id: 'oldest', cents: 1000 }], leftCents: 0 });
    expect(allocateOldestFirst(charges, 9000)).toEqual({ allocations: [{ id: 'oldest', cents: 1500 }, { id: 'newest', cents: 5500 }], leftCents: 2000 });
    expect(allocateOldestFirst(charges, 0)).toEqual({ allocations: [], leftCents: 0 });
  });
  it('never gives a charge more than it has outstanding', () => {
    const r = allocateOldestFirst([{ id: 'x', outstandingCents: 10 }], 25);
    expect(r).toEqual({ allocations: [{ id: 'x', cents: 10 }], leftCents: 15 });
  });
});

describe('no card data (decision 5)', () => {
  it('knows a Luhn-valid number', () => {
    expect(luhnOk('4242424242424242')).toBe(true);
    expect(luhnOk('4242424242424241')).toBe(false);
  });
  it('refuses a card-shaped run, with spaces or dashes; allows cheque and receipt numbers', () => {
    for (const t of ['4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242', 'card 5555555555554444 ok', '378282246310005']) expect(looksLikeCardNumber(t), t).toBe(true);
    for (const t of ['1042', 'chk 004512', '4242424242424241', '123456789012', 'receipt 20261013-0042', null, '', '12345678901234567890123']) expect(looksLikeCardNumber(t), String(t)).toBe(false);
  });
});
