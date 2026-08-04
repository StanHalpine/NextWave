/**
 * Amendment-chain resolution.
 *
 * A clinical note is never updated in place. Correcting one inserts a new row
 * whose `amendsId` points at the row it replaces, so the chain
 *
 *     original ◀── amendment ◀── amendment-of-amendment
 *
 * preserves every version. The *effective* note is the tail of the chain: the
 * row that nothing else amends. Everything behind it is history.
 */

import type { NoteKind } from '@prisma/client';

export interface RawNote {
  id: string;
  bookingId: string;
  authorId: string;
  kind: NoteKind;
  body: string;
  createdAt: Date;
  amendsId: string | null;
  amendReason: string | null;
  author: { id: string; name: string; role: string };
}

export interface ResolvedNote {
  id: string;
  kind: NoteKind;
  body: string;
  author: { id: string; name: string; role: string };
  createdAt: string;
  /** True when this row replaced an earlier one. */
  amended: boolean;
  /** Oldest → newest, excluding the current row. Empty on an untouched note. */
  history: Array<{
    id: string;
    body: string;
    author: { id: string; name: string; role: string };
    createdAt: string;
    amendReason: string | null;
  }>;
}

/**
 * Collapse raw rows into current notes plus their superseded history.
 * Ordered oldest-first by the date the ORIGINAL was written, so a note that
 * was later corrected keeps its place in the clinical timeline rather than
 * jumping to the end.
 */
export function resolveNoteChains(rows: RawNote[]): ResolvedNote[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const superseded = new Set(rows.filter((r) => r.amendsId).map((r) => r.amendsId!));

  const current = rows.filter((r) => !superseded.has(r.id));

  const resolved = current.map((tail) => {
    // Walk back to the original, collecting each superseded version.
    const history: ResolvedNote['history'] = [];
    let cursor = tail.amendsId ? byId.get(tail.amendsId) : undefined;
    const guard = new Set<string>([tail.id]);

    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      history.push({
        id: cursor.id,
        body: cursor.body,
        author: cursor.author,
        createdAt: cursor.createdAt.toISOString(),
        // The reason lives on the row that DID the amending, so read it from
        // the newer neighbour rather than from the row being replaced.
        amendReason: null,
      });
      cursor = cursor.amendsId ? byId.get(cursor.amendsId) : undefined;
    }

    // Attach each amendment's stated reason to the version it replaced.
    const chain = [tail, ...history.map((h) => byId.get(h.id)!)];
    history.forEach((h, i) => {
      h.amendReason = chain[i]?.amendReason ?? null;
    });

    history.reverse(); // oldest first

    return {
      id: tail.id,
      kind: tail.kind,
      body: tail.body,
      author: tail.author,
      createdAt: tail.createdAt.toISOString(),
      amended: history.length > 0,
      history,
      _sortKey: (history[0]?.createdAt ?? tail.createdAt.toISOString()),
    };
  });

  resolved.sort((a, b) => a._sortKey.localeCompare(b._sortKey));
  return resolved.map(({ _sortKey, ...n }) => n);
}
