/**
 * Account administration, the audit-log viewer, and integration status.
 * Admin only — and "admin" here means a session that has completed MFA, since
 * requireRole() refuses any session with outstanding steps.
 *
 * No endpoint ever sets a password. A new or reset account gets a ONE-TIME LINK
 * and chooses its own password, so no administrator ever knows, emails, or logs
 * anyone else's credentials.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { AccountRole, Prisma, StaffRole } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { issueSetupLink, SETUP_LINK_TTL_MS, unusableHash } from '../lib/accountSetup.js';
import { PROVIDER_ROLES, revokeAllForAccount } from '../lib/sessions.js';
import { requireRole } from '../middleware/session.js';
import { integrationStatuses } from '../integrations/index.js';

export const adminAccountsRouter = Router();
adminAccountsRouter.use('/admin/accounts', requireRole('ADMIN'));
adminAccountsRouter.use('/admin/audit', requireRole('ADMIN'));
adminAccountsRouter.use('/admin/integrations', requireRole('ADMIN'));

/** Which bookable Staff role each provider login role must be linked to. */
const STAFF_ROLE_FOR: Record<string, StaffRole> = {
  PROVIDER_CHIRO: 'CHIROPRACTOR',
  PROVIDER_NP: 'NURSE_PRACTITIONER',
  PROVIDER_NURSE: 'REGISTERED_NURSE',
};

const ROLES = ['FRONT_DESK', 'ADMIN', 'PROVIDER_CHIRO', 'PROVIDER_NP', 'PROVIDER_NURSE'] as const;
const rolesSchema = z.array(z.enum(ROLES)).min(1, 'Give the account at least one role.').max(3);

/**
 * Rules a role set must satisfy. Returned as a message rather than thrown so the
 * UI can show it verbatim.
 */
async function validateRoles(roles: AccountRole[], staffId: string | null, selfId?: string): Promise<string | null> {
  const providers = roles.filter((r) => PROVIDER_ROLES.includes(r));
  if (new Set(roles).size !== roles.length) return 'Duplicate roles.';
  if (providers.length > 1) {
    // One login = one bookable identity. Two provider roles would need two Staff
    // links, which this model does not have; say so rather than half-supporting it.
    return 'An account can hold at most one provider role (plus Admin and/or Front Desk).';
  }
  if (providers.length === 1) {
    if (!staffId) return 'A provider account must be linked to a provider (Staff) record.';
    const staff = await prisma.staff.findUnique({ where: { id: staffId }, include: { account: { select: { id: true } } } });
    if (!staff) return 'That provider record does not exist.';
    if (staff.role !== STAFF_ROLE_FOR[providers[0]!]) {
      return `That provider record is a ${staff.role.replace(/_/g, ' ').toLowerCase()}, which does not match the ${providers[0]!.replace('PROVIDER_', '').toLowerCase()} role.`;
    }
    if (staff.account && staff.account.id !== selfId) return 'That provider record is already linked to another login.';
  }
  return null;
}

function publicAccount(a: {
  id: string; email: string; displayName: string; roles: AccountRole[]; staffId: string | null; active: boolean;
  mfaEnabledAt: Date | null; lockedUntil: Date | null; lastLoginAt: Date | null; createdAt: Date; mustChangePassword: boolean;
}) {
  return {
    id: a.id, email: a.email, displayName: a.displayName, roles: a.roles, staffId: a.staffId, active: a.active,
    mfaEnabled: !!a.mfaEnabledAt, locked: !!a.lockedUntil && a.lockedUntil > new Date(),
    lastLoginAt: a.lastLoginAt, createdAt: a.createdAt, pendingSetup: a.mustChangePassword,
  };
}

// ---- list / create ---------------------------------------------------------

adminAccountsRouter.get('/admin/accounts', async (_req, res) => {
  const accounts = await prisma.account.findMany({ orderBy: [{ active: 'desc' }, { displayName: 'asc' }] });
  const staff = await prisma.staff.findMany({
    where: { active: true },
    select: { id: true, name: true, role: true, account: { select: { id: true } } },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  audit.read('account', null, { count: accounts.length }, 'admin-accounts');
  res.json({
    accounts: accounts.map(publicAccount),
    // Provider records available to link: active, not already someone's login.
    linkableStaff: staff.filter((s) => !s.account).map((s) => ({ id: s.id, name: s.name, role: s.role })),
  });
});

const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  roles: rolesSchema,
  staffId: z.string().min(1).max(64).nullable().optional(),
}).strict();

adminAccountsRouter.post('/admin/accounts', async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const { email, displayName, roles, staffId = null } = parsed.data;

  if (await prisma.account.findUnique({ where: { email }, select: { id: true } })) {
    return res.status(409).json({ error: 'An account with that email already exists.', code: 'duplicate' });
  }
  const problem = await validateRoles(roles, staffId);
  if (problem) return res.status(400).json({ error: problem, code: 'bad_roles' });

  const account = await prisma.account.create({
    data: { email, displayName, roles, staffId, passwordHash: await unusableHash(), mustChangePassword: true, createdById: req.auth!.account.id },
  });
  const setupLink = await issueSetupLink(account.id, 'SETUP', req.auth!.account.id);
  audit.record({ action: 'CREATE', resourceType: 'account', resourceId: account.id, meta: { roles } });
  res.status(201).json({ account: publicAccount(account), setupLink, setupLinkExpiresInHours: SETUP_LINK_TTL_MS / 3_600_000 });
});

// ---- update ----------------------------------------------------------------

const patchBody = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  roles: rolesSchema.optional(),
  staffId: z.string().min(1).max(64).nullable().optional(),
  active: z.boolean().optional(),
}).strict();

adminAccountsRouter.patch('/admin/accounts/:id', async (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const target = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'Unknown account.', code: 'not_found' });

  const me = req.auth!.account;
  const { displayName, active } = parsed.data;
  const roles = parsed.data.roles ?? target.roles;
  const staffId = parsed.data.staffId !== undefined ? parsed.data.staffId : target.staffId;

  // Never let the last way in be removed: an installation with no active admin
  // cannot create accounts, reset anyone, or recover.
  const losingAdmin = target.roles.includes('ADMIN') && target.active && (!roles.includes('ADMIN') || active === false);
  if (losingAdmin) {
    const others = await prisma.account.count({ where: { active: true, roles: { has: 'ADMIN' }, id: { not: target.id } } });
    if (others === 0) return res.status(409).json({ error: 'This is the last active administrator. Add another first.', code: 'last_admin' });
  }
  if (target.id === me.id && active === false) return res.status(409).json({ error: 'You cannot deactivate your own account.', code: 'self' });

  if (parsed.data.roles || parsed.data.staffId !== undefined) {
    const problem = await validateRoles(roles, staffId, target.id);
    if (problem) return res.status(400).json({ error: problem, code: 'bad_roles' });
  }

  const data: Prisma.AccountUpdateInput = {};
  if (displayName !== undefined) data.displayName = displayName;
  if (parsed.data.roles) data.roles = roles;
  if (parsed.data.staffId !== undefined) data.staff = staffId ? { connect: { id: staffId } } : { disconnect: true };
  if (active !== undefined) data.active = active;
  const updated = await prisma.account.update({ where: { id: target.id }, data });

  // A change of role or status must take effect NOW, not at the next login — so every OTHER sign-in of that account ends.
  // The administrator editing their OWN roles keeps the session they are making the change from (it re-reads the account on every
  // request, so the new roles apply to it at once, and it is already signed in with its authenticator): ending it only dropped them to a
  // generic "your session ended" with their change saved. The app refreshes its view of the roles from /api/auth/me.
  // Deactivation is never spared — and cannot be self-inflicted (the 409 above).
  const ownSession = target.id === me.id && active !== false ? req.auth!.session.id : undefined;
  let sessionKept = false;
  if (active === false || parsed.data.roles) {
    await revokeAllForAccount(target.id, active === false ? 'deactivated' : 'roles_changed', ownSession);
    sessionKept = ownSession !== undefined;
  }
  audit.record({ action: 'UPDATE', resourceType: 'account', resourceId: target.id, meta: { fields: Object.keys(parsed.data) } });
  res.json({ account: publicAccount(updated), sessionKept });
});

// ---- credential recovery (admin-initiated) ---------------------------------

adminAccountsRouter.post('/admin/accounts/:id/reset-password', async (req, res) => {
  const target = await prisma.account.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'Unknown account.', code: 'not_found' });
  await revokeAllForAccount(target.id, 'admin_reset');
  const setupLink = await issueSetupLink(target.id, 'RESET', req.auth!.account.id);
  audit.record({ action: 'PASSWORD_RESET', resourceType: 'account', resourceId: target.id, meta: { by: 'admin' } });
  res.json({ setupLink, setupLinkExpiresInHours: SETUP_LINK_TTL_MS / 3_600_000 });
});

adminAccountsRouter.post('/admin/accounts/:id/unlock', async (req, res) => {
  const target = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'Unknown account.', code: 'not_found' });
  await prisma.account.update({ where: { id: target.id }, data: { lockedUntil: null, failedLoginCount: 0 } });
  audit.record({ action: 'UPDATE', resourceType: 'account', resourceId: target.id, meta: { fields: ['lockedUntil'], unlock: true } });
  res.json({ ok: true });
});

/** Lost phone AND lost recovery codes. Forces re-enrolment at next sign-in. */
adminAccountsRouter.post('/admin/accounts/:id/reset-mfa', async (req, res) => {
  const target = await prisma.account.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!target) return res.status(404).json({ error: 'Unknown account.', code: 'not_found' });
  await prisma.$transaction([
    prisma.account.update({ where: { id: target.id }, data: { mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null } }),
    prisma.mfaRecoveryCode.deleteMany({ where: { accountId: target.id } }),
  ]);
  await revokeAllForAccount(target.id, 'mfa_reset');
  audit.record({ action: 'MFA_ENROLL', resourceType: 'account', resourceId: target.id, meta: { reset: true } });
  res.json({ ok: true });
});

// ---- audit-log viewer ------------------------------------------------------

const auditQuery = z.object({
  actor: z.string().max(64).optional(),
  resourceType: z.string().max(40).optional(),
  resourceId: z.string().max(64).optional(),
  action: z.string().max(30).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  success: z.enum(['true', 'false']).optional(),
  before: z.coerce.bigint().optional(), // cursor: ids are monotonic
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

adminAccountsRouter.get('/admin/audit', async (req, res) => {
  const q = auditQuery.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'Invalid filter.', code: 'bad_request' });
  const f = q.data;

  const where: Prisma.AuditLogWhereInput = {
    ...(f.actor ? { actorAccountId: f.actor } : {}),
    ...(f.resourceType ? { resourceType: f.resourceType } : {}),
    ...(f.resourceId ? { resourceId: f.resourceId } : {}),
    ...(f.action ? { action: f.action as never } : {}),
    ...(f.success ? { success: f.success === 'true' } : {}),
    ...(f.from || f.to ? { occurredAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } } : {}),
    ...(f.before ? { id: { lt: f.before } } : {}),
  };
  const rows = await prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, take: f.limit + 1 });
  const page = rows.slice(0, f.limit);

  // Resolve actor ids to names for display; the trail itself stores only ids.
  const ids = [...new Set(page.map((r) => r.actorAccountId).filter((x): x is string => !!x))];
  const names = new Map((await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((a) => [a.id, a.displayName]));

  audit.read('audit_log', null, { count: page.length }, 'viewer');
  res.json({
    entries: page.map((r) => ({
      // BigInt is not JSON-serialisable.
      id: r.id.toString(),
      occurredAt: r.occurredAt,
      actor: r.actorAccountId ? { id: r.actorAccountId, name: names.get(r.actorAccountId) ?? '(removed account)' } : null,
      actorRoles: r.actorRoles,
      action: r.action,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      success: r.success,
      requestId: r.requestId,
      meta: r.meta,
    })),
    nextBefore: rows.length > f.limit ? page[page.length - 1]!.id.toString() : null,
  });
});

adminAccountsRouter.get('/admin/integrations', (_req, res) => {
  res.json({ integrations: integrationStatuses() });
});
