/**
 * Clinical visit notes and patient history.
 *
 * Every route here returns or accepts PHI, so all of them are token-gated.
 * See spec §7.5 — the shared token is a stopgap, and these endpoints are the
 * reason it needs replacing with real staff accounts.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { resolveNoteChains, type RawNote } from '../lib/notes.js';

export const notesRouter = Router();

const NOTE_INCLUDE = {
  author: { select: { id: true, name: true, role: true } },
} as const;

const createBody = z.object({
  // Which provider is writing. Required — an unattributed clinical note is not
  // a valid record. Once staff logins exist this comes from the session
  // instead of the request body.
  authorId: z.string().uuid('authorId must be a staff UUID.'),
  kind: z.enum(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL']).optional(),
  body: z.string().trim().min(1, 'A note cannot be empty.').max(20000),
}).strict();

/** POST /api/bookings/:id/notes — add a clinical note to a visit. */
notesRouter.post('/bookings/:id/notes', requireFrontDesk, async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { authorId, kind, body } = parsed.data;

  const [booking, author] = await Promise.all([
    prisma.booking.findUnique({ where: { id: req.params.id } }),
    prisma.staff.findUnique({ where: { id: authorId } }),
  ]);
  if (!booking) return res.status(404).json({ error: 'Unknown booking.' });
  if (!author) return res.status(400).json({ error: 'Unknown author — authorId must be a staff member.' });

  // A note about a visit that never happened is almost always a mis-click.
  if (booking.status === 'HOLD' || booking.status === 'PENDING_REVIEW') {
    return res.status(409).json({
      error: `Cannot add a clinical note to a ${booking.status} booking — confirm the visit first.`,
    });
  }

  const note = await prisma.visitNote.create({
    data: { bookingId: booking.id, authorId, kind: kind ?? 'GENERAL', body },
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
  authorId: z.string().uuid('authorId must be a staff UUID.'),
  body: z.string().trim().min(1, 'An amended note cannot be empty.').max(20000),
  amendReason: z.string().trim().min(1, 'An amendment must say why.').max(500),
}).strict();

/**
 * POST /api/visit-notes/:id/amend — supersede a note.
 *
 * Deliberately POST-and-insert rather than PATCH-and-update: the original text
 * is preserved verbatim. There is no endpoint that mutates or deletes a note.
 */
notesRouter.post('/visit-notes/:id/amend', requireFrontDesk, async (req, res) => {
  const parsed = amendBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid body.' });
  }
  const { authorId, body, amendReason } = parsed.data;

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

      const author = await tx.staff.findUnique({ where: { id: authorId } });
      if (!author) return { status: 400 as const, error: 'Unknown author.' };

      const note = await tx.visitNote.create({
        data: {
          bookingId: target.bookingId,
          authorId,
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
    console.error('[notes] amend failed', err);
    return res.status(500).json({ error: 'Could not amend that note.' });
  }
});

/** GET /api/bookings/:id/notes — current notes for one visit, with history. */
notesRouter.get('/bookings/:id/notes', requireFrontDesk, async (req, res) => {
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
notesRouter.get('/patients/:id/history', requireFrontDesk, async (req, res) => {
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
      notes: resolveNoteChains(b.visitNotes as RawNote[]),
    })),
  });
});

/** GET /api/patients?email=… — find a patient before pulling their history. */
notesRouter.get('/patients', requireFrontDesk, async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
  if (!email) return res.status(400).json({ error: 'An email query parameter is required.' });

  const patients = await prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, name: true, email: true, phone: true, _count: { select: { bookings: true } } },
    take: 25,
  });

  res.json({
    patients: patients.map((p) => ({
      id: p.id, name: p.name, email: p.email, phone: p.phone, bookingCount: p._count.bookings,
    })),
  });
});
