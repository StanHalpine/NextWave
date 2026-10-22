/**
 * Provider module: the queue of checked-in patients, and the documentation workspace.
 *
 *   GET  /api/provider/queue?role=                        today's checked-in patients for a provider role + earlier unsigned
 *   POST /api/provider/visits/:id/start                   CHECKED_IN → IN_PROGRESS
 *   GET  /api/provider/visits/:id/documentation           the workspace: draft, signed notes, scribe state
 *   PUT  /api/provider/visits/:id/draft                   save the working draft (optimistic version)
 *   GET  /api/provider/unsigned-notes?staffId=            a provider's visits whose required note is unsigned, oldest first (rev 2.0)
 *   POST /api/provider/visits/:id/sign                    sign: draft → VisitNotes + NoteSignature; an open visit → SEEN (a checked-out one stays checked out)
 *   POST /api/provider/visits/:id/scribe/consent          the patient agreed to be recorded
 *   POST /api/provider/visits/:id/scribe/sessions         begin a recording
 *   POST …/scribe/sessions/:sid/upload                    where to PUT the audio
 *   POST …/scribe/sessions/:sid/finish                    audio uploaded → transcribe and draft
 *   GET  …/scribe/sessions/:sid                           status (polled)
 *   GET  …/scribe/sessions/:sid/transcript | /draft       read them (audited)
 *   POST …/scribe/sessions/:sid/apply | retry | discard
 *
 * Access is in middleware/clinical.ts: providers and admins may read, only providers write, front
 * desk is refused outright, and everyone needs the authenticator first. Corrections AFTER signing
 * use the existing POST /api/visit-notes/:id/amend (routes/notes.ts), unchanged.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { applyAiDraft, assertRoleForBooking, saveDraft, signDocumentation, startVisit } from '../lib/documentation.js';
import { isProviderRole, providerRolesOf, type ProviderRole } from '../lib/providerRoles.js';
import { prisma } from '../lib/prisma.js';
import { loadWorkspace, providerQueue } from '../lib/providerViews.js';
import {
  assertScribeAvailable, discardSession, draftOf, finishSession, healStale, readTranscript, recordScribeConsent, retrySession, startSession, uploadTargetFor,
} from '../lib/scribe.js';
import { staffTransaction } from '../lib/staffTx.js';
import { unsignedNoteCounts, unsignedNotes } from '../lib/unsignedNotes.js';
import { actingRole, requireClinicalRead, requireClinicalWrite } from '../middleware/clinical.js';
import { sendKnownError } from './http.js';

export const providerRouter = Router();

const id = (req: Request) => req.params.id ?? '';
const sid = (req: Request) => req.params.sid ?? '';

/** The provider role a WRITE acts as (the gate already guarantees the account holds at least one). */
function writeRole(req: Request, res: Response, requested: unknown): ProviderRole | null {
  const r = actingRole(req, requested);
  if ('error' in r) { res.status(400).json({ error: r.error, code: 'role_required' }); return null; }
  if (!r.role) { res.status(403).json({ error: 'Administrators can read clinical documentation but cannot write it.', code: 'read_only' }); return null; }
  return r.role;
}

// ---- the queue -----------------------------------------------------------------------------------------

providerRouter.get('/provider/queue', ...requireClinicalRead, async (req, res) => {
  const held = providerRolesOf(req.auth!.account.roles);
  const asked = typeof req.query.role === 'string' ? req.query.role : undefined;
  let role: ProviderRole;
  if (asked) {
    if (!isProviderRole(asked)) return res.status(400).json({ error: 'Unknown provider role.', code: 'bad_request' });
    // A provider sees the queue of a role they hold; an administrator may look at any (read-only).
    if (!held.includes(asked) && !req.auth!.account.roles.includes('ADMIN')) {
      return res.status(403).json({ error: 'You do not hold that provider role.', code: 'forbidden' });
    }
    role = asked;
  } else if (held[0]) {
    role = held[0];
  } else {
    return res.status(400).json({ error: 'Choose which role\'s queue to view.', code: 'role_required' });
  }

  const queue = await providerQueue({ role, ownStaffId: req.auth!.account.staffId, now: now() });
  audit.read('encounter', null, { scope: 'provider_queue', role, count: queue.rows.length + queue.backlog.length }, `provider_queue:${role}`);
  const ownStaffId = req.auth!.account.staffId;
  res.json({
    ...queue,
    /** Counts for the link to the signed-in provider's own Unsigned notes worklist (null with no provider record). */
    unsignedNotes: ownStaffId ? await unsignedNoteCounts({ staffId: ownStaffId, now: now() }) : null,
    /** The roles this account may switch between, and whether each is theirs to write in. */
    roles: [
      ...held.map((r) => ({ role: r, own: true })),
      ...(req.auth!.account.roles.includes('ADMIN')
        ? (['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const).filter((r) => !held.includes(r)).map((r) => ({ role: r, own: false }))
        : []),
    ],
  });
});

// ---- the unsigned notes worklist (rev 2.0) --------------------------------------------------------------

/** The staff roles whose visits carry notes: the people an administrator can pick a worklist for. */
const PROVIDER_STAFF_ROLES = ['CHIROPRACTOR', 'NURSE_PRACTITIONER', 'REGISTERED_NURSE'] as const;

/**
 * A provider reads their OWN list (the provider record their login is linked to); naming anyone else is refused. An administrator
 * may read anyone's, and is given the list of providers to choose from. See lib/unsignedNotes.ts.
 */
providerRouter.get('/provider/unsigned-notes', ...requireClinicalRead, async (req, res) => {
  const me = req.auth!.account;
  const isAdmin = me.roles.includes('ADMIN');
  const asked = typeof req.query.staffId === 'string' && req.query.staffId !== '' ? req.query.staffId : null;
  if (asked && asked !== me.staffId && !isAdmin) {
    return res.status(403).json({ error: 'You can see only your own unsigned notes.', code: 'forbidden' });
  }
  const providers = isAdmin
    ? await prisma.staff.findMany({ where: { role: { in: [...PROVIDER_STAFF_ROLES] } }, orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true, name: true, role: true, active: true } })
    : null;
  const base = { now: now().toISOString(), timezone: config.clinicTimezone, thresholdHours: config.noteOverdueHours, providers };

  const staffId = asked ?? me.staffId;
  if (!staffId) {
    return res.json({
      ...base, provider: null, rows: [], overdue: 0, more: false,
      reason: isAdmin ? 'Choose whose unsigned notes to see.' : 'Your account is not linked to a provider record, so it has no notes of its own.',
    });
  }
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, name: true, role: true, active: true } });
  if (!staff || !(PROVIDER_STAFF_ROLES as readonly string[]).includes(staff.role)) return res.status(404).json({ error: 'Unknown provider.', code: 'not_found' });

  const list = await unsignedNotes({ staffId, now: now() });
  audit.read('encounter', null, { scope: 'unsigned_notes', staffId, own: staffId === me.staffId, count: list.rows.length }, `unsigned_notes:${staffId}`);
  res.json({ ...base, provider: { ...staff, own: staffId === me.staffId }, ...list, reason: null });
});

// ---- the workspace -------------------------------------------------------------------------------------

providerRouter.get('/provider/visits/:id/documentation', ...requireClinicalRead, async (req, res) => {
  const acting = actingRole(req, typeof req.query.role === 'string' ? req.query.role : undefined);
  const role = 'error' in acting ? null : acting.role;
  // Opening a visit also settles any scribe session that was left mid-processing.
  const pending = await prisma.scribeSession.findMany({ where: { bookingId: id(req), status: { in: ['UPLOADED', 'TRANSCRIBING', 'DRAFTING'] } }, select: { id: true } });
  for (const p of pending) await healStale(p.id);

  const ws = await loadWorkspace({
    bookingId: id(req), role, ownStaffId: req.auth!.account.staffId, ownAccountId: req.auth!.account.id,
    canAddend: providerRolesOf(req.auth!.account.roles).length > 0,
  });
  if (!ws) return res.status(404).json({ error: 'Unknown appointment.', code: 'not_found' });

  audit.read('encounter', id(req), { scope: 'documentation_workspace' });
  if (ws.draft) audit.read('clinical_draft', id(req), { scope: 'workspace' });
  if (ws.notes.length) audit.read('visit_note', id(req), { scope: 'workspace', notes: ws.notes.length });
  res.json(ws);
});

providerRouter.post('/provider/visits/:id/start', ...requireClinicalWrite, async (req, res) => {
  const role = writeRole(req, res, req.body?.role);
  if (!role) return;
  try {
    res.json(await staffTransaction((tx, rec) => startVisit(tx, rec, { bookingId: id(req), accountId: req.auth!.account.id, role, now: now() })));
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

const text = z.string().max(20000);
const draftBody = z.object({
  role: z.string().max(40).optional(),
  version: z.number().int().min(0).optional(),
  subjective: text.optional(), objective: text.optional(), assessment: text.optional(), plan: text.optional(),
  notes: text.optional(),
  durationMin: z.number().int().min(1).max(1440).nullable().optional(),
}).strict();

providerRouter.put('/provider/visits/:id/draft', ...requireClinicalWrite, async (req, res) => {
  const parsed = draftBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid draft.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  const { role: _r, version, ...fields } = parsed.data;
  try {
    const draft = await staffTransaction((tx, rec) => saveDraft(tx, rec, { bookingId: id(req), accountId: req.auth!.account.id, role, version, fields, now: now() }));
    res.json({ version: draft.version, updatedAt: draft.updatedAt });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

const signBody = z.object({
  role: z.string().max(40).optional(),
  version: z.number().int().min(1),
  /** The provider's explicit "I have reviewed and edited this" — required when the draft began as an AI draft. */
  reviewedAiDraft: z.boolean().optional(),
}).strict();

providerRouter.post('/provider/visits/:id/sign', ...requireClinicalWrite, async (req, res) => {
  const parsed = signBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    const out = await staffTransaction((tx, rec) => signDocumentation(tx, rec, {
      bookingId: id(req), accountId: req.auth!.account.id, role, version: parsed.data.version, reviewedAiDraft: parsed.data.reviewedAiDraft, now: now(),
    }));
    res.status(201).json({ signed: { signedAt: out.signedAt, role, noteIds: out.noteIds, aiAssisted: out.aiAssisted, aiDraftUnchanged: out.aiDraftUnchanged, afterCheckout: out.afterCheckout } });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

// ---- the AI scribe -------------------------------------------------------------------------------------

const roleOnly = z.object({ role: z.string().max(40).optional() }).strict();

providerRouter.post('/provider/visits/:id/scribe/consent', ...requireClinicalWrite, async (req, res) => {
  const parsed = z.object({ role: z.string().max(40).optional(), consented: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Confirm that the patient agreed to the recording.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    assertScribeAvailable();
    const r = await staffTransaction((tx, rec) => recordScribeConsent(tx, rec, { bookingId: id(req), accountId: req.auth!.account.id, role, now: now() }));
    res.json({ scribeConsentAt: r.scribeConsentAt });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.post('/provider/visits/:id/scribe/sessions', ...requireClinicalWrite, async (req, res) => {
  const parsed = z.object({ role: z.string().max(40).optional(), contentType: z.string().min(3).max(100) }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Say what format the recording is in.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    const s = await staffTransaction((tx, rec) => startSession(tx, rec, { bookingId: id(req), accountId: req.auth!.account.id, role, contentType: parsed.data.contentType, now: now() }));
    res.status(201).json({ session: { id: s.id, status: s.status } });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.post('/provider/visits/:id/scribe/sessions/:sid/upload', ...requireClinicalWrite, async (req, res) => {
  const parsed = roleOnly.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    assertScribeAvailable();
    await assertRoleForBooking(id(req), role);
    res.json(await uploadTargetFor(sid(req), id(req)));
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.post('/provider/visits/:id/scribe/sessions/:sid/finish', ...requireClinicalWrite, async (req, res) => {
  const parsed = z.object({ role: z.string().max(40).optional(), bytes: z.number().int().min(0).max(1_000_000_000).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    assertScribeAvailable();
    await assertRoleForBooking(id(req), role);
    const r = await finishSession({ sessionId: sid(req), bookingId: id(req), accountId: req.auth!.account.id, roles: req.auth!.account.roles, bytes: parsed.data.bytes });
    res.status(202).json({ session: { id: r.session.id, status: r.session.status }, queued: r.queued });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.get('/provider/visits/:id/scribe/sessions/:sid', ...requireClinicalRead, async (req, res) => {
  await healStale(sid(req));
  const s = await prisma.scribeSession.findFirst({ where: { id: sid(req), bookingId: id(req) } });
  if (!s) return res.status(404).json({ error: 'Unknown recording.', code: 'not_found' });
  res.json({ session: { id: s.id, status: s.status, failureCode: s.failureCode, applied: !!s.appliedAt, hasDraft: !!draftOf(s) } });
});

providerRouter.get('/provider/visits/:id/scribe/sessions/:sid/transcript', ...requireClinicalRead, async (req, res) => {
  try {
    const transcript = await readTranscript(sid(req), id(req));
    audit.read('scribe_transcript', sid(req), { scope: 'workspace' });
    res.json({ transcript });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.get('/provider/visits/:id/scribe/sessions/:sid/draft', ...requireClinicalRead, async (req, res) => {
  const s = await prisma.scribeSession.findFirst({ where: { id: sid(req), bookingId: id(req) } });
  const draft = s && s.status === 'READY' ? draftOf(s) : null;
  if (!s || !draft) return res.status(404).json({ error: 'There is no draft for that recording.', code: 'not_found' });
  audit.read('scribe_draft', s.id, { scope: 'workspace' });
  res.json({ draft: { subjective: draft.subjective, objective: draft.objective, assessment: draft.assessment, plan: draft.plan }, modelId: draft.modelId, applied: !!s.appliedAt });
});

providerRouter.post('/provider/visits/:id/scribe/sessions/:sid/apply', ...requireClinicalWrite, async (req, res) => {
  const parsed = z.object({ role: z.string().max(40).optional(), mode: z.enum(['fill_empty', 'replace_all']), version: z.number().int().min(0).optional() }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Choose how to use the draft.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    const draft = await staffTransaction((tx, rec) => applyAiDraft(tx, rec, {
      bookingId: id(req), accountId: req.auth!.account.id, role, sessionId: sid(req), mode: parsed.data.mode, version: parsed.data.version, now: now(),
    }));
    res.json({ version: draft.version, updatedAt: draft.updatedAt });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.post('/provider/visits/:id/scribe/sessions/:sid/retry', ...requireClinicalWrite, async (req, res) => {
  const parsed = roleOnly.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    assertScribeAvailable();
    await assertRoleForBooking(id(req), role);
    const s = await retrySession({ sessionId: sid(req), bookingId: id(req), accountId: req.auth!.account.id, roles: req.auth!.account.roles });
    res.status(202).json({ session: { id: s.id, status: s.status } });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});

providerRouter.post('/provider/visits/:id/scribe/sessions/:sid/discard', ...requireClinicalWrite, async (req, res) => {
  const parsed = roleOnly.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.', code: 'bad_request' });
  const role = writeRole(req, res, parsed.data.role);
  if (!role) return;
  try {
    await assertRoleForBooking(id(req), role);
    const s = await discardSession({ sessionId: sid(req), bookingId: id(req) });
    res.json({ session: { id: s.id, status: s.status } });
  } catch (err) { if (!sendKnownError(res, err)) throw err; }
});
