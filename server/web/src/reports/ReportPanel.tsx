import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { fmtMoney } from '../lib';
import type { ReportColumn, ReportData, ReportRow } from '../types';
import { errorText } from '../ui';

/** One cell as the screen shows it. Money arrives as whole cents; the CSV carries plain decimals instead. */
export function formatCell(kind: ReportColumn['kind'], v: string | number | undefined): string {
  if (v === undefined || v === '') return '';
  if (kind === 'money') return fmtMoney(Number(v));
  if (kind === 'int') return Number(v).toLocaleString('en-US');
  if (kind === 'percent') return `${v}%`;
  return String(v);
}
const numeric = (c: ReportColumn) => c.kind !== 'text';
/** Money and counts line up on the right; a month or a day never breaks across two lines. */
const cellClass = (c: ReportColumn) => (numeric(c) ? 'num' : c.key === 'month' || c.key === 'day' ? 'nowrap' : '');

/** The query string for a report: the chosen range (none = the server's current month) plus the view's own filters. */
export function reportQuery(applied: { from: string; to: string } | null, extra: Record<string, string> = {}, format?: 'csv'): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  if (applied) { p.set('from', applied.from); p.set('to', applied.to); }
  if (format) p.set('format', format);
  return p.toString();
}
export const rangeIsValid = (from: string, to: string) => /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

/**
 * A report for one date range: the range picker (this month until the person chooses otherwise), the table with its totals
 * row, and a CSV export of exactly what is on screen. The server decides what "this month" is, in the clinic's calendar,
 * and says which range it used; the date boxes show that, never the browser's own idea of today.
 */
export default function ReportPanel({ endpoint, view, extra, children }: {
  endpoint: '/api/accounting' | '/api/reports';
  view: string;
  extra?: Record<string, string>;
  /** Shown above the table: headline figures for this view. */
  children?: (data: ReportData) => ReactNode;
}) {
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);
  const extraKey = JSON.stringify(extra ?? {});

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    api<ReportData>(`${endpoint}/${view}?${reportQuery(applied, extra)}`)
      .then((d) => {
        if (mine !== latest.current) return;           // a newer request has gone out since
        setData(d); setError(null); setFrom(d.range.from); setTo(d.range.to);
      })
      .catch((e) => { if (mine === latest.current) { setError(errorText(e)); } })
      .finally(() => { if (mine === latest.current) setLoading(false); });
  }, [endpoint, view, applied, extraKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = rangeIsValid(from, to);

  async function exportCsv() {
    setExporting(true); setError(null);
    try {
      // Fetched, not linked, so a signed-out session or a refused range is said in words instead of downloading an error page.
      const res = await fetch(`${endpoint}/${view}?${reportQuery(data ? data.range : applied, extra, 'csv')}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The export failed (${res.status}).`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${view}.csv`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError(errorText(e)); } finally { setExporting(false); }
  }

  const cell = (c: ReportColumn, r: ReportRow) => <td key={c.key} className={cellClass(c)}>{formatCell(c.kind, r[c.key])}</td>;

  return (
    <section aria-busy={loading}>
      <form className="filters report-range" onSubmit={(e) => { e.preventDefault(); if (valid) setApplied({ from, to }); }}>
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
        <label>To<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required /></label>
        <button type="submit" className="btn" disabled={!valid || loading}>Show</button>
        <button type="button" className="btn ghost" disabled={loading || applied === null} onClick={() => setApplied(null)}>This month</button>
        <button type="button" className="btn ghost" disabled={!data || exporting} onClick={() => void exportCsv()}>{exporting ? 'Preparing…' : 'Export CSV'}</button>
      </form>
      {!valid && from && to && <p className="error" role="alert">The start date is after the end date.</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {data && (
        <div className={loading ? 'report-body stale' : 'report-body'}>
          <p className="hint">{data.title}, {data.range.from} to {data.range.to}. Clinic dates, both days included.</p>
          {children?.(data)}
          <div className="table-scroll">
            <table className="table dense report-table">
              <thead><tr>{data.columns.map((c) => <th key={c.key} className={cellClass(c)}>{c.label}</th>)}</tr></thead>
              <tbody>
                {data.rows.map((r, i) => <tr key={i}>{data.columns.map((c) => cell(c, r))}</tr>)}
                {data.rows.length === 0 && <tr><td colSpan={data.columns.length} className="muted">No activity in this range.</td></tr>}
                {data.subtotals.map((r, i) => <tr key={`s${i}`} className="report-sub">{data.columns.map((c) => cell(c, r))}</tr>)}
              </tbody>
              <tfoot><tr className="report-total">{data.columns.map((c) => cell(c, data.totals))}</tr></tfoot>
            </table>
          </div>
          {data.notes.length > 0 && (
            <details className="report-notes"><summary>How these numbers are made</summary>{data.notes.map((n, i) => <p key={i} className="small">{n}</p>)}</details>
          )}
        </div>
      )}
      {!data && loading && <p className="muted">Loading…</p>}
    </section>
  );
}

/** A row of headline figures. */
export function Stats({ items }: { items: Array<{ label: string; value: string }> }) {
  return <div className="stat-row">{items.map((s) => <div key={s.label} className="stat"><strong>{s.value}</strong><span>{s.label}</span></div>)}</div>;
}
