/**
 * Staff authentication.
 *
 *   POST /api/auth/login               email + password → session cookie
 *   POST /api/auth/mfa/verify          second factor (TOTP or a recovery code)
 *   POST /api/auth/mfa/enroll/start    begin TOTP enrolment
 *   POST /api/auth/mfa/enroll/confirm  prove the authenticator works; get recovery codes
 *   POST /api/auth/change-password
 *   POST /api/auth/setup               redeem a one-time setup / reset link
 *   POST /api/auth/ping                "a person is here" — slides the idle clock
 *   POST /api/auth/logout              revoke the session server-side
 *   GET  /api/auth/me                  who am I, what is still outstanding
 *
 * There are NO patient accounts. Patients are managed by the front desk and the
 * anonymous booking widget is unchanged.
 *
 * Failure messages are deliberately uniform ("Invalid email or password"):
 * which of unknown-account / wrong-password / locked / deactivated applied is
 * never revealed to the caller, only recorded in the audit trail.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { currentContext } from '../lib/requestContext.js';
import { logger } from '../lib/logger.js';
import { decryptSecret, encryptSecret, sha256Hex } from '../lib/crypto.js';
import { burnVerify, hashPassword, validatePassword, verifyPassword } from '../lib/password.js';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, totpUri, verifyTotp } from '../lib/totp.js';
import {
  computeNeeds, createSession, idleSecondsRemaining, revokeAllForAccount, revokeSession, SESSION_COOKIE,
} from '../lib/sessions.js';
import { cookieOptions, requireSession, sessionState } from '../middleware/session.js';

export const authRouter = Router();

/**
 * Decrypt a stored TOTP seed, or null if it cannot be read — which happens when
 * MFA_ENCRYPTION_KEY has changed or been lost since enrolment. That is an
 * operational problem, not a wrong code: it must not count as a failed attempt
 * or surface as a 500, and the recovery (an admin resets MFA) must be named.
 */
function readSecret(blob: string): string | null {
  try { return decryptSecret(blob); } catch (err) { logger.error('mfa_secret_unreadable', err); return null; }
}
const UNREADABLE = {
  error: 'Your authenticator could not be read — the server\'s encryption key has changed. Ask an administrator to reset your authenticator.',
  code: 'mfa_unreadable',
};

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

// Per-IP brake in front of the per-account lockout, so one address cannot walk
// through many accounts. Skipped under test so suites are not throttled.
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many attempts. Try again later.', code: 'rate_limited' },
});

const GENERIC_LOGIN_ERROR = { error: 'Invalid email or password, or the account is temporarily locked.', code: 'invalid_credentials' };

const emailSchema = z.string().trim().toLowerCase().email().max(254);

// ---- helpers ---------------------------------------------------------------

/** Count a failed credential attempt; lock the account on the Nth. */
async function registerFailure(accountId: string): Promise<boolean> {
  const updated = await prisma.account.update({
    where: { id: accountId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (updated.failedLoginCount >= MAX_FAILURES) {
    await prisma.account.update({
      where: { id: accountId },
      data: { lockedUntil: new Date(Date.now() + LOCK_MS), failedLoginCount: 0 },
    });
    await revokeAllForAccount(accountId, 'lockout');
    audit.record({ action: 'LOCKOUT', resourceType: 'account', resourceId: accountId, success: false });
    return true;
  }
  return false;
}

function accountLocked(a: { lockedUntil: Date | null }, now = new Date()): boolean {
  return !!a.lockedUntil && a.lockedUntil > now;
}

// ---- login -----------------------------------------------------------------

const loginBody = z.object({ email: emailSchema, password: z.string().min(1).max(256) }).strict();

authRouter.post('/auth/login', authLimiter, async (req, res) => {
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Email and password are required.', code: 'bad_request' });
  const { email, password } = parsed.data;

  try {
    const account = await prisma.account.findUnique({ where: { email } });
    const now = new Date();

    if (!account || !account.active || accountLocked(account, now)) {
      // Same cost as a real check, so response time cannot reveal which case it was.
      await burnVerify(password);
      audit.record({
        action: 'LOGIN_FAILED', resourceType: 'account', resourceId: account?.id ?? null, success: false,
        meta: { reason: !account ? 'unknown_account' : !account.active ? 'inactive' : 'locked' },
      });
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    if (!(await verifyPassword(account.passwordHash, password))) {
      const locked = await registerFailure(account.id);
      audit.record({ action: 'LOGIN_FAILED', resourceType: 'account', resourceId: account.id, success: false, meta: { reason: 'bad_password', locked } });
      return res.status(401).json(GENERIC_LOGIN_ERROR);
    }

    // Rotate: a login must never inherit a session that existed before it.
    const prior = req.auth?.session.id;
    if (prior) await revokeSession(prior, 'rotated');

    await prisma.account.update({ where: { id: account.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now } });
    const { token, session } = await createSession(account.id, { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

    res.cookie(SESSION_COOKIE, token, cookieOptions());
    // This request began anonymous; from here on it is acting as the person who
    // just proved who they are, so their sign-in is attributed to them.
    const ctx = currentContext();
    if (ctx) ctx.actor = { accountId: account.id, roles: account.roles };
    audit.record({ action: 'LOGIN', resourceType: 'account', resourceId: account.id });

    const auth = { session, account, needs: computeNeeds(account, session) };
    return res.json(sessionState(auth, now));
  } catch (err) {
    logger.error('login_failed', err);
    return res.status(500).json({ error: 'Could not sign in. Please try again.', code: 'server_error', requestId: req.requestId });
  }
});

// ---- who am I ---------------------------------------------------------------

authRouter.get('/auth/me', (req, res) => {
  if (!req.auth) {
    const code = req.authFailure === 'idle' ? 'idle_timeout' : req.authFailure === 'expired' ? 'session_expired' : 'unauthenticated';
    return res.status(401).json({ error: 'Sign in required.', code });
  }
  return res.json(sessionState(req.auth));
});

authRouter.post('/auth/ping', requireSession, (req, res) => {
  // loadSession already slid the idle clock for this request.
  res.json({ idleSecondsRemaining: idleSecondsRemaining(req.auth!.session, new Date()) });
});

authRouter.post('/auth/logout', async (req, res) => {
  const a = req.auth;
  if (a) {
    await revokeSession(a.session.id, 'logout');
    audit.record({ action: 'LOGOUT', resourceType: 'account', resourceId: a.account.id });
  }
  res.clearCookie(SESSION_COOKIE, cookieOptions());
  res.json({ ok: true });
});

// ---- password ---------------------------------------------------------------

const changeBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
}).strict();

authRouter.post('/auth/change-password', requireSession, async (req, res) => {
  const parsed = changeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Current and new password are required.', code: 'bad_request' });
  const { account, session } = req.auth!;
  const { currentPassword, newPassword } = parsed.data;

  if (!(await verifyPassword(account.passwordHash, currentPassword))) {
    await registerFailure(account.id);
    audit.record({ action: 'LOGIN_FAILED', resourceType: 'account', resourceId: account.id, success: false, meta: { reason: 'bad_current_password' } });
    return res.status(401).json({ error: 'Your current password is not correct.', code: 'invalid_credentials' });
  }
  const problem = validatePassword(newPassword, { email: account.email });
  if (problem) return res.status(400).json({ error: problem, code: 'weak_password' });
  if (await verifyPassword(account.passwordHash, newPassword)) {
    return res.status(400).json({ error: 'Choose a password you have not just used.', code: 'weak_password' });
  }

  await prisma.account.update({
    where: { id: account.id },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false },
  });
  // A changed password ends every OTHER session — if it was changed because the
  // old one leaked, the leak must stop working now.
  const ended = await revokeAllForAccount(account.id, 'password_change', session.id);
  audit.record({ action: 'PASSWORD_CHANGE', resourceType: 'account', resourceId: account.id, meta: { otherSessionsEnded: ended } });
  res.json({ ok: true });
});

const setupBody = z.object({ token: z.string().min(20).max(200), newPassword: z.string().min(1).max(256) }).strict();

/** Redeem a one-time link from an administrator (new account, or a reset). */
authRouter.post('/auth/setup', authLimiter, async (req, res) => {
  const parsed = setupBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A link token and a new password are required.', code: 'bad_request' });
  const { token, newPassword } = parsed.data;

  const row = await prisma.setupToken.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { account: true } });
  const now = new Date();
  if (!row || row.usedAt || row.expiresAt <= now || !row.account.active) {
    audit.record({ action: 'PASSWORD_RESET', resourceType: 'account', resourceId: row?.accountId ?? null, success: false, meta: { reason: 'invalid_or_used_token' } });
    return res.status(400).json({ error: 'This link is invalid or has expired. Ask an administrator for a new one.', code: 'invalid_token' });
  }
  const problem = validatePassword(newPassword, { email: row.account.email });
  if (problem) return res.status(400).json({ error: problem, code: 'weak_password' });

  const passwordHash = await hashPassword(newPassword);
  // Claim the token atomically; a concurrent second redemption sees count 0.
  const claimed = await prisma.setupToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
  if (claimed.count !== 1) return res.status(400).json({ error: 'This link has already been used.', code: 'invalid_token' });

  await prisma.account.update({
    where: { id: row.accountId },
    data: { passwordHash, passwordChangedAt: now, mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
  });
  await revokeAllForAccount(row.accountId, 'password_reset');
  audit.record({ action: 'PASSWORD_RESET', resourceType: 'account', resourceId: row.accountId, meta: { purpose: row.purpose } });
  res.json({ ok: true, email: row.account.email });
});

// ---- MFA --------------------------------------------------------------------

authRouter.post('/auth/mfa/enroll/start', requireSession, async (req, res) => {
  const { account, needs } = req.auth!;
  if (needs.includes('change_password')) return res.status(403).json({ error: 'Change your password first.', code: 'step_up_required', needs });
  if (account.mfaEnabledAt) return res.status(409).json({ error: 'Authenticator is already set up.', code: 'already_enrolled' });

  const secret = newTotpSecret();
  await prisma.account.update({ where: { id: account.id }, data: { mfaPendingSecretEnc: encryptSecret(secret) } });
  // The secret is shown ONCE here (for manual entry) and the URI for the QR code.
  res.json({ secret, otpauthUri: totpUri(account.email, secret) });
});

const codeBody = z.object({ code: z.string().min(6).max(12) }).strict();

authRouter.post('/auth/mfa/enroll/confirm', requireSession, async (req, res) => {
  const parsed = codeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter the 6-digit code.', code: 'bad_request' });
  const { account, session } = req.auth!;
  if (account.mfaEnabledAt) return res.status(409).json({ error: 'Authenticator is already set up.', code: 'already_enrolled' });
  if (!account.mfaPendingSecretEnc) return res.status(409).json({ error: 'Start enrolment first.', code: 'not_started' });

  const secret = readSecret(account.mfaPendingSecretEnc);
  if (!secret) return res.status(409).json({ ...UNREADABLE, error: 'Setup could not continue because the server key changed. Start again.', code: 'mfa_unreadable' });
  const r = verifyTotp(secret, parsed.data.code, null);
  if (!r.ok) {
    audit.record({ action: 'MFA_FAILED', resourceType: 'account', resourceId: account.id, success: false, meta: { stage: 'enroll' } });
    return res.status(400).json({ error: 'That code is not right. Check your authenticator and try again.', code: 'mfa_invalid' });
  }

  const { plain, hashes } = newRecoveryCodes();
  const now = new Date();
  await prisma.$transaction([
    prisma.account.update({
      where: { id: account.id },
      data: { mfaSecretEnc: account.mfaPendingSecretEnc, mfaPendingSecretEnc: null, mfaEnabledAt: now, mfaLastStep: r.timeStep },
    }),
    prisma.mfaRecoveryCode.deleteMany({ where: { accountId: account.id } }),
    prisma.mfaRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId: account.id, codeHash })) }),
    prisma.session.update({ where: { id: session.id }, data: { mfaVerifiedAt: now } }),
  ]);
  audit.record({ action: 'MFA_ENROLL', resourceType: 'account', resourceId: account.id });
  // The only time these are ever readable. Only their hashes are stored.
  res.json({ ok: true, recoveryCodes: plain });
});

const verifyBody = z.object({ code: z.string().min(6).max(12).optional(), recoveryCode: z.string().min(6).max(24).optional() })
  .strict()
  .refine((b) => !!b.code !== !!b.recoveryCode, { message: 'Send either code or recoveryCode.' });

authRouter.post('/auth/mfa/verify', authLimiter, requireSession, async (req, res) => {
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your 6-digit code or a recovery code.', code: 'bad_request' });
  const { account, session } = req.auth!;
  if (!account.mfaEnabledAt || !account.mfaSecretEnc) return res.status(409).json({ error: 'No authenticator is set up.', code: 'not_enrolled' });
  if (session.mfaVerifiedAt) return res.json({ ok: true });
  if (accountLocked(account)) return res.status(401).json(GENERIC_LOGIN_ERROR);

  const now = new Date();
  let method: 'totp' | 'recovery' | null = null;

  if (parsed.data.code) {
    const secret = readSecret(account.mfaSecretEnc);
    if (!secret) return res.status(409).json(UNREADABLE);
    const r = verifyTotp(secret, parsed.data.code, account.mfaLastStep);
    if (r.ok) {
      // Conditional write: if two requests present the same code, only one wins.
      const won = await prisma.account.updateMany({
        where: { id: account.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: r.timeStep } }] },
        data: { mfaLastStep: r.timeStep },
      });
      if (won.count === 1) method = 'totp';
    }
  } else if (parsed.data.recoveryCode) {
    const used = await prisma.mfaRecoveryCode.updateMany({
      where: { accountId: account.id, codeHash: hashRecoveryCode(parsed.data.recoveryCode), usedAt: null },
      data: { usedAt: now },
    });
    if (used.count === 1) method = 'recovery';
  }

  if (!method) {
    const locked = await registerFailure(account.id);
    audit.record({ action: 'MFA_FAILED', resourceType: 'account', resourceId: account.id, success: false, meta: { stage: 'verify', locked } });
    return res.status(401).json({ error: 'That code is not right.', code: 'mfa_invalid' });
  }

  await prisma.session.update({ where: { id: session.id }, data: { mfaVerifiedAt: now } });
  await prisma.account.update({ where: { id: account.id }, data: { failedLoginCount: 0 } });
  audit.record({ action: 'MFA_VERIFY', resourceType: 'account', resourceId: account.id, meta: { method } });
  const remaining = method === 'recovery'
    ? await prisma.mfaRecoveryCode.count({ where: { accountId: account.id, usedAt: null } })
    : undefined;
  res.json({ ok: true, ...(remaining !== undefined ? { recoveryCodesRemaining: remaining } : {}) });
});
