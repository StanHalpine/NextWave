/**
 * Accounting for the money layer (Phase 2b, rev 2.2; design §7). Aggregates and an admin review list — no patient is named, as everywhere
 * in Accounting.
 *
 *   collections   BILLED vs COLLECTED by day or month:
 *                   billed     visit charges' net, dated at check-out (the tier discounts, promotions and adjustments that made it beside it)
 *                   collected  money in, each on its own clinic day: payments by the day collected, less reversals and refunds on THEIR day
 *                   settled before tracking   charges that existed when payments started being tracked (decision 7): paid, not "collected"
 *                 with the outstanding balance and the account credit held, across all patients, as of now.
 *   review        every desk/admin adjustment, payment reversal and refund in the range: date, kind, service, amount, reason, who.
 */
import { Prisma } from '@prisma/client';
import { basePrisma } from './prismaBase.js';
import { config } from '../config.js';
import { localDayBounds } from './time.js';
import { utcTimestamp } from './sqlTime.js';
import type { Column, DateRange } from './reportFormat.js';
import type { Table } from './reports.js';

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const local = (col: Prisma.Sql) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${config.clinicTimezone})`;
const bounds = (r: DateRange) => ({ start: utcTimestamp(localDayBounds(r.from).dayStart), end: utcTimestamp(localDayBounds(r.to).dayEnd) });

export const COLLECTION_COLUMNS: Column[] = [
  { key: 'billedCents', label: 'Billed (net)', kind: 'money' },
  { key: 'tierDiscountCents', label: 'Tier discounts', kind: 'money' },
  { key: 'promotionCents', label: 'Promotions', kind: 'money' },
  { key: 'adjustmentCents', label: 'Adjustments', kind: 'money' },
  { key: 'collectedCents', label: 'Collected', kind: 'money' },
  { key: 'settledBeforeTrackingCents', label: 'Settled before tracking', kind: 'money' },
];

export async function collectionsTable(range: DateRange, group: 'day' | 'month'): Promise<Table & { summary: Record<string, number> }> {
  const fmt = group === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
  const { start, end } = bounds(range);
  const raw = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH ev AS (
      SELECT to_char(${local(Prisma.sql`e."occurredAt"`)}, ${fmt}) AS period,
             e."netPriceCents" AS billed, e."discountCents" AS tier, e."promotionCents" AS promo, e."adjustmentCents" AS adj,
             0 AS collected, CASE WHEN s."revenueEventId" IS NULL THEN 0 ELSE e."netPriceCents" END AS pre
        FROM "RevenueEvent" e LEFT JOIN "PreTrackingSettlement" s ON s."revenueEventId" = e."id"
       WHERE e."paymentType" <> 'DUES' AND e."occurredAt" >= ${start} AND e."occurredAt" < ${end}
      UNION ALL
      SELECT to_char(p."collectedOn", ${fmt}), 0, 0, 0, 0, p."amountCents", 0
        FROM "Payment" p WHERE p."collectedOn" BETWEEN ${range.from}::date AND ${range.to}::date
      UNION ALL
      SELECT to_char(r."reversedOn", ${fmt}), 0, 0, 0, 0, -p."amountCents", 0
        FROM "PaymentReversal" r JOIN "Payment" p ON p."id" = r."paymentId" WHERE r."reversedOn" BETWEEN ${range.from}::date AND ${range.to}::date
      UNION ALL
      SELECT to_char(f."refundedOn", ${fmt}), 0, 0, 0, 0, -f."amountCents", 0
        FROM "Refund" f WHERE f."refundedOn" BETWEEN ${range.from}::date AND ${range.to}::date
    )
    SELECT period, SUM(billed)::int AS "billedCents", SUM(tier)::int AS "tierDiscountCents", SUM(promo)::int AS "promotionCents",
           SUM(adj)::int AS "adjustmentCents", SUM(collected)::int AS "collectedCents", SUM(pre)::int AS "settledBeforeTrackingCents"
      FROM ev GROUP BY period ORDER BY period`;
  const key = group === 'day' ? 'day' : 'month';
  const rows = raw.map((r) => {
    const row: Record<string, string | number> = { [key]: String(r.period) };
    for (const c of COLLECTION_COLUMNS) row[c.key] = num(r[c.key]);
    return row;
  });
  const totals: Record<string, string | number> = { [key]: 'Total' };
  for (const c of COLLECTION_COLUMNS) totals[c.key] = rows.reduce((t, r) => t + (r[c.key] as number), 0);

  // As of now, across all patients: what is owed, and the account credit ($) held for patients.
  const [o] = await basePrisma.$queryRaw<Array<{ owed: number; held: number }>>`
    SELECT COALESCE((SELECT SUM(e."netPriceCents"
             - COALESCE((SELECT SUM(a."amountCents") FROM "PaymentAllocation" a WHERE a."revenueEventId" = e."id"
                          AND NOT EXISTS (SELECT 1 FROM "PaymentReversal" r WHERE r."paymentId" = a."paymentId")), 0)
             - COALESCE((SELECT SUM(-c."deltaCents") FROM "AccountCreditEntry" c WHERE c."revenueEventId" = e."id" AND c."kind" = 'APPLIED'), 0))
           FROM "RevenueEvent" e
          WHERE e."paymentType" <> 'DUES' AND NOT EXISTS (SELECT 1 FROM "PreTrackingSettlement" s WHERE s."revenueEventId" = e."id")), 0)::int AS owed,
           COALESCE((SELECT SUM("deltaCents") FROM "AccountCreditEntry"), 0)::int AS held`;
  return {
    columns: [{ key, label: group === 'day' ? 'Date' : 'Month', kind: 'text' }, ...COLLECTION_COLUMNS],
    rows, totals, summary: { outstandingNowCents: o!.owed, accountCreditHeldCents: o!.held },
  };
}

export const REVIEW_COLUMNS: Column[] = [
  { key: 'date', label: 'Date', kind: 'text' },
  { key: 'kind', label: 'What', kind: 'text' },
  { key: 'service', label: 'Service', kind: 'text' },
  { key: 'amountCents', label: 'Amount', kind: 'money' },
  { key: 'reason', label: 'Reason', kind: 'text' },
  { key: 'tender', label: 'Tender', kind: 'text' },
  { key: 'who', label: 'Recorded by', kind: 'text' },
  { key: 'ref', label: 'Reference id', kind: 'text' },
];

const REASON: Record<string, string> = {
  SERVICE_RECOVERY: 'Service recovery', PRICE_MATCH: 'Price match', COURTESY: 'Courtesy', BILLING_ERROR: 'Billing error', OTHER: 'Other',
  ENTERED_IN_ERROR: 'Entered in error', DECLINED: 'Declined', CHECK_RETURNED: 'Check returned', DUPLICATE: 'Duplicate',
};
const TENDER: Record<string, string> = { CASH: 'Cash', CARD: 'Card', CHECK: 'Check', HSA_FSA: 'HSA/FSA', OTHER: 'Other' };

/** Every adjustment, payment reversal and refund in the range, oldest first. No patient is named; the id is for the record. */
export async function reviewTable(range: DateRange): Promise<Table> {
  const { start, end } = bounds(range);
  const raw = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM (
      SELECT to_char(${local(Prisma.sql`e."occurredAt"`)}, 'YYYY-MM-DD') AS date, e."occurredAt" AS at, 'Adjustment' AS kind, e."serviceName" AS service,
             e."adjustmentCents" AS amount, e."adjustmentReason"::text AS reason, NULL::text AS tender, a."displayName" AS who, e."id" AS ref, 1 AS k
        FROM "RevenueEvent" e LEFT JOIN "Account" a ON a."id" = e."adjustedById"
       WHERE e."adjustmentCents" > 0 AND e."occurredAt" >= ${start} AND e."occurredAt" < ${end}
      UNION ALL
      SELECT to_char(r."reversedOn", 'YYYY-MM-DD'), r."reversedAt", 'Payment reversal', '', p."amountCents", r."reason"::text, p."tender"::text, a."displayName", p."id", 3
        FROM "PaymentReversal" r JOIN "Payment" p ON p."id" = r."paymentId" LEFT JOIN "Account" a ON a."id" = r."reversedById"
       WHERE r."reversedOn" BETWEEN ${range.from}::date AND ${range.to}::date
      UNION ALL
      SELECT to_char(f."refundedOn", 'YYYY-MM-DD'), f."refundedAt",
             CASE WHEN f."source" = 'OVERPAYMENT' THEN 'Refund of an overpayment' ELSE 'Refund of account credit' END, '', f."amountCents", '', f."tender"::text, a."displayName", f."id", 2
        FROM "Refund" f LEFT JOIN "Account" a ON a."id" = f."recordedById"
       WHERE f."refundedOn" BETWEEN ${range.from}::date AND ${range.to}::date
    ) t ORDER BY date, at, k, ref`;   // at the same instant: the adjustment, then a refund, then a reversal
  const rows = raw.map((r) => ({
    date: String(r.date), kind: String(r.kind), service: String(r.service ?? ''), amountCents: num(r.amount),
    reason: REASON[String(r.reason)] ?? '', tender: r.tender ? (TENDER[String(r.tender)] ?? String(r.tender)) : '', who: String(r.who ?? ''), ref: String(r.ref),
  }));
  return { columns: REVIEW_COLUMNS, rows, totals: { date: 'Total', kind: '', service: '', amountCents: rows.reduce((t, r) => t + r.amountCents, 0), reason: '', tender: '', who: '', ref: '' } };
}
