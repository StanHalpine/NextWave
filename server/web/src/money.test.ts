import { describe, expect, it } from 'vitest';
import { ACCOUNT_CREDIT_LABEL, betterOf, canReverse, deskAdjustmentCap, MEMBERSHIP_CREDITS_LABEL, paymentShape, percentOf, postedLabel, type PostedEntry } from './money';

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
