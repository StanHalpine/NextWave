import type { NextFunction, Request, Response } from 'express';
import type { Account, AccountRole, Session } from '@prisma/client';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { currentContext } from '../lib/requestContext.js';
import {
  computeNeeds, idleSecondsRemaining, resolveSession, SESSION_COOKIE, touchSession,
  type Need, type SessionStatus,
} from '../lib/sessions.js';

export interface AuthContext {
  session: Session;
  account: Account;
  needs: Need[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Why a presented session was refused (idle, expired, …). */
      authFailure?: SessionStatus | 'none';
    }
  }
}

export function cookieOptions() {
  return {
    httpOnly: true,
    // Strict: the cookie is not sent on any cross-site request, which is the
    // primary CSRF defence. The x-csrf-token header below is the second.
    sameSite: 'strict' as const,
    secure: config.isProduction || config.appBaseUrl.startsWith('https://'),
    path: '/',
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves the session cookie, if any, onto req.auth. Never rejects — public
 * routes (the anonymous booking widget) pass straight through. Enforcement is
 * the guards' job.
 */
export async function loadSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return next();

  try {
    const now = new Date();
    const resolved = await resolveSession(token, now);
    if (resolved.status !== 'ok') {
      req.authFailure = resolved.status;
      if (resolved.status !== 'none') res.clearCookie(SESSION_COOKIE, cookieOptions());
      return next();
    }

    const { session, account } = resolved;
    // Only user-initiated requests slide the idle clock (see lib/sessions.ts).
    const isPing = req.method === 'POST' && req.path === '/api/auth/ping';
    const slides = isPing || !SAFE_METHODS.has(req.method);
    const effective = slides ? { ...session, lastActivityAt: await touchSession(session, now) } : session;

    req.auth = { session: effective, account, needs: computeNeeds(account, effective) };
    const ctx = currentContext();
    if (ctx) ctx.actor = { accountId: account.id, roles: account.roles };
  } catch {
    // A database hiccup while resolving must not turn into an open door — leave
    // req.auth unset so every guard rejects.
  }
  next();
}

function deny(req: Request, res: Response, status: 401 | 403, code: string, error: string, extra: object = {}) {
  if (status === 403) {
    audit.record({
      action: 'ACCESS_DENIED',
      resourceType: 'route',
      success: false,
      meta: { method: req.method, path: req.originalUrl.split('?')[0], code },
    });
  }
  return res.status(status).json({ error, code, ...extra });
}

/**
 * Require a signed-in session — optionally with certain roles — that has
 * finished every outstanding step (password change, MFA). State-changing
 * requests must also carry the session's CSRF token.
 *
 *   requireRole()                        any fully signed-in staff member
 *   requireRole('ADMIN')                 admins
 *   requireRole('FRONT_DESK', 'ADMIN')   either
 */
export function requireRole(...roles: AccountRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const a = req.auth;
    if (!a) {
      const code = req.authFailure === 'idle' ? 'idle_timeout' : req.authFailure === 'expired' ? 'session_expired' : 'unauthenticated';
      const msg = code === 'idle_timeout' ? 'You were signed out after 15 minutes of inactivity.' : 'Sign in required.';
      return deny(req, res, 401, code, msg);
    }
    if (a.needs.length) return deny(req, res, 403, 'step_up_required', 'Finish signing in first.', { needs: a.needs });
    if (!csrfOk(req, a)) return deny(req, res, 403, 'csrf', 'Missing or invalid CSRF token.');
    if (roles.length && !roles.some((r) => a.account.roles.includes(r))) {
      return deny(req, res, 403, 'forbidden', 'Your role does not allow that.');
    }
    next();
  };
}

/**
 * Like requireRole but for the sign-in flow itself (change password, MFA
 * enrolment/verification): needs a session, tolerates outstanding steps.
 */
export function requireSession(req: Request, res: Response, next: NextFunction) {
  const a = req.auth;
  if (!a) {
    const code = req.authFailure === 'idle' ? 'idle_timeout' : req.authFailure === 'expired' ? 'session_expired' : 'unauthenticated';
    return deny(req, res, 401, code, code === 'idle_timeout' ? 'You were signed out after 15 minutes of inactivity.' : 'Sign in required.');
  }
  if (!csrfOk(req, a)) return deny(req, res, 403, 'csrf', 'Missing or invalid CSRF token.');
  next();
}

function csrfOk(req: Request, a: AuthContext): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const header = req.get('x-csrf-token') ?? '';
  return header.length > 0 && safeEqual(header, a.session.csrfToken);
}

export function hasRole(req: Request, ...roles: AccountRole[]): boolean {
  return !!req.auth && roles.some((r) => req.auth!.account.roles.includes(r));
}

export function sessionState(a: AuthContext, now = new Date()) {
  return {
    account: {
      id: a.account.id,
      email: a.account.email,
      displayName: a.account.displayName,
      roles: a.account.roles,
      staffId: a.account.staffId,
      mfaEnabled: !!a.account.mfaEnabledAt,
    },
    needs: a.needs,
    csrfToken: a.session.csrfToken,
    idleSecondsRemaining: idleSecondsRemaining(a.session, now),
  };
}
