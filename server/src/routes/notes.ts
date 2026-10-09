/**
 * Clinical visit notes and patient history.
 *
 * Every route here returns or accepts PHI, so all of them require a signed-in
 * staff account.
 *
 *   WRITE a note      provider roles only. The author is the signed-in account's
 *                     linked provider record — taken from the SESSION, never the
 *                     request body, so authorship is proven rather than claimed.
 *   READ note text    providers and admins. Front desk sees THAT notes exist
 *                     (a count) but not what they say — minimum necessary.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { hasRole, requireRole } from '../middleware/session.js';
import { PROVIDER_ROLES } from '../lib/sessions.js';
import { resolveNoteChains, type RawNote } from '../lib/notes.js';
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

const createBody = z.object({
  kind: z.enum(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL']).optional(),
  body: z.string().trim().min(1, 'A note cannot be empty.').max(20000),
}).strict();

/** POST /api/bookings/:id/notes — add a clinical note to a visit. */
notesRouter.post('/bookings/:id/notes', requireRole(...PROVIDER_ROLES), async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { kind, body } = parsed.data;

  const author = await sessionAuthor(req);
  if ('error' in author) return res.status(403).json({ error: author.error, code: 'no_provider_identity' });

  const booking = await prisma.booking.findUnique({ where: { id: req.params.id } });
  if (!booking) return res.status(404).json({ error: 'Unknown booking.' });

  // A note about a visit that never happened is almost always a mis-click.
  if (booking.status === 'HOLD' || booking.status === 'PENDING_REVIEW') {
    return res.status(409).json({
      error: `Cannot add a clinical note to a ${booking.status} booking — confirm the visit first.`,
    });
  }

  const note = await prisma.visitNote.create({
    data: {
      bookingId: booking.id, authorId: author.staffId, kind: kind ?? 'GENERAL', body,
      authorAccountId: req.auth!.account.id, authorRole: author.role,
    },
    include: NOTE_INCLUDE,
  });

  res.status(201).json({
    id: note.id,
    kind: note.kind,
    body: note.body,
    author: note.author,
    createdAt: note.createdAt.toISOString(),
    amended: false,
    history: [],
  });
});

const amendBody = z.object({
  body: z.string().trim().min(1, 'An amended note cannot be empty.').max(20000),
  amendReason: z.string().trim().min(1, 'An amendment must say why.').max(500),
}).strict();

/**
 * POST /api/visit-notes/:id/amend — supersede a note.
 *
 * Deliberately POST-and-insert rather than PATCH-and-update: the original text
 * is preserved verbatim. There is no endpoint that mutates or deletes a note.
 */
notesRouter.post('/visit-notes/:id/amend', requireRole(...PROVIDER_ROLES), async (req, res) => {
  const parsed = amendBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { body, amendReason } = parsed.data;

  const author = await sessionAuthor(req);
  if ('error' in author) return res.status(403).json({ error: author.error, code: 'no_provider_identity' });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.visitNote.findUnique({
        where: { id: req.params.id },
        include: { amendedBy: { select: { id: true } } },
      });
      if (!target) return { status: 404 as const, error: 'Unknown note.' };

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
          amendsId: target.id,
          amendReason,
        },
        include: NOTE_INCLUDE,
      });
      return { status: 201 as const, note };
    });

    if ('error' in result) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({
      id: result.note.id,
      amends: req.params.id,
      kind: result.note.kind,
      body: result.note.body,
      author: result.note.author,
      createdAt: result.note.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error('notes_amend_failed', err);
    return res.status(500).json({ error: 'Could not amend that note.' });
  }
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
