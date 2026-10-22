import type { DocStatus, DocType, EncounterStatus } from './types';

/**
 * A visit's note status (rev 2.0), as the server sends it (lib/noteStatus.ts) and the words the screens use for it. It is apart from where
 * the visit is: check-out never waits for the note, so a checked-out visit can still have its note pending, and the provider signs it
 * later from their Unsigned notes list. null = there is nothing to document yet (not checked in, or a no-show).
 */
export type NoteStatus = 'NOT_REQUIRED' | 'PENDING' | 'SIGNED';

export const NOTE_LABEL: Record<NoteStatus, string> = { NOT_REQUIRED: 'No note needed', PENDING: 'Note pending', SIGNED: 'Note signed' };
export const NOTE_PILL: Record<NoteStatus, 'off' | 'warn' | 'ok'> = { NOT_REQUIRED: 'off', PENDING: 'warn', SIGNED: 'ok' };
/** The calendar block's badge is short. */
export const NOTE_SHORT: Record<NoteStatus, string> = { NOT_REQUIRED: 'No note', PENDING: 'Note pending', SIGNED: 'Signed' };
export const NOTE_TITLE: Record<NoteStatus, string> = {
  NOT_REQUIRED: 'This service needs no note.',
  PENDING: 'The provider has not signed the note yet. Check-out does not wait for it; the provider can sign after the patient has left.',
  SIGNED: 'The provider has signed the note. The note itself is not shown here.',
};

/** "Note pending — draft started" when the provider has begun it; otherwise just the status. */
export function noteText(note: NoteStatus, doc?: DocStatus): string {
  return note === 'PENDING' && doc === 'DRAFT' ? `${NOTE_LABEL.PENDING} — draft started` : NOTE_LABEL[note];
}

// ---- the provider's Unsigned notes worklist (GET /api/provider/unsigned-notes) -----------------------------------------------------

export interface UnsignedRow {
  bookingId: string;
  localDate: string;
  localStart: string;
  patient: { id: string | null; name: string };
  service: { id: string; name: string; color: string; documentationType: DocType };
  subOption: string | null;
  visit: { status: EncounterStatus; checkedOutAt: string | null };
  documentation: { status: DocStatus; draftUpdatedAt: string | null };
  pendingSince: string;
  hoursPending: number;
  overdue: boolean;
}

export interface UnsignedProvider { id: string; name: string; role: string; active: boolean }

export interface UnsignedNotes {
  now: string;
  timezone: string;
  thresholdHours: number;
  /** Whose list this is; null when the account has no provider record (an administrator then chooses one). */
  provider: (UnsignedProvider & { own: boolean }) | null;
  /** Administrators only: the providers they may choose from. */
  providers: UnsignedProvider[] | null;
  rows: UnsignedRow[];
  overdue: number;
  more: boolean;
  reason: string | null;
}

/** How long a note has been waiting: "40 min" is not shown (under an hour reads "under 1 h"), then hours, then days and hours. */
export function waitedFor(hours: number): string {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${hours} h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

const VISIT_LABEL: Partial<Record<EncounterStatus, string>> = { CHECKED_IN: 'Checked in', IN_PROGRESS: 'With provider', SEEN: 'Seen', CHECKED_OUT: 'Checked out' };
export const visitLabel = (s: EncounterStatus): string => VISIT_LABEL[s] ?? s;

/** The one-line summary at the top of the list. */
export function worklistSummary(count: number, overdue: number, thresholdHours: number): string {
  if (count === 0) return 'No unsigned notes';
  const n = `${count} unsigned ${count === 1 ? 'note' : 'notes'}`;
  return overdue > 0 ? `${n} · ${overdue} pending more than ${thresholdHours} hours` : n;
}

/** The Provider page's link to the list: "Your unsigned notes: 12 (3 overdue)"; an account with no provider record of its own picks one. */
export function unsignedLinkLabel(c: { count: number; overdue: number } | null): string {
  if (!c) return 'Unsigned notes by provider';
  if (c.count === 0) return 'Your unsigned notes: none';
  return `Your unsigned notes: ${c.count}${c.overdue > 0 ? ` (${c.overdue} overdue)` : ''}`;
}
