/**
 * The ONLY place the application writes logs.
 *
 * Rule from the platform brief: no PHI in application logs, error messages or
 * URLs. This enforces it structurally rather than by hoping each call site is
 * careful — a handler passes an error object and gets back log output that
 * contains only:
 *
 *     • the error's CLASS
 *     • a message with PHI-bearing fields stripped
 *     • an error CODE where there is one
 *     • the request ID
 *
 * Why not just log `err.message`? Because the messages that matter most leak
 * most. A Prisma validation error serialises the ENTIRE query arguments into
 * its message — a failed patient insert would write name, email and phone to
 * stdout. So for Prisma errors the message is never logged at all; for Zod, only
 * the failing field paths; for everything else, the message passes through a
 * redactor. The redactor is a best-effort second line of defence, not a
 * guarantee — which is exactly why the high-risk classes never reach it.
 *
 * `npm run lint:logs` fails the build if `console.*` appears anywhere else in
 * src/, so a stray `console.error('x', err)` cannot reintroduce the problem.
 */

import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { currentContext } from './requestContext.js';

type Level = 'info' | 'warn' | 'error';

export interface SafeError {
  errorClass: string;
  message: string;
  code?: string;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_DIGITS = /\+?\d[\d\s().-]{6,}\d/g; // phone numbers, DOBs written with digits, ids
const QUOTED = /(["'`])(?:(?!\1).){3,}\1/g;   // quoted values are how drivers echo user data

/** Strip anything that could be a person's data from a free-text message. */
export function redact(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(QUOTED, '[value]')
    .replace(LONG_DIGITS, '[number]')
    .slice(0, 200);
}

/**
 * Reduce any thrown value to something safe to write down.
 * Exported so tests can assert on exactly what would be logged.
 */
export function sanitizeError(err: unknown): SafeError {
  if (err instanceof Prisma.PrismaClientValidationError) {
    // Message embeds the full query arguments. Never log it.
    return { errorClass: 'PrismaClientValidationError', message: 'Query validation failed.' };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // `code` (P2002 …) and the NAMES of the model/columns involved are safe;
    // `meta` can also carry values on some codes, so only whitelist two keys.
    const meta = (err.meta ?? {}) as Record<string, unknown>;
    const parts: string[] = [`Prisma ${err.code}`];
    if (typeof meta.modelName === 'string') parts.push(`model=${meta.modelName}`);
    if (Array.isArray(meta.target)) parts.push(`fields=${meta.target.filter((t) => typeof t === 'string').join(',')}`);
    return { errorClass: 'PrismaClientKnownRequestError', message: parts.join(' '), code: err.code };
  }
  if (
    err instanceof Prisma.PrismaClientInitializationError
    || err instanceof Prisma.PrismaClientRustPanicError
    || err instanceof Prisma.PrismaClientUnknownRequestError
  ) {
    // These can embed connection details or the failing query.
    return { errorClass: err.constructor.name, message: 'Database client error.' };
  }
  if (err instanceof ZodError) {
    const paths = err.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { errorClass: 'ZodError', message: `Validation failed at: ${paths}` };
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      errorClass: err.constructor?.name || err.name || 'Error',
      message: redact(err.message),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { errorClass: typeof err, message: 'Non-error value thrown.' };
}

function emit(level: Level, event: string, fields: Record<string, unknown>): void {
  const ctx = currentContext();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    requestId: ctx?.requestId,
    ...fields,
  });
  // eslint-disable-next-line no-console -- the single sanctioned sink
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const logger = {
  /** `fields` must be opaque ids / counts / enum names. Never a person's data. */
  info(event: string, fields: Record<string, unknown> = {}): void {
    emit('info', event, fields);
  },
  warn(event: string, fields: Record<string, unknown> = {}): void {
    emit('warn', event, fields);
  },
  /** Pass the caught value straight in; it is sanitised here. */
  error(event: string, err: unknown, fields: Record<string, unknown> = {}): void {
    emit('error', event, { ...fields, ...sanitizeError(err) });
  },
};
