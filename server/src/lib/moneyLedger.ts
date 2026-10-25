/**
 * The Ledger's money section (Phase 2b, rev 2.2; design §8): what has been POSTED — charges, payments, reversals, account credit applied —
 * as one dated list with a running balance, whose LAST line is the balance carried forward. Read only.
 *
 * The running balance is built from the same rows the derived balance sums (lib/money.ts chargesOf), and the two must agree to the cent:
 * the tests check that the last line equals `balanceOf` for every scenario they build. A payment is shown on the day it was COLLECTED
 * (decision 8). A reversed payment stays, marked, with its reversal beneath it on the reversal's own day.
 *
 * ACCOUNT CREDIT ($) is its own list and its own total, apart from the balance owed and apart from membership credits (decision 4).
 */
import type { Prisma } from '@prisma/client';
import { accountCreditOf, balanceOf, ledgerVersion } from './money.js';
import { fromDateOnly } from './credits.js';
import { toLocalDateISO } from './time.js';

type Tx = Prisma.TransactionClient;

export type PostedEntry =
  | { kind: 'charge'; id: string; date: string; at: string; bookingId: string | null; serviceName: string; subOption: string | null;
      /** Rev 2.3: a visit, an add-on service (no visit), or a product — each itemized by name (decision 6). */
      lineKind: 'VISIT' | 'ADDON_SERVICE' | 'PRODUCT';
      paymentType: 'CASH' | 'MEMBER'; listPriceCents: number | null; discountCents: number; promotionCents: number; promotionName: string | null;
      adjustmentCents: number; adjustmentReason: string | null; taxCents: number; amountCents: number; balanceAfterCents: number }
  /** Rev 2.3: a product's sales tax, on its own line under it, named — so a receipt substantiates an HSA purchase (decision 6). */
  | { kind: 'tax'; id: string; revenueEventId: string; date: string; at: string; serviceName: string; rateMilli: number; amountCents: number; balanceAfterCents: number }
  | { kind: 'settled_before_tracking'; id: string; date: string; at: string; amountCents: number; balanceAfterCents: number }
  | { kind: 'payment'; id: string; date: string; at: string; tender: string; totalCents: number; amountCents: number; toAccountCreditCents: number;
      refundedCents: number; reversed: boolean; reversibleByDesk: boolean; reversibleByAdmin: boolean; balanceAfterCents: number }
  | { kind: 'reversal'; id: string; paymentId: string; date: string; at: string; reason: string; amountCents: number; balanceAfterCents: number }
  | { kind: 'account_credit_applied'; id: string; date: string; at: string; revenueEventId: string; amountCents: number; balanceAfterCents: number };

export interface AccountCreditLine { id: string; kind: 'OVERPAYMENT' | 'APPLIED' | 'REFUNDED' | 'REVERSED'; date: string; deltaCents: number; balanceAfterCents: number; refundTender: string | null }

export interface MoneyView {
  version: string;
  /** What the patient owes, carried forward. Derived from the rows — never stored. */
  balanceCents: number;
  /** ACCOUNT CREDIT ($), the patient's money held for them. Not membership credits. */
  accountCreditCents: number;
  posted: PostedEntry[];
  accountCredit: AccountCreditLine[];
}

// A tax line ranks with its charge: the sort is stable, so it stays directly under the product it is for.
const ORDER: Record<PostedEntry['kind'], number> = { charge: 0, tax: 0, settled_before_tracking: 1, account_credit_applied: 2, payment: 3, reversal: 4 };

export async function moneyView(tx: Tx, patientId: string, today: string): Promise<MoneyView> {
  const unsorted = await tx.revenueEvent.findMany({
    where: { patientId, paymentType: { not: 'DUES' } },
    include: { promotion: { select: { name: true } }, preTracking: { select: { revenueEventId: true } }, openCharge: { select: { addedAt: true, createdAt: true } } },
  });
  // The same order as the balance (lib/money.ts chargesOf): when recorded, then — for visits checked out together — when the visit was.
  const starts = new Map((await tx.booking.findMany({ where: { id: { in: unsorted.map((c) => c.bookingId).filter((x): x is string => !!x) } }, select: { id: true, startTime: true } }))
    .map((b) => [b.id, b.startTime.getTime()]));
  const startOf = (c: (typeof unsorted)[number]) => (c.bookingId ? (starts.get(c.bookingId) ?? Infinity) : Infinity);
  // Rev 2.3: add-on lines (no visit) after the visits, in the order they were added.
  const addedOf = (c: (typeof unsorted)[number]) => (c.openCharge ? c.openCharge.addedAt.getTime() : Infinity);
  const writtenOf = (c: (typeof unsorted)[number]) => (c.openCharge ? c.openCharge.createdAt.getTime() : Infinity);
  const charges = unsorted.sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime() || startOf(x) - startOf(y)
    || addedOf(x) - addedOf(y) || writtenOf(x) - writtenOf(y) || (x.id < y.id ? -1 : 1));
  const payments = await tx.payment.findMany({
    where: { patientId },
    include: { allocations: true, reversal: true, refunds: true },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const credits = await tx.accountCreditEntry.findMany({ where: { patientId }, orderBy: { id: 'asc' } });
  const refunds = new Map((await tx.refund.findMany({ where: { patientId }, select: { id: true, tender: true } })).map((r) => [r.id, r.tender]));

  type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
  type Draft = DistOmit<PostedEntry, 'balanceAfterCents'> & { sort: number };
  const drafts: Draft[] = [];
  for (const c of charges) {
    const date = toLocalDateISO(c.occurredAt);
    drafts.push({
      kind: 'charge', id: c.id, date, at: c.occurredAt.toISOString(), bookingId: c.bookingId, serviceName: c.serviceName, subOption: c.subOption,
      lineKind: c.productId ? 'PRODUCT' : c.openChargeId ? 'ADDON_SERVICE' : 'VISIT',
      paymentType: c.paymentType as 'CASH' | 'MEMBER', listPriceCents: c.listPriceCents, discountCents: c.discountCents, promotionCents: c.promotionCents,
      promotionName: c.promotion?.name ?? null, adjustmentCents: c.adjustmentCents, adjustmentReason: c.adjustmentReason, taxCents: c.taxCents,
      amountCents: c.netPriceCents, sort: c.occurredAt.getTime(),
    });
    if (c.taxCents > 0) {
      drafts.push({ kind: 'tax', id: `${c.id}:tax`, revenueEventId: c.id, date, at: c.occurredAt.toISOString(), serviceName: c.serviceName, rateMilli: c.taxRateMilli, amountCents: c.taxCents, sort: c.occurredAt.getTime() });
    }
    if (c.preTracking && c.netPriceCents > 0) {
      drafts.push({ kind: 'settled_before_tracking', id: c.id, date, at: c.occurredAt.toISOString(), amountCents: -c.netPriceCents, sort: c.occurredAt.getTime() });
    }
  }
  for (const e of credits) {
    if (e.kind !== 'APPLIED') continue;
    drafts.push({ kind: 'account_credit_applied', id: String(e.id), date: fromDateOnly(e.entryOn), at: e.createdAt.toISOString(), revenueEventId: e.revenueEventId!, amountCents: e.deltaCents, sort: e.createdAt.getTime() });
  }
  for (const p of payments) {
    const allocated = p.allocations.reduce((n, a) => n + a.amountCents, 0);
    const toCredit = credits.filter((e) => e.kind === 'OVERPAYMENT' && e.paymentId === p.id).reduce((n, e) => n + e.deltaCents, 0);
    const refunded = p.refunds.reduce((n, r) => n + r.amountCents, 0);
    const date = fromDateOnly(p.collectedOn);
    const open = !p.reversal && p.refunds.length === 0;
    drafts.push({
      kind: 'payment', id: p.id, date, at: p.receivedAt.toISOString(), tender: p.tender, totalCents: p.amountCents, amountCents: -allocated,
      toAccountCreditCents: toCredit, refundedCents: refunded, reversed: !!p.reversal,
      reversibleByDesk: open && date === today, reversibleByAdmin: open, sort: p.receivedAt.getTime(),
    });
    if (p.reversal) {
      drafts.push({ kind: 'reversal', id: p.reversal.id, paymentId: p.id, date: fromDateOnly(p.reversal.reversedOn), at: p.reversal.reversedAt.toISOString(), reason: p.reversal.reason, amountCents: allocated, sort: p.reversal.reversedAt.getTime() });
    }
  }
  drafts.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.sort - y.sort || ORDER[x.kind] - ORDER[y.kind]));

  let running = 0;
  const posted = drafts.map(({ sort: _s, ...d }) => { running += d.amountCents; return { ...d, balanceAfterCents: running } as PostedEntry; });

  let held = 0;
  const accountCredit: AccountCreditLine[] = credits.map((e) => {
    held += e.deltaCents;
    return { id: String(e.id), kind: e.kind, date: fromDateOnly(e.entryOn), deltaCents: e.deltaCents, balanceAfterCents: held, refundTender: e.refundId ? (refunds.get(e.refundId) ?? null) : null };
  });

  return {
    version: await ledgerVersion(tx, patientId, today),
    balanceCents: await balanceOf(tx, patientId),
    accountCreditCents: await accountCreditOf(tx, patientId),
    posted, accountCredit,
  };
}
