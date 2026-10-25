/**
 * Accounting (admin only) and Reports (front desk and admin).
 *
 *   GET /api/accounting/options          the service / provider / payment-type choices for the custom view
 *   GET /api/accounting/:view            monthly | daily | members | custom        ?from=&to=[&format=csv]
 *   GET /api/reports/:view               signups | walkins-day | walkins-hour | weekend | demand   ?from=&to=[&format=csv]
 *
 * `from` and `to` are clinic-local calendar days (YYYY-MM-DD), both inclusive; give both or neither, and neither
 * means the current month. The custom view also takes serviceId, paymentType (CASH | MEMBER | DUES), providerId and
 * `group` (how to total it). Every other parameter is refused rather than ignored, so a typo cannot quietly
 * return an unfiltered number.
 *
 * Every Accounting view carries two tables: service revenue, and the membership dues billed, kept apart (a CSV has both, a blank line
 * between). A Report has one.
 *
 * Everything returned — JSON or CSV — is an aggregate: counts and sums grouped by a service, day, hour, month, tier,
 * payment type or provider. No patient, booking or encounter is named or identified (lib/reports.ts).
 *
 * Every successful view writes a READ audit row and every CSV an EXPORT row, each carrying the view and the filter
 * parameters it was asked with (ids and dates; never a value). Audit rows from this file are NOT de-duplicated: a
 * second look at the same report is a second row.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { prisma } from '../lib/prisma.js';
import {
  duesTable, memberSplit, revenueFilterOptions, revenueTable, serviceDemand, signupsByMonth, walkIns, weekendVisits,
  DUES_TITLE, REVENUE_GROUPS, type DuesTable, type RevenueFilter, type RevenueGroup, type Table,
} from '../lib/reports.js';
import { ReportError, resolveRange, toCsv, toCsvSections, type DateRange } from '../lib/reportFormat.js';
import { collectionsTable, reviewTable } from '../lib/moneyReports.js';
import { requireRole } from '../middleware/session.js';

export const reportsRouter = Router();

interface ViewResult extends Omit<Table, 'totals'> {
  /** The totals row — null where adding the rows up would mean nothing (the review list: subtotals per kind instead). */
  totals: Table['totals'] | null;
  /** Rows shown after the body and before the totals (e.g. members vs non-members). */
  subtotals?: Array<Record<string, string | number>>;
  /** Membership dues billed, kept apart from the service revenue above. Accounting views only. */
  dues?: DuesTable;
  /** Headline figures for the screen; not exported. */
  summary?: Record<string, number>;
  /** How the numbers were arrived at, in words. */
  notes?: string[];
}
interface ViewDef<Q> { title: string; parse: z.ZodType<Q>; run(range: DateRange, q: Q): Promise<ViewResult>; filters?(q: Q): Record<string, string> }

const dateParams = { from: z.string().max(10).optional(), to: z.string().max(10).optional(), format: z.enum(['json', 'csv']).optional() };
const plain = z.object(dateParams).strict();
const custom = z.object({
  ...dateParams,
  serviceId: z.string().min(1).max(64).optional(),
  paymentType: z.enum(['CASH', 'MEMBER', 'DUES']).optional(),
  providerId: z.string().min(1).max(64).optional(),
  group: z.enum(REVENUE_GROUPS as [RevenueGroup, ...RevenueGroup[]]).optional(),
}).strict();
type Plain = z.infer<typeof plain>;
const collections = z.object({ ...dateParams, group: z.enum(['day', 'month']).optional() }).strict();
type Collections = z.infer<typeof collections>;
type Custom = z.infer<typeof custom>;

const MONEY_NOTE = 'Service revenue is what the front desk recorded at check-out: net = list price − member discount (or a promotion, whichever was better — never both) − any one-off adjustment (negative when an admin raised a price above list), and 0 for a visit a membership covered (credits or a perk), shown under "Covered by membership". Add-on services and retail products are rows like visits; sales tax on products is its own column and is not revenue. These are amounts billed; what was actually collected is under "Billed vs collected". Membership dues are billed when each month\'s credits are granted and are shown below, separately: they are never added into service revenue. Dues are collected outside this system, so a dues line means "billed", not "paid".';

const ACCOUNTING: Record<string, ViewDef<any>> = {
  monthly: {
    title: 'Monthly revenue by service', parse: plain,
    run: async (range) => ({ ...(await revenueTable({ range }, 'serviceMonth')), dues: await duesTable({ range }, 'serviceMonth'), notes: [MONEY_NOTE] }),
  } satisfies ViewDef<Plain>,
  daily: {
    title: 'Daily revenue', parse: plain,
    run: async (range) => ({ ...(await revenueTable({ range }, 'day')), dues: await duesTable({ range }, 'day'), notes: [MONEY_NOTE] }),
  } satisfies ViewDef<Plain>,
  members: {
    title: 'Member and non-member revenue', parse: plain,
    run: async (range) => ({
      ...(await memberSplit({ range })), dues: await duesTable({ range }, 'bucket'),
      notes: [MONEY_NOTE, 'A member is someone with an ACTIVE membership at check-out. A paused or cancelled member who pays cash counts as a non-member. Dues are billed to members by tier, below.'],
    }),
  } satisfies ViewDef<Plain>,
  custom: {
    title: 'Custom revenue view', parse: custom,
    async run(range, q: Custom) {
      const f: RevenueFilter = { range, serviceId: q.serviceId, paymentType: q.paymentType, providerId: q.providerId };
      if (q.serviceId && !(await prisma.service.findUnique({ where: { id: q.serviceId }, select: { id: true } }))) throw new ReportError('unknown_service', 'That service does not exist.');
      if (q.providerId && !(await prisma.staff.findUnique({ where: { id: q.providerId }, select: { id: true } }))) throw new ReportError('unknown_provider', 'That provider does not exist.');
      const group = q.group ?? 'service';
      return { ...(await revenueTable(f, group)), dues: await duesTable(f, group), notes: [MONEY_NOTE] };
    },
    filters: (q: Custom) => ({
      ...(q.serviceId ? { serviceId: q.serviceId } : {}), ...(q.paymentType ? { paymentType: q.paymentType } : {}),
      ...(q.providerId ? { providerId: q.providerId } : {}), group: q.group ?? 'service',
    }),
  } satisfies ViewDef<Custom>,
};

// Phase 2b (rev 2.2): the money layer's two views. Aggregates and a review list — no patient is named.
ACCOUNTING.collections = {
  title: 'Billed vs collected', parse: collections,
  run: async (range, q: Collections) => ({
    ...(await collectionsTable(range, q.group ?? 'day')),
    notes: [
      'Billed is what check-out recorded (net of the tier discount, a promotion — never both — and any adjustment), on the day of check-out. Collected is money in, each on its own day: payments on the day they were collected, less payment reversals and refunds on the day they were made.',
      'Settled before tracking: charges recorded before payments were tracked count as paid in full; they are not money collected in this range.',
      'Outstanding and account credit held are across all patients, as of now. Membership dues are billed only and are not in either.',
    ],
  }),
  filters: (q: Collections) => ({ group: q.group ?? 'day' }),
} satisfies ViewDef<Collections>;
ACCOUNTING.review = {
  title: 'Adjustments, reversals and refunds for review', parse: plain,
  run: async (range) => ({ ...(await reviewTable(range)), notes: ['Every one-off adjustment (front desk or admin), payment reversal and refund in the range. No patient is named; the reference id identifies the charge, payment or refund.'] }),
} satisfies ViewDef<Plain>;

const REPORTS: Record<string, ViewDef<any>> = {
  signups: {
    title: 'New memberships per month', parse: plain,
    run: (range) => signupsByMonth(range).then((t) => ({ ...t, notes: ['Counted on the day the membership started, by tier.'] })),
  } satisfies ViewDef<Plain>,
  'walkins-day': {
    title: 'Walk-in volume by day', parse: plain,
    run: (range) => walkIns(range).then((w) => ({ ...w.byDay, summary: w.summary, notes: ['Confirmed walk-in appointments, on the day they were seen. The share is walk-ins as a percent of every visit that was checked in.'] })),
  } satisfies ViewDef<Plain>,
  'walkins-hour': {
    title: 'Walk-in volume by hour', parse: plain,
    run: (range) => walkIns(range).then((w) => ({ ...w.byHour, summary: w.summary, notes: ['Hour of the day in clinic time, across the whole range.'] })),
  } satisfies ViewDef<Plain>,
  weekend: {
    title: 'Weekend visits', parse: plain,
    run: (range) => weekendVisits(range).then((t) => ({ ...t, notes: ['Visits are checked-in patients; no-shows are patients who did not arrive. Saturday and Sunday are the weekend, by the clinic calendar.'] })),
  } satisfies ViewDef<Plain>,
  demand: {
    title: 'Service demand by category', parse: plain,
    run: (range) => serviceDemand(range).then(({ mapping, ...t }) => ({
      ...t,
      notes: ['Booked = confirmed appointments in the range; attended = checked in; no-shows = did not arrive. ' + mapping.map((m) => `${m.category}: ${m.services.join(', ')}`).join('. ') + '. Any service not listed is Other.'],
    })),
  } satisfies ViewDef<Plain>,
};

function fail(res: Response, status: number, code: string, error: string) {
  return res.status(status).json({ error, code });
}

async function serve(resourceType: 'accounting_report' | 'clinic_report', views: Record<string, ViewDef<any>>, req: Request, res: Response) {
  const key = String(req.params.view);
  const def = Object.prototype.hasOwnProperty.call(views, key) ? views[key]! : undefined;
  if (!def) return fail(res, 404, 'unknown_view', 'There is no such report.');

  const parsed = def.parse.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'bad_request', `Unrecognised or invalid report parameter: ${parsed.error.issues[0]?.path.join('.') || 'query'}.`);
  const q = parsed.data as Plain;
  try {
    const range = resolveRange(q, now());
    const out: ViewResult = await def.run(range, q);
    const csv = q.format === 'csv';
    const rows = [...out.rows, ...(out.subtotals ?? [])];
    // The filters go in the audit row exactly as asked (ids, dates, a grouping): never a name or a value.
    audit.record({
      action: csv ? 'EXPORT' : 'READ', resourceType, resourceId: key,
      meta: { view: key, ...range, ...(def.filters ? def.filters(q) : {}), format: csv ? 'csv' : 'json', rows: out.rows.length },
    });
    if (csv) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="nextwave-${key}-${range.from}_to_${range.to}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      // A byte-order mark so a spreadsheet reads the dashes in the labels as UTF-8.
      // Accounting is two tables — service revenue, and dues apart from it — in one file; a Report is one.
      const text = out.dues
        ? toCsvSections([
          { title: 'Service revenue', columns: out.columns, rows, totals: out.totals ?? undefined },
          { title: DUES_TITLE, columns: out.dues.columns, rows: out.dues.rows, totals: out.dues.totals, footer: out.dues.note },
        ])
        : toCsv(out.columns, rows, out.totals ?? undefined);
      return res.send('\uFEFF' + text);
    }
    res.json({ view: key, title: def.title, range, filters: def.filters ? def.filters(q) : {}, columns: out.columns, rows: out.rows, subtotals: out.subtotals ?? [], totals: out.totals, dues: out.dues ?? null, summary: out.summary ?? null, notes: out.notes ?? [] });
  } catch (e) {
    if (e instanceof ReportError) return fail(res, 400, e.code, e.message);
    throw e;
  }
}

reportsRouter.get('/accounting/options', requireRole('ADMIN'), async (_req, res) => {
  res.json({ ...(await revenueFilterOptions()), groups: REVENUE_GROUPS, views: Object.entries(ACCOUNTING).map(([key, v]) => ({ key, title: v.title })) });
});
reportsRouter.get('/accounting/:view', requireRole('ADMIN'), (req, res) => serve('accounting_report', ACCOUNTING, req, res));

reportsRouter.get('/reports/:view', requireRole('FRONT_DESK', 'ADMIN'), (req, res) => serve('clinic_report', REPORTS, req, res));
