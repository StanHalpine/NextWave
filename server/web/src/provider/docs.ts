/** Pure helpers for the documentation workspace (kept apart from the components so they can be tested). */

import type { DocStatus, DocType, MacroLite, NoteSection, ProviderRole, Section } from '../types';

export const SECTIONS: Array<{ key: Section; kind: NoteSection; label: string; letter: string; hint: string }> = [
  { key: 'subjective', kind: 'SUBJECTIVE', label: 'Subjective', letter: 'S', hint: 'What the patient reports.' },
  { key: 'objective', kind: 'OBJECTIVE', label: 'Objective', letter: 'O', hint: 'What you observed and measured.' },
  { key: 'assessment', kind: 'ASSESSMENT', label: 'Assessment', letter: 'A', hint: 'Your clinical impression.' },
  { key: 'plan', kind: 'PLAN', label: 'Plan', letter: 'P', hint: 'What happens next.' },
];

export const ROLE_NAME: Record<ProviderRole, string> = { PROVIDER_CHIRO: 'Chiropractor', PROVIDER_NP: 'Nurse practitioner', PROVIDER_NURSE: 'Nurse' };
/** The bookable staff roles notes' authors carry (a note's author is a Staff record). */
const STAFF_ROLE_NAME: Record<string, string> = { CHIROPRACTOR: 'Chiropractor', NURSE_PRACTITIONER: 'Nurse practitioner', REGISTERED_NURSE: 'Nurse', FRONT_DESK: 'Front desk' };
/** "Nurse practitioner" for either kind of role name; the raw value only if it is one we have never heard of. */
export const roleName = (r: string): string => (ROLE_NAME as Record<string, string>)[r] ?? STAFF_ROLE_NAME[r] ?? r;

const NOTE_ORDER = ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL'];
/** SOAP notes in S, O, A, P order whatever order they arrive in (stable for notes of the same kind). */
export const inNoteOrder = <T extends { kind: string }>(notes: T[]): T[] =>
  [...notes].sort((a, b) => NOTE_ORDER.indexOf(a.kind) - NOTE_ORDER.indexOf(b.kind));

export const STATUS_LABEL: Record<DocStatus, string> = { NONE: 'No note yet', DRAFT: 'Note in progress', SIGNED: 'Note signed' };
export const STATUS_PILL: Record<DocStatus, 'off' | 'warn' | 'ok'> = { NONE: 'off', DRAFT: 'warn', SIGNED: 'ok' };

export type SoapFields = Record<Section, string>;
export const emptySoap = (): SoapFields => ({ subjective: '', objective: '', assessment: '', plan: '' });

/** Whitespace-only counts as empty, exactly as the server decides it. */
export const isBlank = (s: string): boolean => s.replace(/\s+/g, ' ').trim() === '';

/** The sections still to be written before a SOAP note can be signed. */
export function missingSections(f: SoapFields): Section[] {
  return SECTIONS.map((s) => s.key).filter((k) => isBlank(f[k]));
}

/** What is still needed before the draft can be signed; empty means it can be. */
export function signBlockers(type: DocType, soap: SoapFields, log: { notes: string; durationMin: number | null }): string[] {
  if (type === 'SOAP') {
    const m = missingSections(soap);
    return m.length ? [`Write ${m.map((k) => SECTIONS.find((s) => s.key === k)!.label).join(', ')} (N/A where it does not apply)`] : [];
  }
  const out: string[] = [];
  if (log.durationMin == null) out.push('Enter how long the session lasted');
  if (isBlank(log.notes)) out.push('Write the notes');
  return out;
}

/** "25" → 25; blank → null; anything that is not a whole number of minutes 1–1440 → undefined (invalid). */
export function parseMinutes(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d{1,4}$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= 1440 ? n : undefined;
}

/**
 * Insert a macro into a note at the cursor (or over a selection). When the box already has text and
 * the insertion would run onto it, a blank line is put between, so two macros never fuse into one
 * sentence. Returns the new text and where the cursor should land.
 */
export function insertMacro(text: string, start: number, end: number, insert: string): { text: string; cursor: number } {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  // Spaces at the seams would be left dangling on either side of the blank line, so they go.
  const before = text.slice(0, s).replace(/[ \t]+$/, '');
  const after = text.slice(e).replace(/^[ \t]+/, '');
  const lead = before === '' || /\n\s*\n$/.test(before) ? '' : /\n$/.test(before) ? '\n' : '\n\n';
  const tail = after === '' || /^\s*\n/.test(after) ? '' : '\n\n';
  const next = `${before}${lead}${insert}${tail}${after}`;
  return { text: next, cursor: before.length + lead.length + insert.length };
}

/** Macros for one section: the provider's own after the shared ones, each group in its saved order. */
export function macrosFor(section: NoteSection, shared: Array<{ macros: MacroLite[] }>, personal: MacroLite[]): { shared: MacroLite[]; personal: MacroLite[] } {
  return {
    shared: shared.flatMap((s) => s.macros).filter((m) => m.section === section),
    personal: personal.filter((m) => m.section === section),
  };
}

/** Plain-language reason a recording failed, from the server's category. */
export function scribeFailure(code: string | null): string {
  switch (code) {
    case 'transcribe_failed': return 'The recording could not be transcribed.';
    case 'draft_failed': return 'The transcript was made, but the note could not be drafted from it.';
    case 'timed_out': return 'This took too long and was stopped.';
    default: return 'Something went wrong with this recording.';
  }
}

export function scribeUnavailable(reason: string | null): string {
  return reason === 'stub_in_production'
    ? 'The AI scribe is switched off until secure storage and transcription are connected. You can still write the note yourself.'
    : 'The AI scribe is not enabled. You can still write the note yourself.';
}

/** "1:05" for 65 seconds. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The recording format this browser can produce, best first; '' lets the browser choose. */
export function pickAudioType(isSupported: (t: string) => boolean): string {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => isSupported(t)) ?? '';
}
