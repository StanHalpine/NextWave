import { toMinutes } from './lib';
import type { Appt } from './types';

/**
 * What the front desk can do with an appointment, by where the visit is. One table, used by the cards on the Front Desk page
 * AND by the appointment dialog opened from them, so the two can never offer different things. It mirrors the server's rules
 * (lib/encounters.ts, lib/checkout.ts), which stay the authority: a button shown here that the server refuses just says why.
 *
 *   not here yet     → Check in (today only, patient record linked) · No-show (once the start time has passed)
 *   no-show          → They arrived — check in
 *   checked in       → Check out · Undo check-in
 *   with the provider→ Check out
 *   SEEN             → Check out   (the provider signed; NOTHING is recorded and the visit is not finished until this is done)
 *   checked out      → nothing
 */
export type DeskVerb = 'check-in' | 'undo-check-in' | 'no-show';
export type DeskAction =
  | { kind: 'link'; label: string }
  | { kind: 'verb'; verb: DeskVerb; label: string; primary: boolean; disabled: boolean; why: string }
  | { kind: 'check-out'; label: string; primary: boolean };

export interface DeskContext {
  /** The day being looked at is today, in clinic time. Check-in and no-show are for today only. */
  isToday: boolean;
  /** Minutes since midnight, clinic time, now — only meaningful when `isToday`. */
  nowMin: number | null;
}

export function deskActions(a: Appt, ctx: DeskContext): DeskAction[] {
  if (a.status !== 'CONFIRMED') return [];
  const enc = a.encounter?.status;
  const checkIn = (label: string, primary: boolean): DeskAction => ({
    kind: 'verb', verb: 'check-in', label, primary,
    disabled: !a.patient.linked || !ctx.isToday,
    why: !a.patient.linked ? 'Link a patient record first' : !ctx.isToday ? 'Check-in is for today only' : '',
  });

  if (!enc || enc === 'SCHEDULED') {
    const out: DeskAction[] = [];
    if (!a.patient.linked) out.push({ kind: 'link', label: 'Link patient' });
    out.push(checkIn('Check in', true));
    if (ctx.isToday && ctx.nowMin !== null && toMinutes(a.localStart) <= ctx.nowMin) {
      out.push({ kind: 'verb', verb: 'no-show', label: 'No-show', primary: false, disabled: false, why: '' });
    }
    return out;
  }
  if (enc === 'NO_SHOW') return [checkIn('They arrived — check in', false)];
  if (enc === 'CHECKED_IN') {
    return [
      { kind: 'check-out', label: 'Check out…', primary: true },
      { kind: 'verb', verb: 'undo-check-in', label: 'Undo check-in', primary: false, disabled: false, why: '' },
    ];
  }
  if (enc === 'IN_PROGRESS' || enc === 'SEEN') return [{ kind: 'check-out', label: 'Check out…', primary: true }];
  return [];   // CHECKED_OUT
}

/** One line on what state a started visit is in, for the card and the dialog. */
export function visitStateLabel(a: Appt): string | null {
  switch (a.encounter?.status) {
    case 'CHECKED_IN': return 'Checked in';
    case 'IN_PROGRESS': return 'With the provider';
    case 'SEEN': return 'Seen — needs check-out';
    case 'CHECKED_OUT': return 'Checked out';
    case 'NO_SHOW': return 'No-show';
    default: return null;
  }
}

// ---- rev 2.4.x: the Front Desk's day and open dialog live in the URL --------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A real calendar date in YYYY-MM-DD (not 2026-02-30). */
const isDay = (s: string): boolean => {
  if (!ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;      // month 13 is no date at all; 30 Feb rolls into March
};

/**
 * The Front Desk on a clinic day, with an appointment's dialog open: /front-desk?date=YYYY-MM-DD&appt=<id>. `date` is the CLINIC's
 * calendar day (America/Chicago) — the appointment's own `localDate`, worked out by the server — so a visit at 23:30 opens on its day,
 * not on the next day in UTC. No date means today.
 */
export function frontDeskHref(o: { date?: string | null; appt?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (o.date) q.set('date', o.date);
  if (o.appt) q.set('appt', o.appt);
  const s = q.toString();
  return `/front-desk${s ? `?${s}` : ''}`;
}

/** Read the Front Desk's URL: a malformed or impossible date, or an id that is not one, is ignored rather than trusted. */
export function readDeskParams(params: URLSearchParams): { date: string | undefined; appt: string | null } {
  const date = params.get('date') ?? '';
  const appt = params.get('appt') ?? '';
  return { date: isDay(date) ? date : undefined, appt: ID.test(appt) ? appt : null };
}
