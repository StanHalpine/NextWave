/**
 * Per-request context carried through async calls.
 *
 * Exists so code deep in the stack — the Prisma audit extension, the logger —
 * can know WHO is acting and WHICH request it belongs to without every function
 * in between having to pass them along. In particular it is what lets the
 * existing booking routes be audited with an actor without being edited.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface AuditEntry {
  actorAccountId: string | null;
  actorRoles: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  success: boolean;
  requestId: string;
  ipAddress: string | null;
  /** Counts and field NAMES only — never a value. */
  meta?: Record<string, unknown>;
}

export interface RequestContext {
  requestId: string;
  ip: string | null;
  /** Set once a session has been resolved. Null = the anonymous public widget. */
  actor: { accountId: string; roles: string[] } | null;
  /** Set for background work (the hold sweeper, scheduled jobs). */
  system: string | null;
  /**
   * Audit entries produced during this request, flushed in ONE insert after the
   * response is sent. Deliberately not written inline: an audit insert made
   * from inside a Prisma interactive transaction needs a second pooled
   * connection, and under concurrent load (the booking race) every connection
   * can be held by a transaction waiting on a row lock held by one that is
   * waiting for a connection. See lib/audit.ts.
   */
  auditBuffer: AuditEntry[];
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newContext(init: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: init.requestId ?? randomUUID(),
    ip: init.ip ?? null,
    actor: init.actor ?? null,
    system: init.system ?? null,
    auditBuffer: [],
  };
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}
