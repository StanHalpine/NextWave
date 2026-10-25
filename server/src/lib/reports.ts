/**
 * The numbers behind Accounting (admin) and Reports (front desk and admin).
 *
 * Every function here returns AGGREGATES: counts and sums grouped by a service, a day, a month, a tier, a payment
 * type or a provider — never a patient, a name, an encounter or a booking. That is what lets a front-desk
 * login read Reports and lets an export leave the building without carrying anyone's identity.
 *
 * Dates are the CLINIC's calendar. A range "2026-03-01 to 2026-03-31" is the 31 local days, so the day that has
 * 23 or 25 hours (the daylight-saving change) is still one day, and a check-out at 11:30 p.m. on the 31st
 * counts in March, whatever UTC says. Money is whole cents. Service revenue is RevenueEvent.netPriceCents of the visits (payment
 * type CASH or MEMBER): what the desk recorded collecting. Membership DUES are RevenueEvents of payment type DUES (lib/dues.ts) and
 * are NEVER mixed into service revenue: every service query below excludes them, and duesTable() reports them on their own.
 *
 * Indexes: each query bounds one indexed time column (RevenueEvent.occurredAt, Booking.startTime / (source, startTime),
 * Membership.startedOn) and aggregates what that range returns; scripts/perf-reports.ts times them on 50,000 visits.
 */

import { Prisma } from '@prisma/client';
import { config } from '../config.js';
import { basePrisma } from './prismaBase.js';
import { DEMAND_CATEGORIES, OTHER_DEMAND, WEEKDAY, demandCategoryOf, eachDay, eachMonth, type Column, type DateRange } from './reportFormat.js';
import { utcTimestamp } from './sqlTime.js';
import { localDayBounds } from './time.js';

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const tz = () => config.clinicTimezone;
/** "A timestamp stored in UTC, as the clinic's wall-clock time". */
const local = (col: Prisma.Sql) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz()})`;
/** The half-open UTC window [start, end) holding the clinic-local days `from`..`to`. Bound with utcTimestamp: see lib/sqlTime.ts. */
const bounds = (r: DateRange) => ({ start: utcTimestamp(localDayBounds(r.from).dayStart), end: utcTimestamp(localDayBounds(r.to).dayEnd) });
const ATTENDED = Prisma.sql`('CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT')`;

// =====================================================================================================
// Accounting — built on RevenueEvent
// =====================================================================================================

export interface RevenueFilter {
  range: DateRange;
  serviceId?: string | undefined;
  /** CASH and MEMBER filter the visits; DUES shows only the dues table (and no visits). */
  paymentType?: 'MEMBER' | 'CASH' | 'DUES' | undefined;
  /** A Staff id: the provider the visit was booked with. */
  providerId?: string | undefined;
}

export type RevenueGroup = 'service' | 'month' | 'day' | 'serviceMonth' | 'paymentType' | 'bucket' | 'provider' | 'category' | 'discountCategory' | 'tier' | 'lineKind';
export const REVENUE_GROUPS: readonly RevenueGroup[] = ['service', 'month', 'day', 'serviceMonth', 'paymentType', 'bucket', 'provider', 'category', 'discountCategory', 'tier', 'lineKind'];

export const METRIC_COLUMNS: Column[] = [
  // Rev 2.3: a row counts visits AND add-on and product lines (one unit each).
  { key: 'visits', label: 'Visits / items', kind: 'int' },
  { key: 'listCents', label: 'List price', kind: 'money' },
  { key: 'discountCents', label: 'Discount', kind: 'money' },
  // Rev 2.2: a promotion (instead of the tier discount, never both) and a one-off adjustment are their own reductions.
  { key: 'promotionCents', label: 'Promotions', kind: 'money' },
  { key: 'adjustmentCents', label: 'Adjustments', kind: 'money' },
  { key: 'netCents', label: 'Net', kind: 'money' },
  { key: 'coveredCents', label: 'Covered by membership', kind: 'money' },
  { key: 'credits', label: 'Credits redeemed', kind: 'int' },
  // Rev 2.3 (decision 2): sales tax on products — billed with the line, NOT revenue, so it is outside the identity
  // list = discount + promotions + adjustments + covered + net.
  { key: 'taxCents', label: 'Sales tax (not revenue)', kind: 'money' },
];

/** How a visit was paid, in the words the desk uses. A member who pays cash is a CASH payment by a member. */
export const BUCKET_LABEL: Record<string, string> = {
  NON_MEMBER_CASH: 'Non-member — cash',
  MEMBER_CASH: 'Member — cash',
  MEMBER_CREDITS: 'Member — credits',
  MEMBER_PERK: 'Member — included perk',
};
export const PAYMENT_LABEL: Record<string, string> = { CASH: 'Cash', MEMBER: 'Covered by membership', DUES: 'Membership dues' };

export interface Dimension { select: Prisma.Sql; join: Prisma.Sql; groupBy: Prisma.Sql; orderBy: Prisma.Sql; columns: Column[] }

/** Rev 2.3: what a charge line is for — a service (a visit or an add-on) or a product. */
const ITEM = Prisma.sql`COALESCE(e."serviceId", 'product:' || e."productId")`;
/** Rev 2.3: the kind of charge, derived from its columns (RevenueEvent_kind), numbered so the rows come out in this order. */
const LINE_KIND = Prisma.sql`CASE WHEN e."productId" IS NOT NULL THEN '3 Products' WHEN e."openChargeId" IS NOT NULL THEN '2 Add-on services' ELSE '1 Visits' END`;

export function dimension(g: RevenueGroup): Dimension {
  const none = Prisma.empty;
  const month = Prisma.sql`to_char(${local(Prisma.sql`e."occurredAt"`)}, 'YYYY-MM')`;
  const dayExpr = Prisma.sql`to_char(${local(Prisma.sql`e."occurredAt"`)}, 'YYYY-MM-DD')`;
  switch (g) {
    // A row per service or per product (rev 2.3: a product line has no service id).
    case 'service': return { select: Prisma.sql`MAX(e."serviceName") AS "service"`, join: none, groupBy: Prisma.sql`${ITEM}`, orderBy: Prisma.sql`MAX(e."serviceName")`, columns: [{ key: 'service', label: 'Service / product', kind: 'text' }] };
    case 'month': return { select: Prisma.sql`${month} AS "month"`, join: none, groupBy: Prisma.sql`1`, orderBy: Prisma.sql`1`, columns: [{ key: 'month', label: 'Month', kind: 'text' }] };
    case 'day': return { select: Prisma.sql`${dayExpr} AS "day"`, join: none, groupBy: Prisma.sql`1`, orderBy: Prisma.sql`1`, columns: [{ key: 'day', label: 'Date', kind: 'text' }] };
    case 'serviceMonth': return {
      select: Prisma.sql`${month} AS "month", MAX(e."serviceName") AS "service"`, join: none,
      groupBy: Prisma.sql`1, ${ITEM}`, orderBy: Prisma.sql`1, MAX(e."serviceName")`,
      columns: [{ key: 'month', label: 'Month', kind: 'text' }, { key: 'service', label: 'Service / product', kind: 'text' }],
    };
    case 'paymentType': return { select: Prisma.sql`e."paymentType"::text AS "paymentType"`, join: none, groupBy: Prisma.sql`e."paymentType"`, orderBy: Prisma.sql`e."paymentType"::text`, columns: [{ key: 'paymentType', label: 'Payment', kind: 'text' }] };
    case 'bucket': {
      const bucket = Prisma.sql`CASE WHEN e."paymentType" = 'CASH' AND e."planCode" IS NULL THEN 'NON_MEMBER_CASH'
        WHEN e."paymentType" = 'CASH' THEN 'MEMBER_CASH' WHEN e."memberBenefit" = 'PERK' THEN 'MEMBER_PERK' ELSE 'MEMBER_CREDITS' END`;
      return { select: Prisma.sql`${bucket} AS "bucket"`, join: none, groupBy: Prisma.sql`1`, orderBy: Prisma.sql`1`, columns: [{ key: 'bucket', label: 'Who paid, and how', kind: 'text' }] };
    }
    case 'provider': return {
      select: Prisma.sql`COALESCE(MAX(s."name"), 'Unassigned') AS "provider"`, join: Prisma.sql`LEFT JOIN "Staff" s ON s."id" = e."staffId"`,
      groupBy: Prisma.sql`e."staffId"`, orderBy: Prisma.sql`COALESCE(MAX(s."name"), 'Unassigned')`, columns: [{ key: 'provider', label: 'Provider', kind: 'text' }],
    };
    case 'category': return { select: Prisma.sql`e."serviceCategory" AS "category"`, join: none, groupBy: Prisma.sql`e."serviceCategory"`, orderBy: Prisma.sql`e."serviceCategory"`, columns: [{ key: 'category', label: 'Discipline', kind: 'text' }] };
    case 'discountCategory': return { select: Prisma.sql`COALESCE(e."discountCategory", '(no discount category)') AS "discountCategory"`, join: none, groupBy: Prisma.sql`COALESCE(e."discountCategory", '(no discount category)')`, orderBy: Prisma.sql`COALESCE(e."discountCategory", '(no discount category)')`, columns: [{ key: 'discountCategory', label: 'Discount category', kind: 'text' }] };
    case 'lineKind': return { select: Prisma.sql`${LINE_KIND} AS "lineKind"`, join: none, groupBy: Prisma.sql`1`, orderBy: Prisma.sql`1`, columns: [{ key: 'lineKind', label: 'Visits, add-ons and products', kind: 'text' }] };
    case 'tier': return { select: Prisma.sql`COALESCE(e."planCode", 'Non-member') AS "tier"`, join: none, groupBy: Prisma.sql`COALESCE(e."planCode", 'Non-member')`, orderBy: Prisma.sql`COALESCE(e."planCode", 'Non-member')`, columns: [{ key: 'tier', label: 'Tier', kind: 'text' }] };
  }
}

function revenueWhere(f: RevenueFilter): Prisma.Sql {
  const { start, end } = bounds(f.range);
  // Dues are not visits and never part of service revenue: they have their own table (duesTable).
  return Prisma.sql`e."occurredAt" >= ${start} AND e."occurredAt" < ${end} AND e."paymentType" <> 'DUES'
    ${f.serviceId ? Prisma.sql`AND e."serviceId" = ${f.serviceId}` : Prisma.empty}
    ${f.paymentType && f.paymentType !== 'DUES' ? Prisma.sql`AND e."paymentType" = ${f.paymentType}::"PaymentType"` : Prisma.empty}
    ${f.providerId ? Prisma.sql`AND e."staffId" = ${f.providerId}` : Prisma.empty}`;
}

export interface Table {
  columns: Column[];
  rows: Array<Record<string, string | number>>;
  totals: Record<string, string | number>;
}

const sumMetrics = (rows: Array<Record<string, string | number>>): Record<string, number> =>
  Object.fromEntries(METRIC_COLUMNS.map((c) => [c.key, rows.reduce((t, r) => t + (r[c.key] as number), 0)]));

// ---- the statements themselves: exported so scripts/perf-reports.ts can EXPLAIN exactly what runs ---------------------

export const revenueSql = (f: RevenueFilter, d: Dimension): Prisma.Sql => Prisma.sql`
    SELECT ${d.select},
           -- visits, and units on add-on and product lines (rev 2.3: a line may carry a quantity)
           COALESCE(SUM(e."quantity"), 0)::int AS "visits",
           COALESCE(SUM(e."listPriceCents"), 0)::bigint AS "listCents",
           COALESCE(SUM(e."discountCents"), 0)::bigint AS "discountCents",
           COALESCE(SUM(e."promotionCents"), 0)::bigint AS "promotionCents",
           COALESCE(SUM(e."adjustmentCents"), 0)::bigint AS "adjustmentCents",
           COALESCE(SUM(e."netPriceCents"), 0)::bigint AS "netCents",
           -- what the membership covered: whatever is left of the list price after every reduction and the net (only a member visit has any)
           COALESCE(SUM(COALESCE(e."listPriceCents", 0) - e."discountCents" - e."promotionCents" - e."adjustmentCents" - e."netPriceCents"), 0)::bigint AS "coveredCents",
           COALESCE(SUM(e."creditsRedeemed"), 0)::bigint AS "credits",
           COALESCE(SUM(e."taxCents"), 0)::bigint AS "taxCents"
    FROM "RevenueEvent" e ${d.join}
    WHERE ${revenueWhere(f)}
    GROUP BY ${d.groupBy}
    ORDER BY ${d.orderBy}`;

/** Dues billed, grouped by the dimension that means something for dues (month, day, tier) — see duesDimension. */
export const duesSql = (f: RevenueFilter, d: Dimension): Prisma.Sql => {
  const { start, end } = bounds(f.range);
  return Prisma.sql`
    SELECT ${d.select},
           COUNT(*)::int AS "duesCount",
           COALESCE(SUM(e."netPriceCents"), 0)::bigint AS "duesCents"
    FROM "RevenueEvent" e
    WHERE e."paymentType" = 'DUES' AND e."occurredAt" >= ${start} AND e."occurredAt" < ${end}
    GROUP BY ${d.groupBy}
    ORDER BY ${d.orderBy}`;
};

export const signupsSql = (range: DateRange): Prisma.Sql => Prisma.sql`
    SELECT to_char(m."startedOn", 'YYYY-MM') AS "month", p."code" AS "plan", COUNT(*)::int AS "n"
    FROM "Membership" m JOIN "MembershipPlan" p ON p."id" = m."planId"
    WHERE m."startedOn" >= ${range.from}::date AND m."startedOn" <= ${range.to}::date
    GROUP BY 1, 2`;

export const walkInsByDaySql = (range: DateRange): Prisma.Sql => { const { start, end } = bounds(range); return Prisma.sql`
    SELECT to_char(${local(Prisma.sql`b."startTime"`)}, 'YYYY-MM-DD') AS "day", COUNT(*)::int AS "n"
    FROM "Booking" b WHERE b."source" = 'WALK_IN' AND b."status" = 'CONFIRMED' AND b."startTime" >= ${start} AND b."startTime" < ${end}
    GROUP BY 1`; };

export const walkInsByHourSql = (range: DateRange): Prisma.Sql => { const { start, end } = bounds(range); return Prisma.sql`
    SELECT EXTRACT(HOUR FROM ${local(Prisma.sql`b."startTime"`)})::int AS "hour", COUNT(*)::int AS "n"
    FROM "Booking" b WHERE b."source" = 'WALK_IN' AND b."status" = 'CONFIRMED' AND b."startTime" >= ${start} AND b."startTime" < ${end}
    GROUP BY 1`; };

export const attendedVisitsSql = (range: DateRange): Prisma.Sql => { const { start, end } = bounds(range); return Prisma.sql`
    SELECT COUNT(*)::int AS "n" FROM "Booking" b JOIN "Encounter" e ON e."bookingId" = b."id"
    WHERE b."status" = 'CONFIRMED' AND e."deletedAt" IS NULL AND e."status" IN ${ATTENDED} AND b."startTime" >= ${start} AND b."startTime" < ${end}`; };

export const weekendSql = (range: DateRange): Prisma.Sql => { const { start, end } = bounds(range); return Prisma.sql`
    SELECT EXTRACT(ISODOW FROM ${local(Prisma.sql`b."startTime"`)})::int AS "dow",
           COUNT(*) FILTER (WHERE e."status" IN ${ATTENDED})::int AS "visits",
           COUNT(*) FILTER (WHERE e."status" = 'NO_SHOW')::int AS "noShows"
    FROM "Booking" b JOIN "Encounter" e ON e."bookingId" = b."id"
    WHERE b."status" = 'CONFIRMED' AND e."deletedAt" IS NULL AND b."startTime" >= ${start} AND b."startTime" < ${end}
    GROUP BY 1`; };

export const demandSql = (range: DateRange): Prisma.Sql => { const { start, end } = bounds(range); return Prisma.sql`
    SELECT sv."slug" AS "slug", COUNT(*)::int AS "booked",
           COUNT(*) FILTER (WHERE e."status" IN ${ATTENDED})::int AS "attended",
           COUNT(*) FILTER (WHERE e."status" = 'NO_SHOW')::int AS "noShows"
    FROM "Booking" b JOIN "Service" sv ON sv."id" = b."serviceId" LEFT JOIN "Encounter" e ON e."bookingId" = b."id" AND e."deletedAt" IS NULL
    WHERE b."status" = 'CONFIRMED' AND b."startTime" >= ${start} AND b."startTime" < ${end}
    GROUP BY sv."slug"`; };

/** Revenue grouped one way, with the list, discount and net totals. */
export async function revenueTable(f: RevenueFilter, group: RevenueGroup): Promise<Table> {
  const d = dimension(group);
  if (f.paymentType === 'DUES') {
    const first = d.columns[0]!;
    return { columns: [...d.columns, ...METRIC_COLUMNS], rows: [], totals: { [first.key]: 'Total', ...sumMetrics([]) } };   // dues only: no visits
  }
  const raw = await basePrisma.$queryRaw<Array<Record<string, unknown>>>(revenueSql(f, d));
  const rows = raw.map((r) => {
    const row: Record<string, string | number> = {};
    for (const c of d.columns) {
      const v = String(r[c.key]);
      row[c.key] = group === 'bucket' ? (BUCKET_LABEL[v] ?? v) : group === 'paymentType' ? (PAYMENT_LABEL[v] ?? v) : group === 'lineKind' ? v.slice(2) : v;
    }
    for (const c of METRIC_COLUMNS) row[c.key] = num(r[c.key]);
    return row;
  });
  if (group === 'bucket') rows.sort((a, b) => Object.values(BUCKET_LABEL).indexOf(String(a.bucket)) - Object.values(BUCKET_LABEL).indexOf(String(b.bucket)));
  const first = d.columns[0]!;
  return { columns: [...d.columns, ...METRIC_COLUMNS], rows, totals: { [first.key]: 'Total', ...sumMetrics(rows) } };
}

export const DUES_COLUMNS: Column[] = [
  { key: 'duesCount', label: 'Months billed', kind: 'int' },
  { key: 'duesCents', label: 'Dues billed', kind: 'money' },
];
export const DUES_TITLE = 'Membership dues (billed)';

export interface DuesTable extends Table {
  /** Why the table is empty or what it means, when that is not obvious from the rows. */
  note: string | null;
}

/**
 * Membership dues billed in the range, separately from service revenue. Totalled by what the view totals by where that means
 * something for dues (month, day, tier; a month-and-service view totals dues by month); by anything else — a service, a provider,
 * a payment type — dues have no such attribute, so they are one line. Dues belong to no service or provider and are not cash or
 * credits, so a service, provider or CASH/MEMBER filter leaves them out, and a DUES payment filter leaves only them.
 */
export async function duesTable(f: RevenueFilter, group: RevenueGroup): Promise<DuesTable> {
  const by: Record<string, RevenueGroup | undefined> = { month: 'month', serviceMonth: 'month', day: 'day', tier: 'tier', bucket: 'tier' };
  const g = by[group];
  const d = g ? dimension(g) : null;
  const columns: Column[] = [...(d ? d.columns : [{ key: 'line', label: 'Revenue line', kind: 'text' as const }]), ...DUES_COLUMNS];
  const first = columns[0]!;
  const empty = (note: string): DuesTable => ({ columns, rows: [], totals: { [first.key]: 'Total', duesCount: 0, duesCents: 0 }, note });
  if (f.serviceId || f.providerId) return empty('Dues belong to no service or provider, so they are left out when you filter by one.');
  if (f.paymentType === 'CASH' || f.paymentType === 'MEMBER') return empty('Dues are neither cash nor credits, so they are left out when you filter by that payment type.');

  const raw = await basePrisma.$queryRaw<Array<Record<string, unknown>>>(
    duesSql(f, d ?? { select: Prisma.sql`${DUES_TITLE}::text AS "line"`, join: Prisma.empty, groupBy: Prisma.sql`1`, orderBy: Prisma.sql`1`, columns: [] }),
  );
  const rows = raw.map((r) => {
    const row: Record<string, string | number> = { [first.key]: String(r[first.key]) };
    for (const c of DUES_COLUMNS) row[c.key] = num(r[c.key]);
    return row;
  });
  return {
    columns, rows, note: null,
    totals: { [first.key]: 'Total', duesCount: rows.reduce((t, r) => t + (r.duesCount as number), 0), duesCents: rows.reduce((t, r) => t + (r.duesCents as number), 0) },
  };
}

/** Members and non-members, side by side: each payment bucket, then the two subtotals. */
export async function memberSplit(f: RevenueFilter) {
  const table = await revenueTable(f, 'bucket');
  const sub = (label: string, members: boolean): Record<string, string | number> =>
    ({ bucket: label, ...sumMetrics(table.rows.filter((r) => String(r.bucket).startsWith('Member') === members)) });
  return { ...table, subtotals: [sub('All members', true), sub('Non-members', false)] };
}

export async function revenueFilterOptions() {
  const [services, staff] = await Promise.all([
    basePrisma.service.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
    basePrisma.staff.findMany({ where: { role: { not: 'FRONT_DESK' } }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  return { services, providers: staff, paymentTypes: [{ value: 'CASH', label: PAYMENT_LABEL.CASH! }, { value: 'MEMBER', label: PAYMENT_LABEL.MEMBER! }, { value: 'DUES', label: PAYMENT_LABEL.DUES! }] };
}

// =====================================================================================================
// Reports — counts only
// =====================================================================================================

/** New memberships per month, by tier: Membership.startedOn (the clinic-local day the member joined). */
export async function signupsByMonth(range: DateRange) {
  const [raw, allPlans] = await Promise.all([
    basePrisma.$queryRaw<Array<{ month: string; plan: string; n: number }>>(signupsSql(range)),
    basePrisma.membershipPlan.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, active: true } }),
  ]);
  // A plan that is switched off appears only if someone joined it in this range.
  const plans = allPlans.filter((p) => p.active || raw.some((r) => r.plan === p.code));
  const counts = new Map(raw.map((r) => [`${r.month}|${r.plan}`, num(r.n)]));
  const columns: Column[] = [{ key: 'month', label: 'Month', kind: 'text' }, ...plans.map((p) => ({ key: p.code, label: p.name, kind: 'int' as const })), { key: 'total', label: 'Total', kind: 'int' }];
  const rows = eachMonth(range).map((month) => {
    const row: Record<string, string | number> = { month };
    for (const p of plans) row[p.code] = counts.get(`${month}|${p.code}`) ?? 0;
    row.total = plans.reduce((t, p) => t + (row[p.code] as number), 0);
    return row;
  });
  const totals: Record<string, string | number> = { month: 'Total' };
  for (const c of columns.slice(1)) totals[c.key] = rows.reduce((t, r) => t + (r[c.key] as number), 0);
  return { columns, rows, totals };
}

/** Confirmed walk-ins by the clinic-local day and hour they were seen, and their share of all visits. */
export async function walkIns(range: DateRange) {
  const [byDay, byHour, all] = await Promise.all([
    basePrisma.$queryRaw<Array<{ day: string; n: number }>>(walkInsByDaySql(range)),
    basePrisma.$queryRaw<Array<{ hour: number; n: number }>>(walkInsByHourSql(range)),
    basePrisma.$queryRaw<Array<{ n: number }>>(attendedVisitsSql(range)),
  ]);
  const dayN = new Map(byDay.map((r) => [r.day, num(r.n)]));
  const hourN = new Map(byHour.map((r) => [num(r.hour), num(r.n)]));
  const days = eachDay(range).map((day) => ({ day, walkIns: dayN.get(day) ?? 0 }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2, '0')}:00`, walkIns: hourN.get(h) ?? 0 }));
  const total = days.reduce((t, r) => t + r.walkIns, 0);
  const allVisits = num(all[0]?.n);
  return {
    byDay: {
      columns: [{ key: 'day', label: 'Date', kind: 'text' }, { key: 'walkIns', label: 'Walk-ins', kind: 'int' }] as Column[],
      rows: days as Array<Record<string, string | number>>, totals: { day: 'Total', walkIns: total } as Record<string, string | number>,
    },
    byHour: {
      columns: [{ key: 'label', label: 'Hour (clinic time)', kind: 'text' }, { key: 'walkIns', label: 'Walk-ins', kind: 'int' }] as Column[],
      rows: hours as Array<Record<string, string | number>>, totals: { label: 'Total', walkIns: total } as Record<string, string | number>,
    },
    summary: { walkIns: total, allVisits, sharePercent: allVisits > 0 ? Math.round((total / allVisits) * 1000) / 10 : 0 },
  };
}

/** Attended visits and no-shows by weekday, and the weekend's share. Weekday is the clinic-local day of the appointment. */
export async function weekendVisits(range: DateRange) {
  const raw = await basePrisma.$queryRaw<Array<{ dow: number; visits: number; noShows: number }>>(weekendSql(range));
  const by = new Map(raw.map((r) => [num(r.dow), r]));
  const rows = WEEKDAY.map((name, i) => {
    const r = by.get(i + 1);
    return { weekday: name, kind: i >= 5 ? 'Weekend' : 'Weekday', visits: num(r?.visits), noShows: num(r?.noShows) };
  });
  const sum = (kind: string, key: 'visits' | 'noShows') => rows.filter((r) => r.kind === kind).reduce((t, r) => t + r[key], 0);
  const weekend = sum('Weekend', 'visits'); const weekday = sum('Weekday', 'visits');
  return {
    columns: [{ key: 'weekday', label: 'Day', kind: 'text' }, { key: 'kind', label: '', kind: 'text' }, { key: 'visits', label: 'Visits', kind: 'int' }, { key: 'noShows', label: 'No-shows', kind: 'int' }] as Column[],
    rows: rows as Array<Record<string, string | number>>,
    totals: { weekday: 'Total', kind: '', visits: weekend + weekday, noShows: sum('Weekend', 'noShows') + sum('Weekday', 'noShows') } as Record<string, string | number>,
    summary: {
      weekendVisits: weekend, weekdayVisits: weekday, weekendNoShows: sum('Weekend', 'noShows'),
      weekendSharePercent: weekend + weekday > 0 ? Math.round((weekend / (weekend + weekday)) * 1000) / 10 : 0,
      saturdayVisits: rows[5]!.visits, sundayVisits: rows[6]!.visits,
    },
  };
}

/** Confirmed appointments by the six demand categories (see DEMAND_CATEGORIES): booked, attended, no-shows. */
export async function serviceDemand(range: DateRange) {
  const raw = await basePrisma.$queryRaw<Array<{ slug: string; booked: number; attended: number; noShows: number }>>(demandSql(range));
  const cats = [...DEMAND_CATEGORIES.map((c) => ({ key: c.key as string, label: c.label as string })), { key: OTHER_DEMAND.key as string, label: OTHER_DEMAND.label as string }];
  const acc = new Map(cats.map((c) => [c.key, { category: c.label, booked: 0, attended: 0, noShows: 0 }]));
  for (const r of raw) {
    const a = acc.get(demandCategoryOf(r.slug).key)!;
    a.booked += num(r.booked); a.attended += num(r.attended); a.noShows += num(r.noShows);
  }
  const rows = [...acc.values()] as Array<Record<string, string | number>>;
  const total = (k: string) => rows.reduce((t, r) => t + (r[k] as number), 0);
  return {
    columns: [{ key: 'category', label: 'Category', kind: 'text' }, { key: 'booked', label: 'Booked', kind: 'int' }, { key: 'attended', label: 'Attended', kind: 'int' }, { key: 'noShows', label: 'No-shows', kind: 'int' }] as Column[],
    rows, totals: { category: 'Total', booked: total('booked'), attended: total('attended'), noShows: total('noShows') } as Record<string, string | number>,
    mapping: DEMAND_CATEGORIES.map((c) => ({ category: c.label, services: [...c.slugs] })),
  };
}
