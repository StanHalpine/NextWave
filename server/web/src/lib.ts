/**
 * Small pure helpers for dates and times.
 *
 * Everything here works on clinic-LOCAL date strings ("2026-10-13") and "HH:MM" strings the
 * server already computed, never on the browser's own time zone — a front desk laptop set to
 * another zone must still show the 10:00 appointment at 10:00. The one place an instant has
 * to be shown in clinic time (fmtInstantTime) names the zone explicitly.
 */

/** "13:30" → "1:30 PM". */
export function fmtTime12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = ((h! + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`;
}

export const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

/** An ISO instant shown as clinic time ("10:30 AM"), whatever zone this browser is in. */
export function fmtInstantTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Current clinic-local "HH:MM". */
export function nowHHMM(timeZone: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

const noon = (date: string) => new Date(`${date}T12:00:00Z`); // noon UTC: no date can shift across a zone boundary

export function addDays(date: string, n: number): string {
  const d = noon(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  return ((noon(date).getUTCDay() + 6) % 7) + 1;
}

export const weekStart = (date: string): string => addDays(date, 1 - isoWeekday(date));

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const fmtDay = (date: string) => `${DOW[isoWeekday(date) - 1]} ${MONTH[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8))}`;
export const fmtDayLong = (date: string) => `${fmtDay(date)}, ${date.slice(0, 4)}`;
export const fmtDow = (date: string) => DOW[isoWeekday(date) - 1]!;

/** "Oct 13 – Oct 18". */
export function fmtRange(from: string, to: string): string {
  const f = (d: string) => `${MONTH[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}`;
  return `${f(from)} – ${f(to)}, ${to.slice(0, 4)}`;
}

export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** A US phone for display; anything else is shown as typed. */
export function fmtPhone(raw: string): string {
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : raw;
}

/** Whole years from a "YYYY-MM-DD" birth date to a "YYYY-MM-DD" today. */
export function ageOn(dob: string, today: string): number {
  let age = Number(today.slice(0, 4)) - Number(dob.slice(0, 4));
  if (today.slice(5) < dob.slice(5)) age--;
  return age;
}

/**
 * Lay overlapping events side by side. Events that overlap in time share a "cluster"; inside
 * a cluster each takes the first free lane, and every event is as wide as its cluster allows.
 * Returns the lane and lane count for each event, by index.
 */
export function layoutLanes(events: Array<{ startMin: number; endMin: number }>): Array<{ lane: number; lanes: number }> {
  const order = events.map((_, i) => i).sort((a, b) => events[a]!.startMin - events[b]!.startMin || events[a]!.endMin - events[b]!.endMin);
  const out: Array<{ lane: number; lanes: number }> = events.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const close = () => {
    for (const i of cluster) out[i]!.lanes = laneEnds.length;
    cluster = []; laneEnds = []; clusterEnd = -1;
  };

  for (const i of order) {
    const e = events[i]!;
    if (cluster.length && e.startMin >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= e.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(e.endMin); } else laneEnds[lane] = e.endMin;
    out[i]!.lane = lane;
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  close();
  return out;
}

/** "IV Therapy (60 min)" — but never "Hyperbaric Oxygen Therapy (60 min) (60 min)": some service names already say it. */
export const serviceLabel = (s: { name: string; durationMin: number }): string =>
  /\(\d+\s*min\)/i.test(s.name) ? s.name : `${s.name} (${s.durationMin} min)`;
