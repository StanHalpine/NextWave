/**
 * Create the FIRST administrator, from the ADMIN_EMAIL environment variable.
 *
 *   ADMIN_EMAIL=you@example.com npm run seed:admin
 *
 * No password is ever created, accepted or printed. The script prints a ONE-TIME
 * SETUP LINK (valid 24 hours); the administrator opens it and chooses their own
 * password, then enrols an authenticator app — TOTP is mandatory for admins.
 *
 * Safe to re-run:
 *   • account does not exist      → created, link printed
 *   • account exists              → nothing changes; add --reissue for a fresh link
 *   • a DIFFERENT admin exists    → refuses. The first admin is a bootstrap step;
 *                                   further admins are created from the app
 *                                   (Admin → Accounts), where it is audited.
 *
 * The link is the only output a human needs to see. It is printed to the
 * terminal that ran the script and nowhere else (not to the audit log, which
 * records only that a link was issued).
 *
 * The logic lives in src/lib/bootstrapAdmin.ts, which `npm run seed` also runs on
 * every deploy — so on a host with no shell (Render's free plan) setting ADMIN_EMAIL
 * and redeploying does the same job and the link appears in the deploy log. This
 * script remains for a shell, and is the only way to --reissue.
 */

import { prisma } from '../src/lib/prisma.js';
import { bootstrapAdmin, type BootstrapStatus } from '../src/lib/bootstrapAdmin.js';

const reissue = process.argv.includes('--reissue');

/** 0 for "done or nothing to do"; 1 when the operator asked for something that did not happen. */
const EXIT: Record<BootstrapStatus, number> = { created: 0, reissued: 0, exists: 0, unset: 1, invalid_email: 1, other_admin: 1 };

bootstrapAdmin({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME, reissue, via: 'seed-admin', out: (l) => console.log(l) })
  .then(async (status) => {
    if (status === 'unset') console.error('Run:  ADMIN_EMAIL=you@example.com npm run seed:admin');
    if (status === 'exists') console.log('Use --reissue for a fresh setup link.');
    await prisma.$disconnect();
    process.exit(EXIT[status]);
  })
  .catch(async (err) => {
    // Print the class only — never the message, which can echo query arguments.
    console.error('seed-admin failed:', err instanceof Error ? err.constructor.name : typeof err);
    await prisma.$disconnect();
    process.exit(1);
  });
