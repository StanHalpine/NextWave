/**
 * Addenda: what a provider other than a note's signer adds to it.
 *
 * Only the provider who signed a note may AMEND it (the existing model: a new version replaces the old and
 * both are kept). Anyone else with a provider role may add an ADDENDUM instead: a new signed entry linked to
 * the note, which never changes and changes nothing it is linked to (the database refuses to edit or delete
 * it). An addendum is linked to one version of a note and follows that note through later amendments.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { isSigner, type RawNote, type ResolvedNote } from './notes.js';

export interface AddendumView {
  id: string;
  noteId: string;
  body: string;
  author: { name: string; role: string };
  createdAt: string;
}

type Db = Pick<Prisma.TransactionClient, 'noteAddendum' | 'staff'>;

export async function loadAddenda(bookingId: string, db: Db = prisma as unknown as Db): Promise<AddendumView[]> {
  const rows = await db.noteAddendum.findMany({ where: { bookingId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  if (rows.length === 0) return [];
  const staff = new Map((await db.staff.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorStaffId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id, noteId: r.noteId, body: r.body, author: { name: staff.get(r.authorStaffId) ?? 'A provider', role: r.authorRole }, createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Give each resolved note its addenda (those written against ANY version in its chain) and whether the viewer
 * may amend it (is its signer). Pure, so it can be tested without a database.
 */
export function withAddenda(
  notes: ResolvedNote[],
  raw: Array<Pick<RawNote, 'id' | 'authorId'> & { authorAccountId: string | null }>,
  addenda: AddendumView[],
  viewer: { id: string; staffId: string | null } | null,
): Array<ResolvedNote & { canAmend: boolean; addenda: AddendumView[] }> {
  const byId = new Map(raw.map((r) => [r.id, r]));
  return notes.map((n) => {
    const chain = new Set([n.id, ...n.history.map((h) => h.id)]);
    const original = byId.get(n.history[0]?.id ?? n.id);
    return {
      ...n,
      canAmend: !!viewer && !!original && isSigner(original, viewer),
      addenda: addenda.filter((a) => chain.has(a.noteId)),
    };
  });
}
