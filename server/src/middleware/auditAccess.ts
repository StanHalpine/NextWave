import type { NextFunction, Request, Response } from 'express';
import { audit } from '../lib/audit.js';
import { currentContext } from '../lib/requestContext.js';

interface Options {
  /** Opaque id of the record being read; omit for list reads. */
  id?: (req: Request) => string | null;
  /** Distinguishes lists that should be deduplicated separately. */
  listKey?: string;
  /** Extra non-PHI fields for the audit row. */
  meta?: (req: Request) => Record<string, unknown>;
  /** Treat a successful non-GET (a POST search) as a read of PHI. */
  read?: boolean;
  /**
   * Log every list read instead of one per five minutes. Use where each call is
   * a distinct disclosure (a patient search for a different person), not a
   * screen refreshing itself.
   */
  everyTime?: boolean;
}

/**
 * Route-level access audit, mounted from index.ts so the handler it covers does
 * not need editing. Decides at 'finish' from the final status code:
 *
 *   GET  2xx            → READ        (the PHI was disclosed)
 *   401 / 403           → ACCESS_DENIED (success=false)
 *   write 409 / 410     → the attempt, success=false — a refused booking writes
 *                         nothing to the database, so only here is it visible
 *
 * Successful writes are NOT recorded here — the Prisma extension records those
 * with the row id, and doing both would double-count.
 */
export function auditAccess(resourceType: string, opts: Options = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = currentContext();
    res.on('finish', () => {
      if (!ctx) return;
      const status = res.statusCode;
      const id = opts.id ? opts.id(req) : null;
      const extra = opts.meta ? opts.meta(req) : {};

      if (status === 401 || status === 403) {
        audit.record({ action: 'ACCESS_DENIED', resourceType, resourceId: id, success: false, meta: { status, method: req.method, ...extra } }, ctx);
        return;
      }
      if ((req.method === 'GET' || opts.read) && status >= 200 && status < 300) {
        if (opts.everyTime) audit.record({ action: 'READ', resourceType, resourceId: id, meta: { ...extra } }, ctx);
        else audit.read(resourceType, id, { ...extra }, opts.listKey, ctx);
        return;
      }
      if (req.method !== 'GET' && !opts.read && (status === 409 || status === 410)) {
        const action = req.method === 'POST' ? 'CREATE' : req.method === 'DELETE' ? 'DELETE' : 'UPDATE';
        audit.record({ action, resourceType, resourceId: id, success: false, meta: { status, ...extra } }, ctx);
      }
    });
    next();
  };
}
