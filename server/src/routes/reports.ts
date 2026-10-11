/**
 * Accounting (admin only) and Reports (front desk and admin).
 *
 *   GET /api/accounting/options          the service / provider / payment-type choices for the custom view
 *   GET /api/accounting/:view            monthly | daily | members | custom        ?from=&to=[&format=csv]
 *   GET /api/reports/:view               signups | walkins-day | walkins-hour | weekend | demand   ?from=&to=[&format=csv]
 *
 * `from` and `to` are clinic-local calendar days (YYYY-MM-DD), both inclusive; give both or neither, and neither
 * means the current month. The custom view also takes serviceId, paymentType (CASH | MEMBER), providerId and
 * `group` (how to total it). Every other parameter is refused rather than ignored, so a typo cannot quietly
 * return an unfiltered number.
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
import { requireRole } from '../middleware/session.js';

export const reportsRouter = Router();

interface ViewResult extends Table {
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
type Custom = z.infer<typeof custom>;

const MONEY_NOTE = 'Service revenue is what the front desk recorded at check-out: net = list price − member discount, and 0 for a visit a membership covered (credits or a perk), shown under "Covered by membership". Membership dues are billed when each month\'s credits are granted and are shown below, separately: they are never added into service revenue. Collecting the payment happens outside this system, so a dues line means "billed", not "paid".';

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
          { title: 'Service revenue', columns: out.columns, rows, totals: out.totals },
          { title: DUES_TITLE, columns: out.dues.columns, rows: out.dues.rows, totals: out.dues.totals, footer: out.dues.note },
        ])
        : toCsv(out.columns, rows, out.totals);
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
