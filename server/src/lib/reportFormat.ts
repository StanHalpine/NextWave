/**
 * Pure helpers for the Accounting and Reports screens: the date range, CSV, and the service-category mapping.
 * Nothing here touches the database, so it is tested on its own.
 */

import { DateTime } from 'luxon';
import { config } from '../config.js';

export class ReportError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ReportError'; }
}

export interface DateRange { from: string; to: string }
/** A range is clinic-LOCAL calendar days, both ends inclusive. Five years is the longest one report will scan. */
export const MAX_RANGE_DAYS = 1830;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (iso: string, name: string): DateTime => {
  const d = DateTime.fromISO(iso, { zone: config.clinicTimezone });
  if (!ISO_DAY.test(iso) || !d.isValid) throw new ReportError('bad_date', `${name} must be a real date written YYYY-MM-DD.`);
  return d;
};

/** The first and last day of the month `at` falls in, in the clinic's calendar. */
export function currentMonth(at: Date): DateRange {
  const d = DateTime.fromJSDate(at, { zone: config.clinicTimezone });
  return { from: d.startOf('month').toFormat('yyyy-MM-dd'), to: d.endOf('month').toFormat('yyyy-MM-dd') };
}

/** The range asked for, or this month's when neither end is given. One end alone is refused rather than guessed at. */
export function resolveRange(q: { from?: string | undefined; to?: string | undefined }, at: Date): DateRange {
  if (q.from === undefined && q.to === undefined) return currentMonth(at);
  if (q.from === undefined || q.to === undefined) throw new ReportError('bad_range', 'Give both a start and an end date, or neither for this month.');
  const from = day(q.from, 'The start date');
  const to = day(q.to, 'The end date');
  if (from > to) throw new ReportError('bad_range', 'The start date is after the end date.');
  if (to.diff(from, 'days').days + 1 > MAX_RANGE_DAYS) throw new ReportError('range_too_long', 'That range is longer than five years. Choose a shorter one.');
  return { from: q.from, to: q.to };
}

/** Every "YYYY-MM-DD" from `from` to `to`, inclusive. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = DateTime.fromISO(range.from, { zone: 'utc' }); d <= DateTime.fromISO(range.to, { zone: 'utc' }); d = d.plus({ days: 1 })) out.push(d.toFormat('yyyy-MM-dd'));
  return out;
}

/** Every "YYYY-MM" the range touches. */
export function eachMonth(range: DateRange): string[] {
  const out: string[] = [];
  const end = DateTime.fromISO(range.to, { zone: 'utc' }).startOf('month');
  for (let d = DateTime.fromISO(range.from, { zone: 'utc' }).startOf('month'); d <= end; d = d.plus({ months: 1 })) out.push(d.toFormat('yyyy-MM'));
  return out;
}

// ---- CSV ---------------------------------------------------------------------------------------------

export interface Column { key: string; label: string; kind: 'text' | 'int' | 'money' | 'percent' }

/** 12345 → "123.45". Whole cents in, a plain decimal out (no currency symbol, no thousands comma: a spreadsheet's job). */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * One CSV cell. Quotes anything with a comma, quote or line break; and a cell that STARTS with = + - @ (or a
 * tab / carriage return) is prefixed with an apostrophe, so a spreadsheet shows it as text instead of running it
 * as a formula. (A negative number is formatted by us, so it is exempt.)
 */
export function csvCell(value: string | number, kind: Column['kind'] = 'text'): string {
  let s = typeof value === 'number' ? (kind === 'money' ? dollars(value) : String(value)) : value;
  if (kind === 'text' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: Column[], rows: Array<Record<string, string | number>>, totals?: Record<string, string | number>): string {
  const line = (r: Record<string, string | number>) => columns.map((c) => csvCell(r[c.key] ?? '', c.kind)).join(',');
  return [columns.map((c) => csvCell(c.label)).join(','), ...rows.map(line), ...(totals ? [line(totals)] : [])].join('\r\n') + '\r\n';
}

export interface CsvSection {
  /** A line above the section's header row (a file with two tables needs to say which is which). */
  title?: string;
  columns: Column[];
  rows: Array<Record<string, string | number>>;
  totals?: Record<string, string | number>;
  /** A line after the totals. */
  footer?: string | null;
}

/** Several tables in one file, each with its own header row and totals, separated by a blank line. */
export function toCsvSections(sections: CsvSection[]): string {
  return sections
    .map((s) => (s.title ? `${csvCell(s.title)}\r\n` : '') + toCsv(s.columns, s.rows, s.totals) + (s.footer ? `${csvCell(s.footer)}\r\n` : ''))
    .join('\r\n');
}

// ---- service demand categories -----------------------------------------------------------------------

/**
 * The demand categories, with the services in each — SPEC assumption A-6 by service slug, plus the seventh the owner added at Phase 5
 * approval. (The booking app's `Service.category` has only three disciplines — Chiropractic, Functional Medicine, Longevity — too
 * coarse for these, and the owner's rule groups across them: "Consult" is the five nurse-practitioner consult-room services.)
 * "Vitamin shots & injections" holds `vitamin-shots`, the one service the site calls an injection. Body composition is in none of
 * them, and neither is any service added later: both are "Other" until listed here. tests/reports.test.ts pins the seeded services
 * that land in Other, so adding a service fails there until someone decides.
 */
export const DEMAND_CATEGORIES = [
  { key: 'chiropractic', label: 'Chiropractic', slugs: ['spinal-postural-exam', 'manual-adjustment', 'spinal-xrays'] },
  { key: 'hbot', label: 'Hyperbaric oxygen (HBOT)', slugs: ['hyperbaric-oxygen-therapy'] },
  { key: 'red_light', label: 'Red light', slugs: ['red-light-therapy'] },
  { key: 'iv', label: 'IV therapy', slugs: ['iv-therapy'] },
  { key: 'injections', label: 'Vitamin shots & injections', slugs: ['vitamin-shots'] },
  { key: 'consult', label: 'Consults', slugs: ['functional-medicine-consult', 'hormone-optimization', 'peptide-therapy', 'personal-wellness-planning', 'supplementation'] },
  { key: 'bloodwork', label: 'Bloodwork', slugs: ['biomarker-testing'] },
] as const;
export const OTHER_DEMAND = { key: 'other', label: 'Other' } as const;

export function demandCategoryOf(slug: string): { key: string; label: string } {
  const hit = DEMAND_CATEGORIES.find((c) => (c.slugs as readonly string[]).includes(slug));
  return hit ? { key: hit.key, label: hit.label } : { ...OTHER_DEMAND };
}

export const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
