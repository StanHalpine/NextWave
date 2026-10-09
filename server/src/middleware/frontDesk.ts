import { requireRole } from './session.js';

/**
 * The shared-secret gate that used to live here is gone: every staff action now
 * authenticates as a specific person (see middleware/session.ts), which is what
 * makes a note's author, an approval's approver, and an audit row mean anything.
 *
 * The export is kept — with the same name — so the existing route files keep
 * their `requireFrontDesk` guard without being edited. It now means "a
 * signed-in front desk or admin account, with a verified second factor where
 * required, and a valid CSRF token on writes."
 */
export const requireFrontDesk = requireRole('FRONT_DESK', 'ADMIN');
