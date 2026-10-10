import type { Response } from 'express';
import { SchedulingError } from '../lib/scheduling.js';
import { DocError } from '../lib/documentation.js';

/**
 * Turn a scheduling refusal into its HTTP response; return false for anything else
 * so the caller can rethrow it to the error handler (which logs it safely).
 */
export function sendSchedulingError(res: Response, err: unknown): boolean {
  if (!(err instanceof SchedulingError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  return true;
}

/** As above, plus the clinical-documentation refusals (403 wrong role, 409 stale draft, 503 scribe off, …). */
export function sendKnownError(res: Response, err: unknown): boolean {
  if (err instanceof DocError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return true;
  }
  return sendSchedulingError(res, err);
}
