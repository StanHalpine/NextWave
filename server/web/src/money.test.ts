import { describe, expect, it } from 'vitest';
import { ACCOUNT_CREDIT_LABEL, betterOf, canReverse, deskAdjustmentCap, lineFigure, MEMBERSHIP_CREDITS_LABEL, paymentShape, percentOf, postedLabel, ratePercent, taxOf, type PostedEntry } from './money';

/** The screen's copies of the money rules must give the server's answers (server tests: tests/money-math.test.ts). */

describe('the copies of the pricing rules', () => {
  it('percentOf rounds halves up, like the server', () => {
    expect([percentOf(1999, 15), percentOf(1990, 15), percentOf(1, 50)]).toEqual([300, 299, 1]);
  });
  it('better of tier and promotion, never both; a tie keeps the tier; the single best promotion', () => {
    const promo = (id: string, kind: 'PERCENT' | 'FIXED_CENTS', value: number) => ({ id, name: id, kind, value });
    expect(betterOf(5500, 10, [promo('p', 'PERCENT', 20)])).toEqual({ discountCents: 0, promotion: { id: 'p', name: 'p', cents: 1100 } });
    expect(betterOf(5500, 25, [promo('p', 'PERCENT', 20)])).toEqual({ discountCents: 1375, promotion: null });
    expect(betterOf(5500, 20, [promo('p', 'FIXED_CENTS', 1100)])).toEqual({ discountCents: 1100, promotion: null });
    expect(betterOf(5500, 0, [promo('a', 'FIXED_CENTS', 1000), promo('b', 'PERCENT', 30)]).promotion?.id).toBe('b');
    expect(betterOf(500, 0, [promo('a', 'FIXED_CENTS', 9000)]).promotion?.cents).toBe(500);
  });
  it('the desk cap: 20% of list or $25, whichever is less', () => {
    expect([deskAdjustmentCap(5500), deskAdjustmentCap(12499), deskAdjustmentCap(12500), deskAdjustmentCap(20000)]).toEqual([1100, 2499, 2500, 2500]);
  });
});

describe('the payment line', () => {
  it('full, partial (needs the patient\'s agreement), over (needs their choice), none', () => {
    expect(paymentShape(11000, 11000)).toEqual({ kind: 'full', restCents: 0 });
    expect(paymentShape(4000, 11000)).toEqual({ kind: 'partial', restCents: 7000 });
    expect(paymentShape(12000, 11000)).toEqual({ kind: 'over', restCents: 1000 });
    expect(paymentShape(0, 11000)).toEqual({ kind: 'none', restCents: 11000 });
    expect(paymentShape(500, 0)).toEqual({ kind: 'over', restCents: 500 });
  });
});

describe('the two kinds of credit are never mixed up', () => {
  it('have different labels, and the dollar one says so', () => {
    expect(ACCOUNT_CREDIT_LABEL).toBe('Account credit ($)');
    expect(MEMBERSHIP_CREDITS_LABEL).toBe('Membership credits');
    const applied: PostedEntry = { kind: 'account_credit_applied', id: '1', date: '2026-10-13', at: '', revenueEventId: 'r', amountCents: -500, balanceAfterCents: 0 };
    expect(postedLabel(applied)).toBe('Account credit ($) applied');
  });
});

describe('posted lines and who may reverse', () => {
  const payment = (o: Partial<Extract<PostedEntry, { kind: 'payment' }>> = {}): PostedEntry => ({
    kind: 'payment', id: 'p', date: '2026-10-13', at: '', tender: 'HSA_FSA', totalCents: 5000, amountCents: -5000, toAccountCreditCents: 0, refundedCents: 0,
    reversed: false, reversibleByDesk: true, reversibleByAdmin: true, balanceAfterCents: 0, ...o,
  });
  it('words a payment by its tender and what happened to the rest', () => {
    expect(postedLabel(payment())).toBe('Payment — hsa/fsa');
    expect(postedLabel(payment({ toAccountCreditCents: 500 }))).toBe('Payment — hsa/fsa (rest kept as account credit)');
    expect(postedLabel(payment({ refundedCents: 500, reversed: true }))).toBe('Payment — hsa/fsa (rest refunded; reversed)');
  });
  it('the desk may reverse only what the server marks as the same day; an admin, any open payment', () => {
    expect(canReverse(payment(), false)).toBe(true);
    expect(canReverse(payment({ reversibleByDesk: false }), false)).toBe(false);
    expect(canReverse(payment({ reversibleByDesk: false }), true)).toBe(true);
    expect(canReverse(payment({ reversibleByDesk: false, reversibleByAdmin: false }), true)).toBe(false);
  });
});

describe('rev 2.3: tax and the price of an added line, as the server works them out', () => {
  it('taxOf: per line, halves up, the rate in thousandths of a percent (server tests: money-math)', () => {
    expect([taxOf(3500, 5500), taxOf(3499, 5500), taxOf(10, 5500), taxOf(9, 5500), taxOf(2000, 8025), taxOf(1234, 0)]).toEqual([193, 192, 1, 0, 161, 0]);
  });
  it('a rate as people write it', () => {
    expect([ratePercent(5500), ratePercent(8025), ratePercent(7000), ratePercent(0), ratePercent(100_000)]).toEqual(['5.5%', '8.025%', '7%', '0%', '100%']);
  });
  it('a line: better of tier and promotion, then an adjustment (negative raises it), then tax on what is left', () => {
    const base = { listCents: 3500, tierPercent: 20, promotions: [], taxRateMilli: 5500 };
    expect(lineFigure(base)).toMatchObject({ discountCents: 700, netCents: 2800, taxCents: 154 });
    expect(lineFigure(base, 300)).toMatchObject({ netCents: 2500, taxCents: 138 });
    expect(lineFigure(base, -500)).toMatchObject({ netCents: 3300, taxCents: 182 });
    expect(lineFigure({ ...base, promotions: [{ id: 'p', name: 'p', kind: 'PERCENT', value: 25 }] })).toMatchObject({ discountCents: 0, promotion: { cents: 875 }, netCents: 2625, taxCents: 144 });
    expect(lineFigure({ ...base, taxRateMilli: 0 })).toMatchObject({ taxCents: 0 });
  });
  it('a line of several: everything on the line total — 3 × $33.33 = $99.99, 15% off it, tax on what is left', () => {
    expect(lineFigure({ listCents: 3 * 3333, tierPercent: 15, promotions: [], taxRateMilli: 5500 })).toMatchObject({ discountCents: 1500, netCents: 8499, taxCents: 467 });
    expect(lineFigure({ listCents: 3 * 2000, tierPercent: 0, promotions: [{ id: 'f', name: 'f', kind: 'FIXED_CENTS', value: 500 }], taxRateMilli: 5500 })).toMatchObject({ promotion: { cents: 500 }, netCents: 5500 });
  });
  it('a product\'s tax line names the product and its rate', () => {
    const charge = { kind: 'charge', id: 'x', date: '2026-10-13', at: '', bookingId: null, serviceName: 'Vitamin D3', subOption: null, lineKind: 'PRODUCT', quantity: 3,
      paymentType: 'CASH', listPriceCents: 7500, discountCents: 0, promotionCents: 0, promotionName: null, adjustmentCents: 0, adjustmentReason: null, taxCents: 413, amountCents: 7500, balanceAfterCents: 0 } as const;
    expect(postedLabel(charge)).toBe('Vitamin D3 × 3');
    expect(postedLabel({ ...charge, quantity: 1 })).toBe('Vitamin D3');
    const e: PostedEntry = { kind: 'tax', id: 'x:tax', revenueEventId: 'x', date: '2026-10-13', at: '', serviceName: 'Magnesium glycinate', rateMilli: 5500, amountCents: 193, balanceAfterCents: 0 };
    expect(postedLabel(e)).toBe('Sales tax 5.5% — Magnesium glycinate');
  });
});
