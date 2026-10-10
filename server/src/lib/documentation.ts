/**
 * Clinical documentation: the provider's working draft, and signing it.
 *
 * Two stores, deliberately:
 *
 *   DocumentationDraft  a mutable scratchpad (optimistic `version`). Nothing in it is a clinical
 *                       record, so editing it never touches the amend-only note chain.
 *   VisitNote           the record. Signing copies the draft into VisitNote rows — S, O, A and P for a
 *                       SOAP service, one GENERAL note (with its duration) for a session log — writes
 *                       the NoteSignature, deletes the draft and marks the visit SEEN, all in ONE
 *                       transaction. After that the only change is the existing amendment
 *                       (POST /api/visit-notes/:id/amend), which this module does not touch.
 *
 * Lock order: every writer takes the Booking row first (lockedBooking), so two tabs, a double click
 * and the scribe's draft arriving cannot interleave; that is what makes `version` a simple check.
 * Nothing here takes any other lock.
 *
 * Audit: every write goes through rec() inside the same transaction (it commits or rolls back with
 * the change it describes); reads are audited by the callers. No text, only ids and field NAMES.
 */

import type { AccountRole, DocumentationType, NoteKind, Prisma } from '@prisma/client';
import { lockedBooking } from './encounters.js';
import { roleMayDocument, type ProviderRole } from './providerRoles.js';
import { prisma } from './prisma.js';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;

export class DocError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DocError';
  }
}
const fail = (status: 400 | 403 | 404 | 409 | 503, code: string, message: string, extra: Record<string, unknown> = {}) => new DocError(status, code, message, extra);

export const SECTIONS = ['subjective', 'objective', 'assessment', 'plan'] as const;
export type Section = (typeof SECTIONS)[number];
export const KIND_FOR: Record<Section, NoteKind> = { subjective: 'SUBJECTIVE', objective: 'OBJECTIVE', assessment: 'ASSESSMENT', plan: 'PLAN' };
export const SECTION_LABEL: Record<Section, string> = { subjective: 'Subjective', objective: 'Objective', assessment: 'Assessment', plan: 'Plan' };

/** The visit states in which a provider may document: the patient has been checked in (and may since have left). */
const DOCUMENTABLE = ['CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT'] as const;

/** Text the development stubs produce. It must never end up in a signed record. */
export const DEMO_TEXT = /\[DEMO (?:DRAFT|TRANSCRIPT)\]/i;

export type DocStatus = 'NONE' | 'DRAFT' | 'SIGNED';
export const docStatus = (b: { noteSignature?: unknown | null; documentationDraft?: unknown | null }): DocStatus =>
  b.noteSignature ? 'SIGNED' : b.documentationDraft ? 'DRAFT' : 'NONE';

export interface DraftFields {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
  notes?: string;
  durationMin?: number | null;
}

/** Whitespace-insensitive, so an AI draft re-flowed by a textarea is still "unchanged". */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---- who is documenting ---------------------------------------------------------------------------

/**
 * The provider identity behind an account. An unattributed clinical record is not valid, so an
 * account that is not linked to an ACTIVE provider record cannot write or sign — even with a
 * provider role. (Same rule as the existing note routes.)
 */
export async function documenter(tx: Tx, accountId: string): Promise<{ staffId: string; staffName: string }> {
  const account = await tx.account.findUnique({ where: { id: accountId }, select: { staffId: true } });
  if (!account?.staffId) throw fail(403, 'no_provider_identity', 'Your account is not linked to a provider record, so it cannot write clinical documentation.');
  const staff = await tx.staff.findUnique({ where: { id: account.staffId }, select: { id: true, name: true, active: true } });
  if (!staff?.active) throw fail(403, 'no_provider_identity', 'Your provider record is inactive.');
  return { staffId: staff.id, staffName: staff.name };
}

/** The visit under its Booking lock, with everything the write rules need. */
export async function loadVisit(tx: Tx, bookingId: string) {
  await lockedBooking(tx, bookingId);                                    // 1. the Booking row (404s if unknown)
  return tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      encounter: true,
      service: { select: { id: true, name: true, documentationType: true } },
      staff: { select: { id: true, name: true, role: true } },
      noteSignature: true,
      documentationDraft: true,
    },
  });
}
export type Visit = Awaited<ReturnType<typeof loadVisit>>;

/** A confirmed visit whose patient has been checked in, booked with this provider's role. */
export function assertMayDocument(v: Visit, role: ProviderRole): void {
  if (v.status !== 'CONFIRMED') throw fail(409, 'not_confirmed', 'Only a confirmed appointment can be documented.');
  if (!v.encounter || !(DOCUMENTABLE as readonly string[]).includes(v.encounter.status)) {
    throw fail(409, 'not_checked_in', 'This patient has not been checked in yet.');
  }
  if (!roleMayDocument(v.staff?.role, role)) {
    throw fail(403, 'wrong_role', 'This visit was booked with a different provider role, so you cannot document it.');
  }
}

/** Role check for the scribe's follow-up calls (upload, finish, retry, discard), which act on a session rather than load the whole visit. */
export async function assertRoleForBooking(bookingId: string, role: ProviderRole): Promise<void> {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, select: { staff: { select: { role: true } } } });
  if (!b) throw fail(404, 'not_found', 'Unknown appointment.');
  if (!roleMayDocument(b.staff?.role, role)) throw fail(403, 'wrong_role', 'This visit was booked with a different provider role, so you cannot document it.');
}

/** CHECKED_IN → IN_PROGRESS the first time a provider works on the visit. Idempotent. */
export async function ensureStarted(tx: Tx, rec: Rec, v: Visit, accountId: string, now: Date): Promise<void> {
  if (v.encounter?.status !== 'CHECKED_IN') return;
  await tx.encounter.update({ where: { id: v.encounter.id }, data: { status: 'IN_PROGRESS', startedAt: now, startedById: accountId } });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: v.encounter.id, meta: { to: 'IN_PROGRESS', fields: ['status', 'startedAt'] } });
}

export async function startVisit(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; role: ProviderRole; now: Date }) {
  await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);
  assertMayDocument(v, a.role);
  await ensureStarted(tx, rec, v, a.accountId, a.now);
  return { status: v.encounter!.status === 'CHECKED_IN' ? ('IN_PROGRESS' as const) : v.encounter!.status };
}

// ---- the draft ------------------------------------------------------------------------------------

function checkFieldsFit(type: DocumentationType, f: DraftFields): void {
  if (type === 'SOAP' && (f.notes !== undefined || f.durationMin !== undefined)) {
    throw fail(400, 'wrong_fields', 'This service is documented as a SOAP note: use the four sections, not notes or a duration.');
  }
  if (type === 'SESSION_LOG' && SECTIONS.some((s) => f[s] !== undefined)) {
    throw fail(400, 'wrong_fields', 'This service is documented as a session log: use duration and notes, not the SOAP sections.');
  }
}

/** The fields that were actually sent, with their (untrimmed) text — the editor owns whitespace until signing. */
function sentFields(f: DraftFields): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const k of [...SECTIONS, 'notes'] as const) if (f[k] !== undefined) out[k] = f[k]!;
  if (f.durationMin !== undefined) out.durationMin = f.durationMin;
  return out;
}

export async function saveDraft(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; role: ProviderRole; version?: number; fields: DraftFields; now: Date }) {
  await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);
  assertMayDocument(v, a.role);
  if (v.noteSignature) throw fail(409, 'already_signed', 'This visit\'s documentation is already signed. Use an amendment to correct it.');
  checkFieldsFit(v.service.documentationType, a.fields);
  const data = sentFields(a.fields);
  const fieldNames = Object.keys(data);
  const existing = v.documentationDraft;

  let draft;
  if (!existing) {
    if (a.version !== undefined && a.version !== 0) {
      throw fail(409, 'no_draft', 'That draft no longer exists (it may have been signed). Reload the visit.');
    }
    draft = await tx.documentationDraft.create({
      data: {
        bookingId: v.id, type: v.service.documentationType, ...data,
        createdByAccountId: a.accountId, createdByRole: a.role as AccountRole, updatedByAccountId: a.accountId,
      },
    });
    await rec({ action: 'CREATE', resourceType: 'clinical_draft', resourceId: draft.id, meta: { fields: fieldNames, version: 1 } });
  } else {
    if (a.version !== existing.version) {
      throw fail(409, 'stale_draft', 'This draft changed in another window. Reload it before saving.', { currentVersion: existing.version });
    }
    draft = await tx.documentationDraft.update({
      where: { id: existing.id },
      data: { ...data, version: { increment: 1 }, updatedByAccountId: a.accountId },
    });
    await rec({ action: 'UPDATE', resourceType: 'clinical_draft', resourceId: draft.id, meta: { fields: fieldNames, version: draft.version } });
  }
  await ensureStarted(tx, rec, v, a.accountId, a.now);
  return draft;
}

/**
 * Put the AI scribe's draft into the working draft. `fill_empty` leaves anything the provider already
 * wrote; `replace_all` overwrites it. Either way the draft is marked as AI-sourced, which is what
 * makes signing it require the provider's explicit review.
 */
export async function applyAiDraft(
  tx: Tx, rec: Rec,
  a: { bookingId: string; accountId: string; role: ProviderRole; sessionId: string; mode: 'fill_empty' | 'replace_all'; version?: number; now: Date },
) {
  await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);
  assertMayDocument(v, a.role);
  if (v.noteSignature) throw fail(409, 'already_signed', 'This visit\'s documentation is already signed. Use an amendment to correct it.');
  if (v.service.documentationType !== 'SOAP') throw fail(409, 'not_soap', 'The scribe drafts SOAP notes; this service is documented as a session log.');

  const session = await tx.scribeSession.findFirst({ where: { id: a.sessionId, bookingId: v.id } });
  if (!session) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (session.status !== 'READY' || !session.draft) throw fail(409, 'draft_not_ready', 'That recording has no draft ready to use.');
  const ai = session.draft as Record<Section, string>;

  const existing = v.documentationDraft;
  if (existing && a.version !== existing.version) {
    throw fail(409, 'stale_draft', 'This draft changed in another window. Reload it before using the AI draft.', { currentVersion: existing.version });
  }
  const current: Record<Section, string> = {
    subjective: existing?.subjective ?? '', objective: existing?.objective ?? '', assessment: existing?.assessment ?? '', plan: existing?.plan ?? '',
  };
  const merged = { ...current };
  for (const s of SECTIONS) if (a.mode === 'replace_all' || current[s].trim() === '') merged[s] = String(ai[s] ?? '');

  const draft = existing
    ? await tx.documentationDraft.update({
      where: { id: existing.id },
      data: { ...merged, scribeSessionId: session.id, aiAppliedAt: a.now, version: { increment: 1 }, updatedByAccountId: a.accountId },
    })
    : await tx.documentationDraft.create({
      data: {
        bookingId: v.id, type: 'SOAP', ...merged, scribeSessionId: session.id, aiAppliedAt: a.now,
        createdByAccountId: a.accountId, createdByRole: a.role as AccountRole, updatedByAccountId: a.accountId,
      },
    });
  await tx.scribeSession.update({ where: { id: session.id }, data: { appliedAt: a.now } });
  await rec({ action: existing ? 'UPDATE' : 'CREATE', resourceType: 'clinical_draft', resourceId: draft.id, meta: { fields: [...SECTIONS], via: 'scribe', mode: a.mode, version: draft.version } });
  await ensureStarted(tx, rec, v, a.accountId, a.now);
  return draft;
}

// ---- signing --------------------------------------------------------------------------------------

export interface SignResult {
  signatureId: string;
  signedAt: Date;
  noteIds: string[];
  aiAssisted: boolean;
  aiDraftUnchanged: boolean | null;
}

export async function signDocumentation(
  tx: Tx, rec: Rec,
  a: { bookingId: string; accountId: string; role: ProviderRole; version: number; reviewedAiDraft?: boolean; now: Date },
): Promise<SignResult> {
  const who = await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);                              // 1. the Booking row, held to the end
  assertMayDocument(v, a.role);
  if (v.noteSignature) throw fail(409, 'already_signed', 'This visit\'s documentation is already signed.');

  const draft = v.documentationDraft;
  if (!draft) throw fail(409, 'no_draft', 'There is nothing to sign yet. Write the note first.');
  if (draft.version !== a.version) {
    throw fail(409, 'stale_draft', 'This draft changed in another window. Reload it, read it, then sign.', { currentVersion: draft.version });
  }
  const type = v.service.documentationType;

  // ---- an AI draft is never signed unreviewed -----------------------------------------------------
  let aiAssisted = false;
  let aiDraftUnchanged: boolean | null = null;
  if (draft.scribeSessionId) {
    if (a.reviewedAiDraft !== true) {
      throw fail(409, 'ai_review_required', 'Part of this note began as an AI-generated draft. Confirm that you have reviewed and edited it before signing.');
    }
    aiAssisted = true;
    const session = await tx.scribeSession.findUnique({ where: { id: draft.scribeSessionId }, select: { draft: true } });
    const ai = (session?.draft ?? null) as Record<Section, string> | null;
    aiDraftUnchanged = ai ? SECTIONS.every((s) => norm(String(ai[s] ?? '')) === norm(draft[s])) : null;
  }

  // ---- what has to be there --------------------------------------------------------------------
  let sections: Array<{ kind: NoteKind; body: string; durationMin: number | null }>;
  if (type === 'SOAP') {
    const missing = SECTIONS.filter((s) => norm(draft[s]) === '');
    if (missing.length) {
      throw fail(409, 'incomplete', `Complete every section before signing (write N/A where one does not apply): ${missing.map((s) => SECTION_LABEL[s]).join(', ')}.`, { missing });
    }
    sections = SECTIONS.map((s) => ({ kind: KIND_FOR[s], body: draft[s].trim(), durationMin: null }));
  } else {
    const missing: string[] = [];
    if (norm(draft.notes) === '') missing.push('notes');
    if (draft.durationMin == null) missing.push('durationMin');
    if (missing.length) throw fail(409, 'incomplete', 'A session log needs its duration and notes before it can be signed.', { missing });
    sections = [{ kind: 'GENERAL', body: draft.notes.trim(), durationMin: draft.durationMin }];
  }
  if (sections.some((s) => DEMO_TEXT.test(s.body))) {
    throw fail(409, 'demo_text_present', 'This still contains placeholder text from the demonstration scribe. Replace it with the real note before signing.');
  }

  // ---- the record ---------------------------------------------------------------------------------
  const noteIds: string[] = [];
  for (const [i, s] of sections.entries()) {
    const note = await tx.visitNote.create({
      data: {
        bookingId: v.id, authorId: who.staffId, authorAccountId: a.accountId, authorRole: a.role as AccountRole,
        // One millisecond apart, in S, O, A, P order: notes are shown by when the ORIGINAL was written
        // (lib/notes.ts), and four rows with the same instant would come back in no particular order.
        kind: s.kind, body: s.body, durationMin: s.durationMin, createdAt: new Date(a.now.getTime() + i),
      },
    });
    noteIds.push(note.id);
    await rec({ action: 'CREATE', resourceType: 'visit_note', resourceId: note.id, meta: { kind: s.kind, via: 'sign' } });
  }
  const sig = await tx.noteSignature.create({
    data: {
      bookingId: v.id, type, noteIds, signedAt: a.now, signedByAccountId: a.accountId, signedByStaffId: who.staffId,
      signedRole: a.role as AccountRole, scribeSessionId: draft.scribeSessionId, aiAssisted, aiDraftUnchanged,
    },
  });
  await rec({ action: 'CREATE', resourceType: 'note_signature', resourceId: sig.id, meta: { role: a.role, type, notes: noteIds.length, aiAssisted, aiDraftUnchanged } });

  const gone = await tx.documentationDraft.deleteMany({ where: { id: draft.id, version: draft.version } });
  if (gone.count !== 1) throw fail(409, 'stale_draft', 'This draft changed while it was being signed. Reload it and try again.');
  await rec({ action: 'DELETE', resourceType: 'clinical_draft', resourceId: draft.id, meta: { reason: 'signed' } });

  if (v.encounter && (v.encounter.status === 'CHECKED_IN' || v.encounter.status === 'IN_PROGRESS')) {
    await tx.encounter.update({
      where: { id: v.encounter.id },
      data: { status: 'SEEN', seenAt: a.now, ...(v.encounter.startedAt ? {} : { startedAt: a.now, startedById: a.accountId }) },
    });
    await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: v.encounter.id, meta: { to: 'SEEN', fields: ['status', 'seenAt'] } });
  }
  return { signatureId: sig.id, signedAt: a.now, noteIds, aiAssisted, aiDraftUnchanged };
}
