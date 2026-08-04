import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Shared-secret gate for front desk endpoints.
 *
 * This is deliberately the simplest thing that keeps the queue off the public
 * internet. It is NOT per-user auth: there is no staff login, no audit trail of
 * who approved what, and one leaked token exposes every patient record behind
 * it. Replace with real staff accounts before this handles live PHI.
 */
export function requireFrontDesk(req: Request, res: Response, next: NextFunction) {
  const expected = config.frontDeskToken;
  if (!expected) {
    return res.status(503).json({ error: 'FRONT_DESK_TOKEN is not configured on the server.' });
  }

  const header = req.get('x-front-desk-token') ?? '';
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Front desk authentication required.' });
  }
  next();
}
