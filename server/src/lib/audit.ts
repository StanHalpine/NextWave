/**
 * Audit trail.
 *
 * Every create / read / update / delete of patient, appointment, clinical-note
 * and credit data writes an AuditLog row: who, what action, which record, when.
 * Never a value — a row says "account X read appointment Y", not what was in it.
 *
 * ── Where entries come from ────────────────────────────────────────────────
 *  1. WRITES:  lib/auditExtension.ts intercepts them at the Prisma client, so
 *              the existing booking routes are audited without being edited.
 *  2. READS:   explicit — `auditAccess()` middleware (middleware/auditAccess.ts)
 *              or `audit.read()` in a handler. Reads cannot be captured at the
 *              client without drowning in the availability engine's occupancy
 *              queries, which return no PHI.
 *  3. REFUSED ATTEMPTS: a 409 "slot taken" or a 403 writes nothing to the
 *              database, so the client cannot see it. Route-level middleware
 *              records those as success=false.
 *  4. AUTH EVENTS: explicit calls in routes/auth.ts.
 *
 * ── Why buffered, not inline ───────────────────────────────────────────────
 * Entries are collected on the request context and flushed in a single insert
 * AFTER the response has been sent. An inline insert from inside a Prisma
 * interactive transaction needs a second pooled connection; under the booking
 * race every connection can be held by a transaction waiting on a row lock held
 * by one that is waiting for a connection. Deferring removes the possibility.
 *
 * Trade-off, stated plainly: if the process is killed in the milliseconds
 * between a commit and the flush, that entry is lost. For code that must be
 * atomic with its change (Phase 2+ endpoints), use `auditInTx()` — it inserts
 * with the transaction's own client, so the row commits or rolls back with the
 * change it describes.
 */

import type { Prisma } from '@prisma/client';
import { basePrisma } from './prismaBase.js';
import { logger } from './logger.js';
import { currentContext, newContext, runWithContext, type AuditEntry, type RequestContext } from './requestContext.js';

type Action = AuditEntry['action'];

export interface AuditInput {
  action: Action;
  resourceType: string;
  resourceId?: string | null;
  success?: boolean;
  /** Counts and field NAMES only. */
  meta?: Record<string, unknown>;
}

function toEntry(input: AuditInput, ctx: RequestContext): AuditEntry {
  return {
    actorAccountId: ctx.actor?.accountId ?? null,
    actorRoles: ctx.actor ? ctx.actor.roles.join(',') : ctx.system ? `system:${ctx.system}` : null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    success: input.success ?? true,
    requestId: ctx.requestId,
    ipAddress: ctx.ip,
    ...(input.meta ? { meta: input.meta } : {}),
  };
}

/** Repeat list-reads by one actor inside this window are logged once. */
const LIST_READ_WINDOW_MS = 5 * 60_000;
const recentListReads = new Map<string, number>();

export const audit = {
  /**
   * Queue an entry on the current request. Pass `ctxOverride` from callbacks
   * (e.g. response 'finish') that do not reliably inherit the async context.
   */
  record(input: AuditInput, ctxOverride?: RequestContext): void {
    const ctx = ctxOverride ?? currentContext();
    if (!ctx) {
      // Code running with no context at all (a script, a test) has no actor to
      // attribute and no request to flush at the end — write it straight out.
      void writeEntries([toEntry(input, newContext({ system: 'no-context' }))]);
      return;
    }
    ctx.auditBuffer.push(toEntry(input, ctx));
  },

  /**
   * Record a READ of PHI. For LIST reads (resourceId null) the same actor
   * re-reading the same list within five minutes is recorded once — a dashboard
   * that refreshes every 30 seconds would otherwise write ~2,900 rows a day per
   * open screen and bury the entries that matter. Single-record reads are never
   * deduplicated.
   */
  read(
    resourceType: string,
    resourceId: string | null = null,
    meta?: Record<string, unknown>,
    listKey?: string,
    ctxOverride?: RequestContext,
  ): void {
    const ctx = ctxOverride ?? currentContext();
    if (resourceId == null && ctx) {
      const key = `${ctx.actor?.accountId ?? 'anon'}|${resourceType}|${listKey ?? ''}`;
      const last = recentListReads.get(key) ?? 0;
      if (Date.now() - last < LIST_READ_WINDOW_MS) return;
      recentListReads.set(key, Date.now());
      if (recentListReads.size > 5000) {
        for (const [k, t] of recentListReads) if (Date.now() - t > LIST_READ_WINDOW_MS) recentListReads.delete(k);
      }
    }
    audit.record({ action: 'READ', resourceType, resourceId, ...(meta ? { meta } : {}) }, ctx);
  },

  /** Persist everything buffered on a context. Never throws. */
  async flush(ctx: RequestContext | undefined = currentContext()): Promise<void> {
    if (!ctx || ctx.auditBuffer.length === 0) return;
    const entries = ctx.auditBuffer.splice(0, ctx.auditBuffer.length);
    await writeEntries(entries);
  },
};

async function writeEntries(entries: AuditEntry[]): Promise<void> {
  try {
    await basePrisma.auditLog.createMany({
      data: entries.map((e) => ({
        actorAccountId: e.actorAccountId,
        actorRoles: e.actorRoles,
        action: e.action as never,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        success: e.success,
        requestId: e.requestId,
        ipAddress: e.ipAddress,
        meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
    });
  } catch (err) {
    // Fail LOUD, not silent: a gap in the audit trail is itself a finding. This
    // runs after the response has gone, so there is nothing to return an error to.
    logger.error('audit_flush_failed', err, { droppedEntries: entries.length });
  }
}

/**
 * Write an audit row using a transaction's own client, so it commits or rolls
 * back together with the change it describes. Use in new code that must be
 * atomic with its audit record.
 */
export async function auditInTx(tx: Prisma.TransactionClient, input: AuditInput): Promise<void> {
  const ctx = currentContext() ?? newContext({ system: 'no-context' });
  const e = toEntry(input, ctx);
  await tx.auditLog.create({
    data: {
      actorAccountId: e.actorAccountId,
      actorRoles: e.actorRoles,
      action: e.action as never,
      resourceType: e.resourceType,
      resourceId: e.resourceId,
      success: e.success,
      requestId: e.requestId,
      ipAddress: e.ipAddress,
      meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/**
 * Run background work (the hold sweeper, scheduled jobs) under a system actor
 * and flush its audit entries when it finishes.
 */
export async function runAsSystem<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ctx = newContext({ system: name });
  try {
    return await runWithContext(ctx, fn);
  } finally {
    await audit.flush(ctx);
  }
}
