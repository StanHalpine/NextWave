/**
 * Who may open clinical documentation, and as what.
 *
 *   FRONT_DESK   never. They see THAT a visit has documentation and whether it is signed (a status
 *                on the appointment), never what it says.
 *   PROVIDER_*   read and write, for visits in their own provider role.
 *   ADMIN        read only. An administrator who ALSO holds a provider role writes as that role.
 *
 * And before any of it: the account must have an authenticator enrolled AND have used it in this
 * session. The sign-in flow already demands that of provider roles (MFA_REQUIRED_ROLES), but this
 * gate does not depend on that setting — a mis-set environment variable must not be able to open
 * the clinical record to someone who has not passed the second step.
 */

import type { NextFunction, Request, Response } from 'express';
import { audit } from '../lib/audit.js';
import { PROVIDER_ROLES } from '../lib/sessions.js';
import { isProviderRole, providerRolesOf, type ProviderRole } from '../lib/providerRoles.js';
import { requireRole } from './session.js';

function refuse(req: Request, res: Response, code: string, error: string, extra: object = {}) {
  audit.record({ action: 'ACCESS_DENIED', resourceType: 'clinical_documentation', success: false, meta: { method: req.method, path: req.originalUrl.split('?')[0], code } });
  return res.status(403).json({ error, code, ...extra });
}

/** Authenticator enrolled and used in this session. Run after requireRole (which guarantees req.auth). */
export function requireMfa(req: Request, res: Response, next: NextFunction) {
  const a = req.auth!;
  if (!a.account.mfaEnabledAt) {
    return refuse(req, res, 'mfa_enrollment_required', 'Set up your authenticator app before opening clinical documentation.', { needs: ['mfa_enroll'] });
  }
  if (!a.session.mfaVerifiedAt) {
    return refuse(req, res, 'mfa_verification_required', 'Enter your authenticator code before opening clinical documentation.', { needs: ['mfa_verify'] });
  }
  next();
}

/** Providers and admins, authenticator in place. For anything that READS clinical documentation. */
export const requireClinicalRead = [requireRole(...PROVIDER_ROLES, 'ADMIN'), requireMfa];

/** Providers only (an admin who also holds a provider role passes as that role). */
export const requireClinicalWrite = [
  requireRole(...PROVIDER_ROLES, 'ADMIN'),
  requireMfa,
  (req: Request, res: Response, next: NextFunction) => {
    if (providerRolesOf(req.auth!.account.roles).length === 0) {
      return refuse(req, res, 'read_only', 'Administrators can read clinical documentation but cannot write it.');
    }
    next();
  },
];

/**
 * The provider role this request acts as: the one named, if the account holds it; the only one it
 * holds, if it holds one; otherwise none (an admin reading). An unheld role is refused, not ignored.
 */
export function actingRole(req: Request, requested?: unknown): { role: ProviderRole | null } | { error: string } {
  const held = providerRolesOf(req.auth!.account.roles);
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string' || !isProviderRole(requested) || !held.includes(requested)) {
      return { error: 'You do not hold that provider role.' };
    }
    return { role: requested };
  }
  if (held.length === 1) return { role: held[0]! };
  if (held.length > 1) return { error: 'Say which of your provider roles you are acting as.' };
  return { role: null };
}
