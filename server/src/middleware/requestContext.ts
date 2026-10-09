import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { audit } from '../lib/audit.js';
import { newContext, runWithContext } from '../lib/requestContext.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

// Accept an upstream request id (a load balancer's) only if it looks like one.
// Anything else is replaced — an attacker-supplied value must never reach the
// logs or the audit trail verbatim.
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Opens the per-request context (request id, client ip, actor, audit buffer)
 * and guarantees the buffered audit entries are written once the response has
 * gone. Flushes on 'close', which Node emits AFTER 'finish', so entries queued
 * by other 'finish' listeners (see auditAccess) are not missed.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const upstream = req.get('x-request-id');
  const requestId = upstream && SAFE_ID.test(upstream) ? upstream : randomUUID();
  const ctx = newContext({ requestId, ip: req.ip ?? null });
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.on('close', () => { void audit.flush(ctx); });
  runWithContext(ctx, next);
}
