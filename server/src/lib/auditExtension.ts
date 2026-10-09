/**
 * Prisma client extension that audits WRITES to patient-record models.
 *
 * Attached once, in lib/prisma.ts, so every existing call site — including the
 * booking and hold routes, which this change deliberately does not edit — is
 * covered, with the acting account taken from the request context.
 *
 * What it records: the model's resource type, the action, the record id, and
 * the NAMES of the fields touched. Never a value.
 *
 * What it cannot see: the four hand-written `SELECT … FOR UPDATE` locking
 * statements. Those are lock-only (they read opaque ids from Resource / Staff
 * and write nothing), so there is no PHI activity to record; the writes that
 * happen inside those same transactions go through the client and ARE captured.
 * What no client-level hook can observe is an attempt REFUSED before any write
 * (a 409 slot-taken, a 410 expired hold) — middleware/auditAccess.ts covers
 * those at the route level.
 */

import { Prisma } from '@prisma/client';
import { audit } from './audit.js';

/** Prisma model → audit resource type. */
const AUDITED: Record<string, string> = {
  Booking: 'appointment',
  User: 'patient',
  VisitNote: 'visit_note',
  Encounter: 'encounter',
};

const MAX_PER_BULK = 200;

type Where = Record<string, unknown> | undefined;

/** Ids that a `where` names explicitly, without querying. Null if not determinable. */
function idsFromWhere(where: Where): string[] | null {
  const id = where?.id;
  if (typeof id === 'string') return [id];
  if (id && typeof id === 'object') {
    const o = id as { equals?: unknown; in?: unknown };
    if (typeof o.equals === 'string') return [o.equals];
    if (Array.isArray(o.in)) return o.in.filter((x): x is string => typeof x === 'string');
  }
  return null;
}

function fieldNames(data: unknown): string[] | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return Object.keys(data as object);
}

export const auditExtension = Prisma.defineExtension({
  name: 'audit',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const resourceType = AUDITED[model];
        if (!resourceType) return query(args);

        const a = args as Record<string, unknown>;
        const result = (await query(args)) as unknown;
        const r = result as { id?: string; count?: number } | null;

        switch (operation) {
          case 'create':
            audit.record({ action: 'CREATE', resourceType, resourceId: r?.id ?? null, meta: { fields: fieldNames(a.data) } });
            break;

          case 'createMany':
          case 'createManyAndReturn': {
            const rows = Array.isArray(result) ? (result as Array<{ id?: string }>) : null;
            if (rows && rows.length <= MAX_PER_BULK) {
              for (const row of rows) audit.record({ action: 'CREATE', resourceType, resourceId: row.id ?? null });
            } else {
              audit.record({ action: 'CREATE', resourceType, meta: { bulk: true, count: rows?.length ?? r?.count ?? 0 } });
            }
            break;
          }

          case 'update':
            audit.record({ action: 'UPDATE', resourceType, resourceId: r?.id ?? idsFromWhere(a.where as Where)?.[0] ?? null, meta: { fields: fieldNames(a.data) } });
            break;

          case 'upsert':
            audit.record({ action: 'UPDATE', resourceType, resourceId: r?.id ?? null, meta: { upsert: true, fields: fieldNames(a.update) } });
            break;

          case 'delete':
            audit.record({ action: 'DELETE', resourceType, resourceId: r?.id ?? idsFromWhere(a.where as Where)?.[0] ?? null });
            break;

          case 'updateMany':
          case 'deleteMany': {
            const action = operation === 'updateMany' ? 'UPDATE' : 'DELETE';
            const count = r?.count ?? 0;
            if (count === 0) break;
            const ids = idsFromWhere(a.where as Where);
            // Only per-id when the where-clause named the ids AND the database
            // touched exactly that many; otherwise some filter excluded rows and
            // naming them all would over-report.
            if (ids && ids.length === count && ids.length <= MAX_PER_BULK) {
              for (const id of ids) audit.record({ action, resourceType, resourceId: id, meta: operation === 'updateMany' ? { fields: fieldNames(a.data) } : undefined });
            } else {
              audit.record({ action, resourceType, meta: { bulk: true, count } });
            }
            break;
          }

          default:
            break; // reads are not captured here — see lib/audit.ts
        }
        return result;
      },
    },
  },
});
