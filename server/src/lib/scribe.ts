/**
 * The AI scribe: record a visit, transcribe it, draft a SOAP note — and hand the draft to a provider.
 *
 *   consent → start (RECORDING) → upload → finish (UPLOADED) → TRANSCRIBING → DRAFTING → READY
 *                                                                          ↘ FAILED (retry) / DISCARDED
 *
 * What is never done here:
 *   • a draft is never signed, and is never put into the note on its own — the provider chooses to
 *     insert it (lib/documentation.ts applyAiDraft), and signing it needs their explicit review;
 *   • audio, transcript and draft text are never logged. Only opaque ids, byte counts and status
 *     names are. Audio and transcript live in FileStorage under random keys; the database keeps the
 *     keys (ScribeSession) and nothing else about their contents;
 *   • a recording needs the patient's consent, recorded on the Encounter (scribeConsentAt) by the
 *     provider before any audio can be started.
 *
 * Every read and write of audio, transcript and draft is audited (resource types scribe_session,
 * scribe_audio, scribe_transcript). Background processing runs under the starting provider's
 * identity, so its audit rows say who the work was for.
 */

import { randomUUID } from 'node:crypto';
import { Prisma, type AccountRole } from '@prisma/client';
import { getIntegrations, scribeAvailability } from '../integrations/index.js';
import type { SoapDraft } from '../integrations/types.js';
import { assertMayDocument, DocError, documenter, ensureStarted, loadVisit, SECTIONS, type Section } from './documentation.js';
import { logger } from './logger.js';
import { newContext, runWithContext } from './requestContext.js';
import type { ProviderRole } from './providerRoles.js';
import { basePrisma } from './prismaBase.js';
import { staffTransaction, type Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;
const fail = (status: 400 | 403 | 404 | 409 | 503, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new DocError(status, code, message, extra);

export const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 15 * 60;
/** A session stuck mid-processing for this long is reported as failed so the provider can retry it. */
export const STALE_AFTER_MS = 15 * 60_000;

/** The recording formats a browser's MediaRecorder produces, by base type → file extension. */
const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
};
export const audioExtension = (contentType: string): string | null => AUDIO_TYPES[contentType.split(';')[0]!.trim().toLowerCase()] ?? null;

export function assertScribeAvailable(): void {
  const a = scribeAvailability();
  if (!a.available) {
    throw fail(503, 'scribe_unavailable', a.reason === 'stub_in_production'
      ? 'The AI scribe is switched off until secure storage and transcription are connected.'
      : 'The AI scribe is not enabled.', { reason: a.reason });
  }
}

// ---- consent, start, upload, finish ----------------------------------------------------------------

/** The provider records that the patient agreed to this visit being recorded. No audio can start without it. */
export async function recordScribeConsent(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; role: ProviderRole; now: Date }) {
  const me = await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);
  assertMayDocument(v, a.role, me);
  const enc = v.encounter!;
  if (enc.scribeConsentAt) return { scribeConsentAt: enc.scribeConsentAt, changed: false as const };
  await tx.encounter.update({ where: { id: enc.id }, data: { scribeConsentAt: a.now } });
  await rec({ action: 'UPDATE', resourceType: 'encounter', resourceId: enc.id, meta: { fields: ['scribeConsentAt'], via: 'provider_attestation' } });
  return { scribeConsentAt: a.now, changed: true as const };
}

export async function startSession(tx: Tx, rec: Rec, a: { bookingId: string; accountId: string; role: ProviderRole; contentType: string; now: Date }) {
  assertScribeAvailable();
  const ext = audioExtension(a.contentType);
  if (!ext) throw fail(400, 'bad_audio_type', 'That recording format is not supported.');
  const me = await documenter(tx, a.accountId);
  const v = await loadVisit(tx, a.bookingId);
  assertMayDocument(v, a.role, me);
  if (v.noteSignature) throw fail(409, 'already_signed', 'This visit\'s documentation is already signed.');
  if (v.service.documentationType !== 'SOAP') throw fail(409, 'not_soap', 'The scribe drafts SOAP notes; this service is documented as a session log.');
  if (!v.encounter!.scribeConsentAt) throw fail(409, 'consent_required', 'Confirm that the patient has agreed to the recording before it starts.');

  const open = await tx.scribeSession.count({ where: { bookingId: v.id, status: { in: ['RECORDING', 'UPLOADED', 'TRANSCRIBING', 'DRAFTING'] } } });
  if (open >= 3) throw fail(409, 'too_many_recordings', 'Finish or discard the recordings already in progress for this visit first.');

  const session = await tx.scribeSession.create({
    data: {
      bookingId: v.id, encounterId: v.encounter!.id, startedByAccountId: a.accountId, startedRole: a.role as AccountRole,
      audioKey: `scribe/audio/${randomUUID()}.${ext}`, audioContentType: a.contentType.slice(0, 100),
    },
  });
  await rec({ action: 'CREATE', resourceType: 'scribe_session', resourceId: session.id, meta: { encounter: v.encounter!.id } });
  await ensureStarted(tx, rec, v, a.accountId, a.now);                    // recording is work on the visit
  return session;
}

/** Where the browser should PUT the recording. Only while the session is still waiting for it. */
export async function uploadTargetFor(sessionId: string, bookingId: string) {
  const s = await basePrisma.scribeSession.findFirst({ where: { id: sessionId, bookingId } });
  if (!s) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (s.status !== 'RECORDING') throw fail(409, 'not_recording', 'That recording has already been uploaded.');
  const target = await getIntegrations().storage.getUploadTarget(s.audioKey, { contentType: s.audioContentType, ttlSeconds: UPLOAD_TTL_SECONDS });
  return { sessionId: s.id, upload: { url: target.url, method: target.method, headers: target.headers, expiresAt: target.expiresAt.toISOString() } };
}

/**
 * The browser says the upload is done. Check the audio really is in storage, then queue processing.
 * Idempotent: finishing a session that is already past RECORDING changes nothing.
 */
export async function finishSession(a: { sessionId: string; bookingId: string; accountId: string; roles: string[]; bytes?: number }) {
  const s = await basePrisma.scribeSession.findFirst({ where: { id: a.sessionId, bookingId: a.bookingId } });
  if (!s) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (s.status !== 'RECORDING') return { session: s, queued: false as const };
  if (!(await getIntegrations().storage.exists(s.audioKey))) {
    throw fail(409, 'upload_missing', 'The recording has not arrived. Upload it again.');
  }
  const claimed = await staffTransaction(async (tx, rec) => {
    const r = await tx.scribeSession.updateMany({ where: { id: s.id, status: 'RECORDING' }, data: { status: 'UPLOADED', audioBytes: a.bytes ?? null, failureCode: null } });
    if (r.count === 1) await rec({ action: 'CREATE', resourceType: 'scribe_audio', resourceId: s.id, meta: { bytes: a.bytes ?? null } });
    return r.count === 1;
  });
  const session = await basePrisma.scribeSession.findUniqueOrThrow({ where: { id: s.id } });
  if (claimed) startProcessing(s.id, a.accountId, a.roles);
  return { session, queued: claimed };
}

/** Retry a failed session: back to UPLOADED and processed again from where it stopped. */
export async function retrySession(a: { sessionId: string; bookingId: string; accountId: string; roles: string[] }) {
  const s = await basePrisma.scribeSession.findFirst({ where: { id: a.sessionId, bookingId: a.bookingId } });
  if (!s) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (s.status !== 'FAILED') throw fail(409, 'not_failed', 'Only a recording that failed can be retried.');
  await staffTransaction(async (tx, rec) => {
    const r = await tx.scribeSession.updateMany({ where: { id: s.id, status: 'FAILED' }, data: { status: 'UPLOADED', failureCode: null } });
    if (r.count === 1) await rec({ action: 'UPDATE', resourceType: 'scribe_session', resourceId: s.id, meta: { to: 'UPLOADED', via: 'retry' } });
  });
  startProcessing(s.id, a.accountId, a.roles);
  return basePrisma.scribeSession.findUniqueOrThrow({ where: { id: s.id } });
}

// ---- processing ------------------------------------------------------------------------------------

/**
 * Runs in the background of the request that queued it, under the provider's identity. Tests await
 * `processSession` directly; production code never waits for it (a real transcription can take
 * minutes) and the browser polls the session's status.
 */
function startProcessing(sessionId: string, accountId: string, roles: string[]): void {
  const ctx = newContext({ actor: { accountId, roles }, system: 'scribe' });
  void runWithContext(ctx, () => processSession(sessionId)).catch((err) => logger.error('scribe_processing_crashed', new Error(errorClass(err)), { sessionId }));
}

type Stage = 'transcribe_failed' | 'draft_failed';
const errorClass = (err: unknown): string => (err instanceof Error ? err.constructor?.name || err.name || 'Error' : typeof err);

/** Idempotent: each stage is skipped if its output exists, and a stage is only started by whoever claims it. */
export async function processSession(sessionId: string): Promise<void> {
  const { aiScribe } = getIntegrations();
  const claim = await basePrisma.scribeSession.updateMany({ where: { id: sessionId, status: 'UPLOADED' }, data: { status: 'TRANSCRIBING' } });
  if (claim.count !== 1) return;                                          // someone else has it, or it is not ready

  let stage: Stage = 'transcribe_failed';
  try {
    let s = await basePrisma.scribeSession.findUniqueOrThrow({ where: { id: sessionId } });
    let transcriptKey = s.transcriptKey;
    if (!transcriptKey) {
      transcriptKey = (await aiScribe.transcribe({ audioKey: s.audioKey })).transcriptKey;
      await staffTransaction(async (tx, rec) => {
        await tx.scribeSession.update({ where: { id: sessionId }, data: { transcriptKey, status: 'DRAFTING' } });
        await rec({ action: 'CREATE', resourceType: 'scribe_transcript', resourceId: sessionId, meta: { stage: 'transcribed' } });
      });
    } else {
      await basePrisma.scribeSession.update({ where: { id: sessionId }, data: { status: 'DRAFTING' } });
    }

    stage = 'draft_failed';
    const draft: SoapDraft = await aiScribe.draftSoap({ transcriptKey });
    s = await basePrisma.scribeSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (s.status === 'DISCARDED') return;                                 // thrown away while it was being drafted
    await staffTransaction(async (tx, rec) => {
      await tx.scribeSession.update({
        where: { id: sessionId },
        data: {
          status: 'READY', draftModelId: draft.modelId,
          draft: { subjective: draft.subjective, objective: draft.objective, assessment: draft.assessment, plan: draft.plan, modelId: draft.modelId },
        },
      });
      await rec({ action: 'CREATE', resourceType: 'scribe_draft', resourceId: sessionId, meta: { model: draft.modelId } });
    });
    logger.info('scribe_ready', { sessionId });
  } catch (err) {
    // An adapter's message can quote what it was given (a transcript, a name), and the logger's generic
    // redactor cannot know that. So the message is NOT logged at all: only the error's class, the stage
    // and the session id. A CATEGORY is kept on the row for the provider to act on.
    logger.warn('scribe_failed', { sessionId, stage, errorClass: errorClass(err) });
    await basePrisma.scribeSession.updateMany({ where: { id: sessionId, status: { in: ['TRANSCRIBING', 'DRAFTING'] } }, data: { status: 'FAILED', failureCode: stage } });
  }
}

/**
 * A session that has sat in a working state too long is reported failed, so it can be retried.
 * Measured against the WALL clock, not the application's injectable one: `updatedAt` is stamped by
 * the database client with real time, so that is the only clock it can honestly be compared with.
 */
export async function healStale(sessionId: string): Promise<void> {
  await basePrisma.scribeSession.updateMany({
    where: { id: sessionId, status: { in: ['UPLOADED', 'TRANSCRIBING', 'DRAFTING'] }, updatedAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { status: 'FAILED', failureCode: 'timed_out' },
  });
}

// ---- reading and discarding -------------------------------------------------------------------------

export async function readTranscript(sessionId: string, bookingId: string): Promise<string> {
  const s = await basePrisma.scribeSession.findFirst({ where: { id: sessionId, bookingId } });
  if (!s) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (!s.transcriptKey || s.status === 'DISCARDED') throw fail(409, 'no_transcript', 'There is no transcript for that recording.');
  return (await getIntegrations().storage.get(s.transcriptKey)).toString('utf8');
}

export function draftOf(session: { draft: unknown }): (Record<Section, string> & { modelId: string }) | null {
  const d = session.draft as Record<string, unknown> | null;
  if (!d) return null;
  const out: Record<string, string> = { modelId: String(d.modelId ?? '') };
  for (const k of SECTIONS) out[k] = String(d[k] ?? '');
  return out as Record<Section, string> & { modelId: string };
}

/**
 * The provider throws a recording away (the patient withdrew consent, or it was a mistake): audio and
 * transcript are deleted from storage. Refused once its draft has been put into the note, because the
 * note then rests on it. The session row stays, as DISCARDED, so the trail shows it happened.
 */
export async function discardSession(a: { sessionId: string; bookingId: string }) {
  const s = await basePrisma.scribeSession.findFirst({ where: { id: a.sessionId, bookingId: a.bookingId } });
  if (!s) throw fail(404, 'unknown_session', 'Unknown recording.');
  if (s.status === 'DISCARDED') return s;
  if (s.appliedAt) throw fail(409, 'already_used', 'Its draft is already part of the note, so the recording is kept with it.');
  const { storage } = getIntegrations();
  await storage.delete(s.audioKey);
  if (s.transcriptKey) await storage.delete(s.transcriptKey);
  return staffTransaction(async (tx, rec) => {
    // The draft text goes with the audio: a discarded recording leaves nothing of its content behind.
    const row = await tx.scribeSession.update({ where: { id: s.id }, data: { status: 'DISCARDED', discardedAt: new Date(), draft: Prisma.DbNull, draftModelId: null } });
    await rec({ action: 'DELETE', resourceType: 'scribe_audio', resourceId: s.id });
    if (s.transcriptKey) await rec({ action: 'DELETE', resourceType: 'scribe_transcript', resourceId: s.id });
    await rec({ action: 'UPDATE', resourceType: 'scribe_session', resourceId: s.id, meta: { to: 'DISCARDED' } });
    return row;
  });
}
