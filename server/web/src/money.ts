/**
 * The money layer on the screen (Phase 2b, rev 2.2): the Ledger's posted section, check-out and payment wording, and the copies of the
 * server's pricing rules the screen needs to show a typed price as it will be recorded. The SERVER recomputes everything and refuses a
 * figure that differs (409 price_changed) — these copies are for showing, never for deciding.
 *
 * Two kinds of "credit" exist and are never mixed: ACCOUNT CREDIT is dollars held for the patient (an overpayment they chose to keep);
 * MEMBERSHIP CREDITS are the monthly Wellness Credits. Every label here says which.
 */

export const ACCOUNT_CREDIT_LABEL = 'Account credit ($)';
export const MEMBERSHIP_CREDITS_LABEL = 'Membership credits';

export type Tender = 'CASH' | 'CARD' | 'CHECK' | 'HSA_FSA' | 'OTHER';
export const TENDERS: Array<{ value: Tender; label: string }> = [
  { value: 'CASH', label: 'Cash' }, { value: 'CARD', label: 'Card' }, { value: 'CHECK', label: 'Check' }, { value: 'HSA_FSA', label: 'HSA/FSA' }, { value: 'OTHER', label: 'Other' },
];
export const tenderLabel = (t: string): string => TENDERS.find((x) => x.value === t)?.label ?? t;

export type AdjustmentReason = 'SERVICE_RECOVERY' | 'PRICE_MATCH' | 'COURTESY' | 'BILLING_ERROR' | 'OTHER';
export const ADJUSTMENT_REASONS: Array<{ value: AdjustmentReason; label: string }> = [
  { value: 'SERVICE_RECOVERY', label: 'Service recovery' }, { value: 'PRICE_MATCH', label: 'Price match' }, { value: 'COURTESY', label: 'Courtesy' },
  { value: 'BILLING_ERROR', label: 'Billing error' }, { value: 'OTHER', label: 'Other' },
];
export type ReversalReason = 'ENTERED_IN_ERROR' | 'DECLINED' | 'CHECK_RETURNED' | 'DUPLICATE' | 'OTHER';
export const REVERSAL_REASONS: Array<{ value: ReversalReason; label: string }> = [
  { value: 'ENTERED_IN_ERROR', label: 'Entered in error' }, { value: 'DECLINED', label: 'Declined' }, { value: 'CHECK_RETURNED', label: 'Check returned' },
  { value: 'DUPLICATE', label: 'Duplicate' }, { value: 'OTHER', label: 'Other' },
];
export const reasonLabel = (r: string | null | undefined): string =>
  [...ADJUSTMENT_REASONS, ...REVERSAL_REASONS].find((x) => x.value === r)?.label ?? (r ?? '');

// ---- the Ledger's money section (lib/moneyLedger.ts) --------------------------------------------------------------------------

export type PostedEntry =
  | { kind: 'charge'; id: string; date: string; at: string; bookingId: string | null; serviceName: string; subOption: string | null;
      paymentType: 'CASH' | 'MEMBER'; listPriceCents: number | null; discountCents: number; promotionCents: number; promotionName: string | null;
      adjustmentCents: number; adjustmentReason: string | null; amountCents: number; balanceAfterCents: number }
  | { kind: 'settled_before_tracking'; id: string; date: string; at: string; amountCents: number; balanceAfterCents: number }
  | { kind: 'payment'; id: string; date: string; at: string; tender: string; totalCents: number; amountCents: number; toAccountCreditCents: number;
      refundedCents: number; reversed: boolean; reversibleByDesk: boolean; reversibleByAdmin: boolean; balanceAfterCents: number }
  | { kind: 'reversal'; id: string; paymentId: string; date: string; at: string; reason: string; amountCents: number; balanceAfterCents: number }
  | { kind: 'account_credit_applied'; id: string; date: string; at: string; revenueEventId: string; amountCents: number; balanceAfterCents: number };

export interface MoneyView {
  version: string;
  balanceCents: number;
  accountCreditCents: number;
  posted: PostedEntry[];
  accountCredit: Array<{ id: string; kind: 'OVERPAYMENT' | 'APPLIED' | 'REFUNDED' | 'REVERSED'; date: string; deltaCents: number; balanceAfterCents: number; refundTender: string | null }>;
}

/** What a posted line says, in the desk's words. */
export function postedLabel(e: PostedEntry): string {
  switch (e.kind) {
    case 'charge': return e.paymentType === 'MEMBER' ? `${e.serviceName} — covered by the membership` : e.serviceName;
    case 'settled_before_tracking': return 'Settled — before payments were tracked';
    case 'account_credit_applied': return `${ACCOUNT_CREDIT_LABEL} applied`;
    case 'reversal': return `Payment reversed — ${reasonLabel(e.reason).toLowerCase()}`;
    case 'payment': {
      const extra = [e.toAccountCreditCents > 0 ? 'rest kept as account credit' : '', e.refundedCents > 0 ? 'rest refunded' : '', e.reversed ? 'reversed' : ''].filter(Boolean);
      return `Payment — ${tenderLabel(e.tender).toLowerCase()}${extra.length ? ` (${extra.join('; ')})` : ''}`;
    }
  }
}

/** Whether this person may reverse this payment now (decision 6). The server decides; this only hides a button that would be refused. */
export function canReverse(e: PostedEntry, isAdmin: boolean): boolean {
  return e.kind === 'payment' && (e.reversibleByDesk || (isAdmin && e.reversibleByAdmin));
}

// ---- copies of the server's pricing rules (lib/moneyMath.ts), for showing a typed price ---------------------------------------

export function percentOf(cents: number, percent: number): number { return Math.floor((cents * percent + 50) / 100); }

export interface PromotionTerms { id: string; name: string; kind: 'PERCENT' | 'FIXED_CENTS'; value: number }

/** The tier discount or the single best promotion — whichever is better for the patient, never both. A tie keeps the tier discount. */
export function betterOf(listCents: number, tierPercent: number, promotions: PromotionTerms[]): { discountCents: number; promotion: { id: string; name: string; cents: number } | null } {
  const tier = percentOf(listCents, tierPercent);
  let best: { id: string; name: string; cents: number } | null = null;
  for (const p of [...promotions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const cents = p.kind === 'PERCENT' ? percentOf(listCents, p.value) : Math.min(p.value, listCents);
    if (cents > 0 && (!best || cents > best.cents)) best = { id: p.id, name: p.name, cents };
  }
  return best && best.cents > tier ? { discountCents: 0, promotion: best } : { discountCents: tier, promotion: null };
}

/** Decision 3: the most the front desk may take off one visit — 20% of its list price or $25.00, whichever is less. */
export const deskAdjustmentCap = (listCents: number): number => Math.min(Math.floor((listCents * 20) / 100), 2500);

/** A fresh idempotency key for one press of Confirm. */
export function newKey(): string {
  const c = globalThis.crypto;
  return c && 'randomUUID' in c ? c.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * What the payment line should say once the desk has typed an amount against what is due: a full payment, a partial one that needs
 * the patient's agreement, or more than is due — which needs the patient's choice of refund or account credit.
 */
export function paymentShape(amountCents: number, dueCents: number): { kind: 'none' | 'full' | 'partial' | 'over'; restCents: number } {
  if (amountCents <= 0) return { kind: 'none', restCents: dueCents };
  if (amountCents === dueCents) return { kind: 'full', restCents: 0 };
  if (amountCents < dueCents) return { kind: 'partial', restCents: dueCents - amountCents };
  return { kind: 'over', restCents: amountCents - dueCents };
}
