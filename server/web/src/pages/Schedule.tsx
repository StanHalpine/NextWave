import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { todayIn, useClinicTz } from '../clinic';
import { useInterval, errorText, Notice } from '../ui';
import { addDays, fmtDay, fmtDow, fmtRange, fmtTime12, layoutLanes, nowHHMM, toMinutes, weekStart } from '../lib';
import type { Appt, Calendar, CalendarStaff } from '../types';
import { AppointmentDialog, NewAppointmentDialog } from '../schedule/dialogs';

const PX_PER_MIN = 1.3;          // 15 minutes = 19.5px
const GUTTER = 58;               // px, the hour labels
const SNAP = 15;                 // minutes

type View = 'day' | 'week';

interface Col {
  key: string;
  title: string;
  sub?: string;
  date: string;
  staffId: string | null;             // provider this column is for (day view), or the filter (week view)
  events: Appt[];
  shifts: Array<{ start: string; end: string }> | null;   // null = no shading
  closed: boolean;
  isToday: boolean;
}

export default function Schedule() {
  const tz = useClinicTz();
  const [view, setView] = useState<View>('day');
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? todayIn(tz);
  const [providerId, setProviderId] = useState('');
  const [cal, setCal] = useState<Calendar | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | { date: string; time?: string; staffId?: string }>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const from = view === 'day' ? date : weekStart(date);
  const to = view === 'day' ? date : addDays(from, 6);

  const load = useCallback(async () => {
    try {
      const c = await api<Calendar>(`/api/schedule/calendar?from=${from}&to=${to}${showCancelled ? '&includeCancelled=true' : ''}`);
      setCal(c); setError(null);
    } catch (e) { setError(errorText(e)); }
  }, [from, to, showCancelled]);

  useEffect(() => { void load(); }, [load]);
  useInterval(() => { void load(); }, 60_000);

  const today = cal?.today ?? todayIn(tz);
  const step = view === 'day' ? 1 : 7;

  async function decide(a: Appt, status: 'CONFIRMED' | 'DECLINED') {
    setBusyId(a.id);
    try { await api(`/api/bookings/${a.id}`, { method: 'PATCH', body: { status } }); await load(); }
    catch (e) { setError(errorText(e)); }
    finally { setBusyId(null); }
  }

  // ---- what to draw -------------------------------------------------------------
  const { cols, openMin, closeMin } = useMemo(() => build(cal, view, providerId), [cal, view, providerId]);

  // Start the scrolled grid where the day's action is: a little above "now" today, otherwise
  // a little above the first appointment (or opening time). Once per date/view, not on every refresh.
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef('');
  useEffect(() => {
    const key = `${view}|${from}`;
    if (!cal || !scroller.current || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const firstStart = Math.min(...cal.appointments.map((a) => toMinutes(a.localStart)), Infinity);
    const target = from <= cal.today && cal.today <= to ? toMinutes(nowHHMM(tz)) - 60 : Number.isFinite(firstStart) ? firstStart - 30 : openMin;
    scroller.current.scrollTop = Math.max(0, (Math.max(target, openMin) - openMin) * PX_PER_MIN);
  }, [cal, view, from, to, tz, openMin]);
  const pending = (cal?.appointments ?? []).filter((a) => a.status === 'PENDING_REVIEW');
  const provider = cal?.staff.find((s) => s.id === providerId);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedule</h1>
          <p className="lede">{view === 'day' ? `${fmtDay(date)}, ${date.slice(0, 4)}` : fmtRange(from, addDays(from, 5))}{date === today && view === 'day' ? ' · today' : ''}</p>
        </div>
        <div className="head-actions">
          <div className="seg" role="group" aria-label="View">
            <button className={view === 'day' ? 'on' : ''} onClick={() => setView('day')}>Day</button>
            <button className={view === 'week' ? 'on' : ''} onClick={() => setView('week')}>Week</button>
          </div>
          <div className="date-nav" role="group" aria-label="Date">
            <button className="btn small" onClick={() => setPicked(addDays(date, -step))} aria-label={view === 'day' ? 'Previous day' : 'Previous week'}>‹</button>
            <button className="btn small" onClick={() => setPicked(null)} disabled={view === 'day' ? date === today : weekStart(date) === weekStart(today)}>Today</button>
            <button className="btn small" onClick={() => setPicked(addDays(date, step))} aria-label={view === 'day' ? 'Next day' : 'Next week'}>›</button>
          </div>
          <input type="date" className="date-input" aria-label="Go to date" value={date} onChange={(e) => e.target.value && setPicked(e.target.value)} />
          <button className="btn primary" onClick={() => setCreating({ date })}>+ New appointment</button>
        </div>
      </div>

      <div className="filters">
        <label>Provider
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">All providers</option>
            {cal?.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled</label>
        <Legend />
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      {pending.length > 0 && (
        <details className="pending-panel" open>
          <summary><strong>{pending.length}</strong> online {pending.length === 1 ? 'request' : 'requests'} awaiting approval</summary>
          <ul className="plain">
            {pending.map((a) => (
              <li key={a.id}>
                <button className="linklike" onClick={() => setOpen(a.id)}>{fmtDay(a.localDate)} · {fmtTime12(a.localStart)} · {a.patient.name}</button>
                <span className="muted small"> {a.service.name}{a.staff ? ` · ${a.staff.name}` : ''}</span>
                <span className="row-actions">
                  <button className="btn small primary" disabled={busyId === a.id} onClick={() => void decide(a, 'CONFIRMED')}>Approve</button>
                  <button className="btn small" disabled={busyId === a.id} onClick={() => void decide(a, 'DECLINED')}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {!cal && !error && <p className="muted">Loading…</p>}
      {cal && cols.length === 0 && <p className="empty">Nothing to show — the clinic is closed {view === 'day' ? 'that day' : 'all week'}.</p>}
      {cal && cols.length > 0 && (
        <div className="cal-scroll" ref={scroller}>
          <div className="cal" style={{ gridTemplateColumns: `${GUTTER}px repeat(${cols.length}, minmax(${view === 'week' ? 150 : 170}px, 1fr))` }}>
            <div className="cal-corner" />
            {cols.map((c) => (
              <div key={c.key} className={`cal-head${c.isToday ? ' today' : ''}`}>
                <strong>{c.title}</strong>{c.sub && <span className="muted small"> {c.sub}</span>}
              </div>
            ))}
            <div className="cal-gutter" style={{ height: (closeMin - openMin) * PX_PER_MIN }}>
              {hourMarks(openMin, closeMin).map((m) => (
                <span key={m} className="hour-label" style={{ top: (m - openMin) * PX_PER_MIN }}>{fmtTime12(`${String(Math.floor(m / 60)).padStart(2, '0')}:00`)}</span>
              ))}
            </div>
            {cols.map((c) => (
              <GridColumn
                key={c.key} col={c} openMin={openMin} closeMin={closeMin} tz={tz}
                onOpen={setOpen}
                onEmpty={(time) => setCreating({ date: c.date, time, ...(c.staffId ? { staffId: c.staffId } : {}) })}
              />
            ))}
          </div>
        </div>
      )}
      {view === 'week' && provider && <p className="hint">Showing {provider.name}’s appointments. Shaded areas are outside their shifts.</p>}
      <p className="muted small foot">Click an empty time to book it, or an appointment to move, cancel or check it in. <a href="/dashboard.html">Room and employee grid (previous view) →</a></p>

      {open && <AppointmentDialog id={open} today={today} onClose={() => setOpen(null)} onChanged={() => void load()} />}
      {creating && (
        <NewAppointmentDialog
          initial={creating}
          onClose={() => setCreating(null)}
          onCreated={(a) => { setCreating(null); setPicked(a.localDate); void load(); }}
        />
      )}
    </>
  );
}

// ---- building columns ---------------------------------------------------------------------

function build(cal: Calendar | null, view: View, providerId: string): { cols: Col[]; openMin: number; closeMin: number } {
  if (!cal) return { cols: [], openMin: 420, closeMin: 1140 };
  const openDays = cal.days.filter((d) => !d.closed);
  const bounds = openDays.length
    ? { open: Math.min(...openDays.map((d) => toMinutes(d.open!))), close: Math.max(...openDays.map((d) => toMinutes(d.close!))) }
    : { open: 420, close: 1140 };
  // Whole hours, and wide enough to show an appointment that runs past closing.
  const lastEnd = Math.max(bounds.close, ...cal.appointments.map((a) => toMinutes(a.localEnd)));
  const openMin = Math.floor(bounds.open / 60) * 60;
  const closeMin = Math.ceil(lastEnd / 60) * 60;

  const byDay = (date: string) => cal.appointments.filter((a) => a.localDate === date);
  const cols: Col[] = [];

  if (view === 'day') {
    const day = cal.days[0]!;
    const events = byDay(day.date);
    const staff = cal.staff.filter((s) => (providerId ? s.id === providerId : (s.shifts[day.date]?.length ?? 0) > 0 || events.some((e) => e.staff?.id === s.id)));
    for (const s of staff) {
      cols.push({
        key: s.id, title: s.name, sub: roleShort(s), date: day.date, staffId: s.id,
        events: events.filter((e) => e.staff?.id === s.id), shifts: s.shifts[day.date] ?? [], closed: day.closed, isToday: day.date === cal.today,
      });
    }
    const orphans = events.filter((e) => !e.staff || !cal.staff.some((s) => s.id === e.staff!.id));
    if (!providerId && orphans.length) cols.push({ key: 'none', title: 'No provider', date: day.date, staffId: null, events: orphans, shifts: null, closed: day.closed, isToday: day.date === cal.today });
    if (day.closed && events.length === 0) return { cols: [], openMin, closeMin };
  } else {
    const prov = cal.staff.find((s) => s.id === providerId);
    for (const day of cal.days) {
      const events = byDay(day.date).filter((e) => !providerId || e.staff?.id === providerId);
      if (day.closed && events.length === 0) continue;
      cols.push({
        key: day.date, title: fmtDow(day.date), sub: day.date.slice(5).replace('-', '/'), date: day.date, staffId: providerId || null,
        events, shifts: prov ? (prov.shifts[day.date] ?? []) : null, closed: day.closed, isToday: day.date === cal.today,
      });
    }
  }
  return { cols, openMin, closeMin };
}

const roleShort = (s: CalendarStaff) => ({ CHIROPRACTOR: 'DC', NURSE_PRACTITIONER: 'NP', REGISTERED_NURSE: 'RN' } as Record<string, string>)[s.role] ?? '';
const hourMarks = (openMin: number, closeMin: number) => Array.from({ length: Math.floor((closeMin - openMin) / 60) + 1 }, (_, i) => openMin + i * 60);

// ---- one column of the grid -----------------------------------------------------------------

function GridColumn({ col, openMin, closeMin, tz, onOpen, onEmpty }: {
  col: Col; openMin: number; closeMin: number; tz: string; onOpen: (id: string) => void; onEmpty: (time: string) => void;
}) {
  const height = (closeMin - openMin) * PX_PER_MIN;
  const lanes = useMemo(() => layoutLanes(col.events.map((e) => ({ startMin: toMinutes(e.localStart), endMin: toMinutes(e.localEnd) }))), [col.events]);
  const nowMin = col.isToday ? toMinutes(nowHHMM(tz)) : null;

  function click(e: MouseEvent<HTMLDivElement>) {
    if (col.closed) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const min = Math.floor((openMin + y / PX_PER_MIN) / SNAP) * SNAP;
    onEmpty(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
  }

  return (
    <div className={`cal-col${col.closed ? ' closed' : ''}${col.isToday ? ' today' : ''}`} style={{ height }} onClick={click} role="presentation">
      {col.shifts && !col.closed && (
        <div className="shifts" aria-hidden="true">
          {col.shifts.map((s, i) => (
            <div key={i} className="shift" style={{ top: (toMinutes(s.start) - openMin) * PX_PER_MIN, height: (toMinutes(s.end) - toMinutes(s.start)) * PX_PER_MIN }} />
          ))}
        </div>
      )}
      {col.events.map((a, i) => {
        const start = toMinutes(a.localStart);
        const end = toMinutes(a.localEnd);
        const { lane, lanes: n } = lanes[i]!;
        // Only a CHECKED-OUT visit is finished (dimmed). A SEEN one — signed by the provider — still has to be checked out, so it keeps
        // the "here" mark until the desk does.
        const done = a.encounter?.status === 'CHECKED_OUT';
        const seen = a.encounter?.status === 'SEEN';
        const here = a.encounter?.status === 'CHECKED_IN' || a.encounter?.status === 'IN_PROGRESS' || seen;
        const h = Math.max((end - start) * PX_PER_MIN - 2, 20);
        return (
          <div key={a.id}>
            <button
              className={`ev st-${a.status}${h < 34 ? ' tiny' : ''}${here ? ' here' : ''}${done ? ' done' : ''}${a.encounter?.status === 'NO_SHOW' ? ' noshow' : ''}`}
              style={{
                top: (start - openMin) * PX_PER_MIN, height: h,
                left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, background: a.service.color,
              }}
              onClick={(e) => { e.stopPropagation(); onOpen(a.id); }}
              title={`${fmtTime12(a.localStart)} – ${fmtTime12(a.localEnd)} · ${a.patient.name} · ${a.service.name}${seen ? ' · seen, needs check-out' : ''}`}
            >
              <span className="ev-top">
                <span className="ev-time">{fmtTime12(a.localStart).replace(' ', '')}{here && ' ✓'}</span>
                <span className="ev-name">{a.patient.name || 'Held for a booking'}</span>
              </span>
              <span className="ev-svc">{a.service.name}</span>
            </button>
            {a.bufferMin > 0 && a.status !== 'CANCELLED' && (
              <div className="ev-buffer" aria-hidden="true" style={{ top: (end - openMin) * PX_PER_MIN - 2, height: a.bufferMin * PX_PER_MIN, left: `calc(${(lane / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, background: a.service.color }} />
            )}
          </div>
        );
      })}
      {nowMin !== null && nowMin >= openMin && nowMin <= closeMin && <div className="now-line" style={{ top: (nowMin - openMin) * PX_PER_MIN }} aria-hidden="true" />}
    </div>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span className="muted small">Color = service · border = status:</span>
      <span><i className="lg lg-confirmed" />Confirmed</span>
      <span><i className="lg lg-pending" />Needs approval</span>
      <span><i className="lg lg-hold" />Held</span>
      <span><i className="lg lg-cancelled" />Cancelled</span>
    </div>
  );
}

