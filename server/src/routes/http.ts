import type { Response } from 'express';
import { SchedulingError } from '../lib/scheduling.js';

/**
 * Turn a scheduling refusal into its HTTP response; return false for anything else
 * so the caller can rethrow it to the error handler (which logs it safely).
 */
export function sendSchedulingError(res: Response, err: unknown): boolean {
  if (!(err instanceof SchedulingError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
  return true;
}
