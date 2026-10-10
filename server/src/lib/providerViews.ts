/**
 * What the provider screens read: the queue of checked-in patients for one provider role, and the
 * documentation workspace for one visit.
 *
 * These contain patient names and clinical text, so they are only ever called from routes behind the
 * clinical gate (middleware/clinical.ts); the front desk's view of the same visits is the single
 * `documentation` status that appointmentView() carries, never anything from here.
 */

import type { AccountRole, Prisma } from '@prisma/client';
import { scribeAvailability } from '../integrations/index.js';
import { colorHexFor } from './serviceColors.js';
import { docStatus, type DocStatus } from './documentation.js';
import { resolveNoteChains, type RawNote } from './notes.js';
import { PROVIDER_ROLE_LABEL, STAFF_ROLE_FOR, roleMayDocument, type ProviderRole } from './providerRoles.js';
import { prisma } from './prisma.js';
import { draftOf } from './scribe.js';
import { localDayBounds, toLocalDateISO, toLocalHHMM } from './time.js';

const ENCOUNTER_STATES = ['CHECKED_IN', 'IN_PROGRESS', 'SEEN', 'CHECKED_OUT'] as const;
export const BACKLOG_DAYS = 30;

const QUEUE_INCLUDE = {
  service: { select: { id: true, name: true, color: true, documentationType: true } },
  staff: { select: { id: true, name: true, role: true } },
  user: { select: { name: true } },
  patient: { select: { id: true, firstName: true, lastName: true, preferredName: true } },
  encounter: { select: { id: true, status: true, checkedInAt: true, startedAt: true, seenAt: true, checkedOutAt: true } },
  noteSignature: { select: { signedAt: true, signedRole: true, signedByStaffId: true, type: true } },
  documentationDraft: { select: { id: true, updatedAt: true, scribeSessionId: true } },
} satisfies Prisma.BookingInclude;
type QueueRow = Prisma.BookingGetPayload<{ include: typeof QUEUE_INCLUDE }>;

function queueRow(b: QueueRow, role: ProviderRole, ownStaffId: string | null, now: Date, signers: Map<string, string>) {
  const doc: DocStatus = docStatus(b);
  const e = b.encounter!;
  return {
    bookingId: b.id,
    start: b.startTime.toISOString(),
    localDate: toLocalDateISO(b.startTime),
    localStart: toLocalHHMM(b.startTime),
    localEnd: toLocalHHMM(b.endTime),
    service: { id: b.service.id, name: b.service.name, color: colorHexFor(b.service.color), documentationType: b.service.documentationType },
    subOption: b.subOption,
    patient: { id: b.patient?.id ?? null, name: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.user.name },
    staff: b.staff ? { id: b.staff.id, name: b.staff.name } : null,
    /** This visit was booked with the signed-in provider personally (not just someone in their role). */
    isMine: !!b.staffId && b.staffId === ownStaffId,
    /** No provider was assigned (a room-only service): any provider role may document it. */
    unassigned: !b.staffId,
    mayDocument: roleMayDocument(b.staff?.role, role),
    encounter: { status: e.status, checkedInAt: e.checkedInAt, startedAt: e.startedAt, seenAt: e.seenAt, checkedOutAt: e.checkedOutAt },
    documentation: {
      status: doc,
      type: b.service.documentationType,
      signedAt: b.noteSignature?.signedAt ?? null,
      signedBy: b.noteSignature ? (signers.get(b.noteSignature.signedByStaffId) ?? null) : null,
      draftUpdatedAt: b.documentationDraft?.updatedAt ?? null,
    },
    /** Whole minutes since check-in, while the patient is still being seen. */
    waitingMinutes: e.checkedInAt && (e.status === 'CHECKED_IN' || e.status === 'IN_PROGRESS') ? Math.max(0, Math.floor((now.getTime() - e.checkedInAt.getTime()) / 60_000)) : null,
  };
}

/**
 * Today's checked-in patients for one provider role, longest-waiting first, each with its
 * documentation status — and, apart, earlier visits still waiting for a signature.
 */
export async function providerQueue(a: { role: ProviderRole; ownStaffId: string | null; now: Date }) {
  const today = toLocalDateISO(a.now);
  const { dayStart, dayEnd } = localDayBounds(today);
  const rows = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      startTime: { gte: new Date(dayStart.getTime() - BACKLOG_DAYS * 86_400_000), lt: dayEnd },
      encounter: { is: { status: { in: [...ENCOUNTER_STATES] }, deletedAt: null } },
      OR: [{ staff: { is: { role: STAFF_ROLE_FOR[a.role] } } }, { staffId: null }],
    },
    include: QUEUE_INCLUDE,
    orderBy: { startTime: 'asc' },
    take: 600,
  });

  const staffIds = [...new Set(rows.map((r) => r.noteSignature?.signedByStaffId).filter((x): x is string => !!x))];
  const signers = new Map((await prisma.staff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));

  const views = rows.map((b) => ({ b, v: queueRow(b, a.role, a.ownStaffId, a.now, signers) }));
  const isToday = (b: QueueRow) => b.startTime >= dayStart && b.startTime < dayEnd;
  const checkedIn = (b: QueueRow) => b.encounter!.checkedInAt?.getTime() ?? 0;

  const todayRows = views.filter(({ b }) => isToday(b)).sort((x, y) => checkedIn(x.b) - checkedIn(y.b)).map(({ v }) => v);
  const backlog = views.filter(({ b }) => !isToday(b) && !b.noteSignature).map(({ v }) => v).reverse();   // newest first
  return {
    role: a.role,
    roleLabel: PROVIDER_ROLE_LABEL[a.role],
    today,
    rows: todayRows,
    backlog,
    pending: todayRows.filter((r) => r.documentation.status !== 'SIGNED').length + backlog.length,
  };
}

/** The workspace for one visit. `canWrite` is false for an administrator and for the wrong provider role. */
export async function loadWorkspace(a: { bookingId: string; role: ProviderRole | null; ownStaffId: string | null }) {
  const b = await prisma.booking.findUnique({
    where: { id: a.bookingId },
    include: {
      service: { select: { id: true, name: true, documentationType: true } },
      staff: { select: { id: true, name: true, role: true } },
      user: { select: { name: true } },
      patient: { select: { id: true, firstName: true, lastName: true, preferredName: true } },
      encounter: true,
      noteSignature: true,
      documentationDraft: true,
      visitNotes: { include: { author: { select: { id: true, name: true, role: true } } }, orderBy: { createdAt: 'asc' } },
      scribeSessions: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!b) return null;

  // The name a signature will carry: the provider RECORD the login is linked to, not the login's display name.
  const signsAs = a.ownStaffId && a.role ? (await prisma.staff.findUnique({ where: { id: a.ownStaffId }, select: { name: true } }))?.name ?? null : null;
  const sig = b.noteSignature;
  const signer = sig ? await prisma.staff.findUnique({ where: { id: sig.signedByStaffId }, select: { name: true } }) : null;
  const d = b.documentationDraft;
  const scribe = scribeAvailability();
  const soap = b.service.documentationType === 'SOAP';

  let readOnlyReason: string | null = null;
  if (!a.role) readOnlyReason = 'Administrators can read clinical documentation but cannot write it.';
  else if (!roleMayDocument(b.staff?.role, a.role)) readOnlyReason = 'This visit was booked with a different provider role.';
  else if (!b.encounter || !(ENCOUNTER_STATES as readonly string[]).includes(b.encounter.status)) readOnlyReason = 'This patient has not been checked in.';
  else if (b.status !== 'CONFIRMED') readOnlyReason = 'Only a confirmed appointment can be documented.';

  return {
    booking: {
      id: b.id,
      localDate: toLocalDateISO(b.startTime),
      localStart: toLocalHHMM(b.startTime),
      localEnd: toLocalHHMM(b.endTime),
      service: { id: b.service.id, name: b.service.name, documentationType: b.service.documentationType },
      subOption: b.subOption,
      /** What the PATIENT wrote when booking — context for the provider, not a clinical note. */
      patientNote: b.patientNote,
      patient: { id: b.patient?.id ?? null, name: b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.user.name },
      provider: b.staff ? { id: b.staff.id, name: b.staff.name } : null,
    },
    encounter: b.encounter
      ? { status: b.encounter.status, checkedInAt: b.encounter.checkedInAt, startedAt: b.encounter.startedAt, seenAt: b.encounter.seenAt, scribeConsentAt: b.encounter.scribeConsentAt }
      : null,
    access: { canWrite: readOnlyReason === null, role: a.role, signsAs, readOnlyReason },
    documentation: { status: docStatus(b), type: b.service.documentationType },
    draft: d
      ? {
        version: d.version, subjective: d.subjective, objective: d.objective, assessment: d.assessment, plan: d.plan,
        notes: d.notes, durationMin: d.durationMin, aiDrafted: !!d.scribeSessionId, aiAppliedAt: d.aiAppliedAt, updatedAt: d.updatedAt,
      }
      : null,
    signature: sig
      ? {
        signedAt: sig.signedAt, signedBy: signer?.name ?? null, signedRole: sig.signedRole as AccountRole,
        aiAssisted: sig.aiAssisted, aiDraftUnchanged: sig.aiDraftUnchanged,
        /** Newer rows exist behind the ones that were signed. */
        amended: b.visitNotes.some((n) => n.amendsId !== null),
      }
      : null,
    notes: resolveNoteChains(b.visitNotes as RawNote[]),
    scribe: {
      applicable: soap,
      available: scribe.available,
      unavailableReason: scribe.reason,
      consentAt: b.encounter?.scribeConsentAt ?? null,
      sessions: b.scribeSessions
        .filter((s) => s.status !== 'DISCARDED')
        .map((s) => ({ id: s.id, status: s.status, failureCode: s.failureCode, createdAt: s.createdAt, applied: !!s.appliedAt, hasDraft: !!draftOf(s) })),
    },
  };
}
