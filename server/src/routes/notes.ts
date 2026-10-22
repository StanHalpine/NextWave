/**
 * Clinical visit notes and patient history.
 *
 * Every route here returns or accepts PHI, so all of them require a signed-in
 * staff account.
 *
 *   WRITE a note      not here any more (rev 2.1): POST /bookings/:id/notes answers 410 and notes are
 *                     written and signed in the Provider workspace. Amendments (the signer only) and
 *                     addenda (any provider) still are, attributed from the SESSION, never the body.
 *   READ note text    providers and admins. Front desk sees THAT notes exist
 *                     (a count) but not what they say — minimum necessary.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { now } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import { loadAddenda } from '../lib/addenda.js';
import { requireClinicalWrite } from '../middleware/clinical.js';
import { hasRole, requireRole } from '../middleware/session.js';
import { PROVIDER_ROLES } from '../lib/sessions.js';
import { isSigner, resolveNoteChains, type RawNote } from '../lib/notes.js';
import type { Request } from 'express';
import type { AccountRole } from '@prisma/client';

export const notesRouter = Router();

const NOTE_INCLUDE = {
  author: { select: { id: true, name: true, role: true } },
} as const;

/**
 * The provider identity behind this request. An unattributed clinical note is
 * not a valid record, so a signed-in account that is not linked to an active
 * provider record cannot write one — even if it has a provider role.
 */
async function sessionAuthor(req: Request): Promise<{ staffId: string; role: AccountRole } | { error: string }> {
  const account = req.auth!.account;
  const role = account.roles.find((r) => PROVIDER_ROLES.includes(r));
  if (!role || !account.staffId) return { error: 'Your account is not linked to a provider record, so it cannot write clinical notes.' };
  const staff = await prisma.staff.findUnique({ where: { id: account.staffId }, select: { active: true } });
  if (!staff?.active) return { error: 'Your provider record is inactive.' };
  return { staffId: account.staffId, role };
}

const canReadNotes = (req: Request) => hasRole(req, 'ADMIN', ...PROVIDER_ROLES);

/**
 * POST /api/bookings/:id/notes — CLOSED to new notes (rev 2.1). It accepted a free-standing note on any booking from any provider-role
 * account, outside the draft → sign flow and the rule that only the visit's provider may write (lib/visitProvider.ts). Notes are
 * written and signed in the Provider workspace (/api/provider/visits/:id/…). The role gate stays, so front desk and admin-only
 * accounts are still refused as before; a provider is told where notes are written. Reading notes here is unchanged.
 */
notesRouter.post('/bookings/:id/notes', requireRole(...PROVIDER_ROLES), (_req, res) => {
  res.status(410).json({
    code: 'notes_moved',
    error: 'Clinical notes are written and signed in the Provider workspace (Provider → open the visit). This older route no longer accepts new notes; notes already written here can still be read.',
  });
});

const amendBody = z.object({
  body: z.string().trim().min(1, 'An amended note cannot be empty.').max(20000),
  amendReason: z.string().trim().min(1, 'An amendment must say why.').max(500),
  /** A session log's duration. Omit to keep the amended note's; send to correct it (the old figure stays in the chain). */
  durationMin: z.number().int().min(1).max(1440).optional(),
}).strict();

/**
 * POST /api/visit-notes/:id/amend — supersede a note.
 *
 * Deliberately POST-and-insert rather than PATCH-and-update: the original text
 * is preserved verbatim. There is no endpoint that mutates or deletes a note.
 *
 * ONLY THE PROVIDER WHO SIGNED a note may amend it. Anyone else with a provider role adds an ADDENDUM
 * instead (POST /visit-notes/:id/addendum, below); an administrator has no write path at all. This is
 * access control only — how an amendment is stored and versioned is unchanged.
 */
notesRouter.post('/visit-notes/:id/amend', ...requireClinicalWrite, async (req, res) => {
  const parsed = amendBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { body, amendReason, durationMin } = parsed.data;

  const author = await sessionAuthor(req);
  if ('error' in author) return res.status(403).json({ error: author.error, code: 'no_provider_identity' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.visitNote.findUnique({
        where: { id: req.params.id },
        include: { amendedBy: { select: { id: true } } },
      });
      if (!target) return { status: 404 as const, error: 'Unknown note.' };

      // The signer is the author of the chain's ORIGINAL — what was first written and signed.
      let original = target;
      for (let hops = 0; original.amendsId && hops < 500; hops++) {
        const prev = await tx.visitNote.findUnique({ where: { id: original.amendsId }, include: { amendedBy: { select: { id: true } } } });
        if (!prev) break;
        original = prev;
      }
      if (!isSigner(original, { id: req.auth!.account.id, staffId: req.auth!.account.staffId })) {
        return { status: 403 as const, error: 'Only the provider who signed this note can amend it. You can add an addendum to it instead.' };
      }

      // amendsId is @unique, so this would fail at the database anyway — catch
      // it here to explain rather than surface a constraint violation.
      if (target.amendedBy) {
        return {
          status: 409 as const,
          error: 'That version has already been amended. Amend the current version instead.',
        };
      }

      const note = await tx.visitNote.create({
        data: {
          bookingId: target.bookingId,
          authorId: author.staffId,
          authorAccountId: req.auth!.account.id,
          authorRole: author.role,
          kind: target.kind,
          body,
          durationMin: target.kind === 'GENERAL' ? (durationMin ?? target.durationMin) : null,
          amendsId: target.id,
          amendReason,
        },
        include: NOTE_INCLUDE,
      });
      return { status: 201 as const, note };
    });

    if ('error' in result && result.status === 403) {
      audit.record({ action: 'ACCESS_DENIED', resourceType: 'visit_note', resourceId: req.params.id ?? null, success: false, meta: { code: 'not_author', method: 'POST' } });
      return res.status(403).json({ error: result.error, code: 'not_author', canAddend: true });
    }
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({
      id: result.note.id,
      amends: req.params.id,
      kind: result.note.kind,
      body: result.note.body,
      durationMin: result.note.durationMin,
      author: result.note.author,
      createdAt: result.note.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error('notes_amend_failed', err);
    return res.status(500).json({ error: 'Could not amend that note.' });
  }
});

const addendumBody = z.object({
  body: z.string().trim().min(1, 'An addendum cannot be empty.').max(20000),
}).strict();

/**
 * POST /api/visit-notes/:id/addendum — add to a note that is not yours to amend.
 *
 * Any account with a provider role (the signer included) may add one; an administrator may not. The addendum
 * is a new entry attributed to the signed-in provider and the role they used, linked to the note, and it
 * never changes: nothing edits or deletes one, and the database refuses to. The note it is linked to is not
 * touched at all.
 */
notesRouter.post('/visit-notes/:id/addendum', ...requireClinicalWrite, async (req, res) => {
  const parsed = addendumBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.', code: 'bad_request' });
  const author = await sessionAuthor(req);
  if ('error' in author) return res.status(403).json({ error: author.error, code: 'no_provider_identity' });

  const row = await staffTransaction(async (tx, rec) => {
    const target = await tx.visitNote.findUnique({ where: { id: req.params.id ?? '' }, select: { id: true, bookingId: true } });
    if (!target) return null;
    const made = await tx.noteAddendum.create({
      data: {
        bookingId: target.bookingId, noteId: target.id, body: parsed.data.body,
        authorAccountId: req.auth!.account.id, authorStaffId: author.staffId, authorRole: author.role, createdAt: now(),
      },
    });
    await rec({ action: 'CREATE', resourceType: 'note_addendum', resourceId: made.id, meta: { note: target.id, role: author.role } });
    return made;
  });
  if (!row) return res.status(404).json({ error: 'Unknown note.', code: 'not_found' });
  res.status(201).json({ addendum: { id: row.id, noteId: row.noteId, createdAt: row.createdAt.toISOString() } });
});

/** GET /api/bookings/:id/notes — current notes for one visit, with history. */
notesRouter.get('/bookings/:id/notes', requireRole(), async (req, res) => {
  const booking = await prisma.booking.findUnique({
    where: { id: req.params.id },
    select: { id: true, patientNote: true },
  });
  if (!booking) return res.status(404).json({ error: 'Unknown booking.' });

  const rows = await prisma.visitNote.findMany({
    where: { bookingId: booking.id },
    include: NOTE_INCLUDE,
    orderBy: { createdAt: 'asc' },
  });

  // Minimum necessary: front desk is told notes exist, not what they say.
  // (patientNote is what the PATIENT wrote when booking — not clinical.)
  if (!canReadNotes(req)) {
    return res.json({ bookingId: booking.id, patientNote: booking.patientNote, notes: [], noteCount: rows.length, restricted: true });
  }
  res.json({
    bookingId: booking.id,
    patientNote: booking.patientNote,
    notes: resolveNoteChains(rows as RawNote[]),
    addenda: await loadAddenda(booking.id),
  });
});

/**
 * GET /api/patients/:id/history
 *
 * The compiled record: every visit for one patient in chronological order,
 * each with what the patient said at booking and what the provider wrote
 * afterwards. This is the shape an EHR export would be built from.
 */
notesRouter.get('/patients/:id/history', requireRole(), async (req, res) => {
  const patient = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, email: true, phone: true, createdAt: true },
  });
  if (!patient) return res.status(404).json({ error: 'Unknown patient.' });

  const bookings = await prisma.booking.findMany({
    where: {
      userId: patient.id,
      // Holds and declined requests are not visits and do not belong in a
      // clinical history.
      status: { in: ['CONFIRMED', 'CANCELLED'] },
    },
    include: {
      service: { select: { name: true, category: true } },
      resource: { select: { name: true } },
      staff: { select: { id: true, name: true, role: true } },
      visitNotes: { include: NOTE_INCLUDE, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { startTime: 'asc' },
  });

  // This response carries clinical note text for providers and admins, so it is a read of clinical
  // notes as well as of the contact record the route's access audit covers.
  if (canReadNotes(req)) audit.read('visit_note', patient.id, { scope: 'patient_history', visits: bookings.length });
  res.json({
    patient,
    visitCount: bookings.length,
    visits: bookings.map((b) => ({
      bookingId: b.id,
      status: b.status,
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      service: b.service.name,
      category: b.service.category,
      subOption: b.subOption,
      resource: b.resource.name,
      provider: b.staff,
      patientNote: b.patientNote,
      notes: canReadNotes(req) ? resolveNoteChains(b.visitNotes as RawNote[]) : [],
      noteCount: b.visitNotes.length,
    })),
    ...(canReadNotes(req) ? {} : { restricted: true }),
  });
});

const searchBody = z.object({ email: z.string().trim().min(3).max(254) }).strict();

/**
 * POST /api/patients/search — find a patient before pulling their history.
 *
 * POST with a JSON body rather than the GET ?email= this replaces: an email
 * address is PHI, and a query string is written to access logs, proxy logs and
 * browser history. Request bodies are not.
 */
notesRouter.post('/patients/search', requireRole(), async (req, res) => {
  const parsed = searchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'An email is required.' });

  const patients = await prisma.user.findMany({
    where: { email: { equals: parsed.data.email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true, phone: true, _count: { select: { bookings: true } } },
    take: 25,
  });

  res.json({
    patients: patients.map((p) => ({
      id: p.id, name: p.name, email: p.email, phone: p.phone, bookingCount: p._count.bookings,
    })),
  });
});
