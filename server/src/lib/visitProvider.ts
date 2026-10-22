/**
 * Whose visit is it? (rev 2.1)
 *
 *   scheduled provider  Booking.staffId. Owned by the scheduling engine: availability, the calendar column, Move. Never changed here.
 *   rendering provider  Encounter.coveringStaffId when set — a covering doctor set by the front desk after check-in, or a note's signer
 *                       confirmed by an admin — else the scheduled provider. This is "the visit's provider".
 *
 * Only the visit's provider may WRITE its documentation: start the visit, save the draft, use the AI draft, record scribe consent or
 * audio, and sign. `writeRefusal` is that rule, in one place; every write path (lib/documentation.ts, lib/scribe.ts, the scribe
 * follow-up routes) goes through it, and the screens' read-only flags are computed from it too. An administrator who also holds a
 * provider role is held to it like anyone else. A visit with no provider at all (a room-only service) keeps the role rule — any
 * provider role may document it — rather than being impossible to document.
 *
 * Amend stays signer-only and an addendum stays open to any provider (routes/notes.ts): neither is decided here.
 */

import type { StaffRole } from '@prisma/client';
import { roleMayDocument, type ProviderRole } from './providerRoles.js';

type Person = { id: string; name: string; role: StaffRole };

export interface VisitPeople {
  staffId: string | null;
  staff: Person | null;
  encounter?: { coveringStaffId: string | null; coveringStaff?: Person | null } | null;
}

/** The visit's provider (rendering), by id: the covering provider if there is one, else the scheduled one; null when nobody is assigned. */
export const visitProviderId = (b: { staffId: string | null; encounter?: { coveringStaffId: string | null } | null }): string | null =>
  b.encounter?.coveringStaffId ?? b.staffId;

/** The visit's provider as a person, when the row carries them. */
export const visitProvider = (b: VisitPeople): Person | null =>
  b.encounter?.coveringStaffId ? (b.encounter.coveringStaff ?? null) : b.staff;

export interface WriteRefusal { code: 'wrong_role' | 'not_visit_provider'; message: string }

/** Why `me` may not write this visit's documentation, or null when they may. */
export function writeRefusal(v: VisitPeople, me: { role: ProviderRole; staffId: string | null }): WriteRefusal | null {
  const providerId = visitProviderId(v);
  if (!providerId) return null;                                     // nobody assigned: any provider role (the role rule)
  const provider = visitProvider(v);
  if (!roleMayDocument(provider?.role, me.role)) {
    return { code: 'wrong_role', message: 'This visit was booked with a different provider role, so you cannot document it.' };
  }
  if (me.staffId !== providerId) {
    return {
      code: 'not_visit_provider',
      message: `This is ${provider?.name ?? 'another provider'}’s visit. Only the visit's provider can write or sign its note; once it is signed, you can add an addendum.`,
    };
  }
  return null;
}
