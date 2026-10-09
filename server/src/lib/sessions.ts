/**
 * Server-side sessions.
 *
 * The browser holds an opaque random token in an httpOnly cookie; the database
 * holds only its SHA-256. Logout and idle expiry are real — the row is revoked
 * server-side, so a captured cookie stops working immediately instead of
 * remaining valid until some token expiry, which is the whole reason this is
 * not a JWT.
 *
 * ── What counts as activity ───────────────────────────────────────────────
 * The 15-minute inactivity rule is about a PERSON walking away from a screen.
 * The front desk grid refreshes itself every 30 seconds with GET requests; if
 * those counted, an unattended screen would stay signed in forever. So the
 * idle clock slides only on:
 *   • POST /api/auth/ping — sent by the client when it sees real input events
 *   • any state-changing request (POST / PUT / PATCH / DELETE) — a person
 *     did something
 * and NOT on GET requests.
 */

import type { Account, AccountRole, Session } from '@prisma/client';
import { prisma } from './prisma.js';
import { config } from '../config.js';
import { randomToken, sha256Hex } from './crypto.js';

export const SESSION_COOKIE = 'nw_session';
export const IDLE_MS = 15 * 60_000;
export const ABSOLUTE_MS = 12 * 60 * 60_000;
/** Don't write lastActivityAt more often than this — one UPDATE per click is waste. */
export const SLIDE_WRITE_THROTTLE_MS = 20_000;

export const PROVIDER_ROLES: AccountRole[] = ['PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'];

export type Need = 'change_password' | 'mfa_enroll' | 'mfa_verify';

export function requiresMfa(roles: AccountRole[]): boolean {
  return roles.some((r) => config.mfaRequiredRoles.includes(r));
}

/** Steps still outstanding before this session may use the application. */
export function computeNeeds(
  account: Pick<Account, 'roles' | 'mustChangePassword' | 'mfaEnabledAt'>,
  session: Pick<Session, 'mfaVerifiedAt'>,
): Need[] {
  const needs: Need[] = [];
  if (account.mustChangePassword) needs.push('change_password');
  if (!account.mfaEnabledAt && requiresMfa(account.roles)) needs.push('mfa_enroll');
  else if (account.mfaEnabledAt && !session.mfaVerifiedAt) needs.push('mfa_verify');
  return needs;
}

export type SessionStatus = 'ok' | 'idle' | 'expired' | 'revoked' | 'inactive';

/** Pure policy check — no I/O, so it is unit-testable against an injected clock. */
export function evaluateSession(
  session: Pick<Session, 'lastActivityAt' | 'expiresAt' | 'revokedAt'>,
  account: Pick<Account, 'active'>,
  now: Date,
): SessionStatus {
  if (session.revokedAt) return 'revoked';
  if (!account.active) return 'inactive';
  if (now >= session.expiresAt) return 'expired';
  if (now.getTime() - session.lastActivityAt.getTime() >= IDLE_MS) return 'idle';
  return 'ok';
}

export function idleSecondsRemaining(session: Pick<Session, 'lastActivityAt'>, now: Date): number {
  return Math.max(0, Math.round((IDLE_MS - (now.getTime() - session.lastActivityAt.getTime())) / 1000));
}

export async function createSession(
  accountId: string,
  opts: { ip: string | null; userAgent: string | null; mfaVerified?: boolean },
  now = new Date(),
): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const session = await prisma.session.create({
    data: {
      accountId,
      tokenHash: sha256Hex(token),
      csrfToken: randomToken(24),
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + ABSOLUTE_MS),
      mfaVerifiedAt: opts.mfaVerified ? now : null,
      ipAddress: opts.ip,
      userAgent: opts.userAgent?.slice(0, 200) ?? null,
    },
  });
  return { token, session };
}

export type ResolvedSession =
  | { status: 'ok'; session: Session; account: Account }
  | { status: Exclude<SessionStatus, 'ok'> | 'none'; session?: Session };

export async function resolveSession(token: string | undefined, now = new Date()): Promise<ResolvedSession> {
  if (!token) return { status: 'none' };
  const row = await prisma.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { account: true },
  });
  if (!row) return { status: 'none' };
  const { account, ...session } = row;

  const status = evaluateSession(session, account, now);
  if (status === 'ok') return { status, session, account };

  // Time-based failures revoke the row, so the cookie is dead for good rather
  // than merely refused this once.
  if ((status === 'idle' || status === 'expired' || status === 'inactive') && !session.revokedAt) {
    await prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: now, revokedReason: status },
    });
  }
  return { status, session };
}

/** Record user activity, throttled. Returns the (possibly updated) timestamp. */
export async function touchSession(session: Session, now = new Date()): Promise<Date> {
  if (now.getTime() - session.lastActivityAt.getTime() < SLIDE_WRITE_THROTTLE_MS) return session.lastActivityAt;
  await prisma.session.update({ where: { id: session.id }, data: { lastActivityAt: now } });
  return now;
}

export async function revokeSession(id: string, reason: string, now = new Date()): Promise<void> {
  await prisma.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: now, revokedReason: reason } });
}

/** Kill every live session for an account (password change, deactivation, MFA reset). */
export async function revokeAllForAccount(
  accountId: string,
  reason: string,
  exceptSessionId?: string,
  now = new Date(),
): Promise<number> {
  const r = await prisma.session.updateMany({
    where: { accountId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: now, revokedReason: reason },
  });
  return r.count;
}
