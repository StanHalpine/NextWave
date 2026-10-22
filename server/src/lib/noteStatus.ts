/**
 * A visit's NOTE STATUS (rev 2.0), tracked apart from where the visit is (Encounter.status):
 *
 *   NOT_REQUIRED  the service needed no note when the patient was checked in (red light, hyperbaric and the like)
 *   PENDING       it needs one and nobody has signed it — whether the patient is still here or was checked out days ago
 *   SIGNED        a provider has signed it (a NoteSignature exists), including on a service that did not need one
 *   null          there is no visit to document yet: not checked in, or a no-show
 *
 * Billing and documentation are decoupled: check-out never waits for a note, and signing never checks a patient out. A visit
 * can therefore be CHECKED_OUT with its note PENDING; the provider's Unsigned notes worklist (lib/unsignedNotes.ts) is where
 * those are found.
 *
 * Nothing here is stored as a status. The one new fact is Encounter.noteRequired — the service's requiresNote, fixed by a
 * database trigger when the patient is checked in — and "signed" is the append-only NoteSignature that already exists, so the
 * two can never disagree.
 */

import type { EncounterStatus } from '@prisma/client';

export type NoteStatus = 'NOT_REQUIRED' | 'PENDING' | 'SIGNED';

/** The encounter states in which the patient has been checked in (and may since have left). */
export const CHECKED_IN_STATES = ['CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT'] as const satisfies readonly EncounterStatus[];

const wasCheckedIn = (s: EncounterStatus) => (CHECKED_IN_STATES as readonly string[]).includes(s);

export function noteStatusOf(b: {
  encounter?: { status: EncounterStatus; noteRequired: boolean } | null;
  noteSignature?: unknown | null;
}): NoteStatus | null {
  if (b.noteSignature) return 'SIGNED';
  if (!b.encounter || !wasCheckedIn(b.encounter.status)) return null;
  return b.encounter.noteRequired ? 'PENDING' : 'NOT_REQUIRED';
}

/** When the note became due: the check-in (when the requirement was fixed), or the appointment's start if that is missing. */
export const pendingSince = (b: { startTime: Date; encounter?: { checkedInAt: Date | null } | null }): Date =>
  b.encounter?.checkedInAt ?? b.startTime;

/** Pending longer than `hours` elapsed hours (not calendar days, so a 25-hour day changes nothing). */
export const isOverdue = (since: Date, now: Date, hours: number): boolean => now.getTime() - since.getTime() > hours * 3_600_000;
