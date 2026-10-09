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
 */

import { z } from 'zod';
import { prisma } from '../src/lib/prisma.js';
import { audit, runAsSystem } from '../src/lib/audit.js';
import { issueSetupLink, SETUP_LINK_TTL_MS, unusableHash } from '../src/lib/accountSetup.js';

const reissue = process.argv.includes('--reissue');

async function main(): Promise<number> {
  const raw = process.env.ADMIN_EMAIL;
  if (!raw) {
    console.error('ADMIN_EMAIL is not set. Run:  ADMIN_EMAIL=you@example.com npm run seed:admin');
    return 1;
  }
  const parsed = z.string().trim().toLowerCase().email().max(254).safeParse(raw);
  if (!parsed.success) {
    console.error('ADMIN_EMAIL is not a valid email address.');
    return 1;
  }
  const email = parsed.data;
  const displayName = (process.env.ADMIN_NAME ?? 'Administrator').trim() || 'Administrator';

  const existing = await prisma.account.findUnique({ where: { email } });
  const otherAdmin = await prisma.account.findFirst({ where: { roles: { has: 'ADMIN' }, active: true, email: { not: email } } });
  if (!existing && otherAdmin) {
    console.error('An administrator already exists. Create further admins from the app (Admin → Accounts).');
    return 1;
  }

  let accountId: string;
  if (existing) {
    if (!reissue) {
      console.log('That account already exists. Nothing changed. Use --reissue for a fresh setup link.');
      return 0;
    }
    accountId = existing.id;
  } else {
    const account = await prisma.account.create({
      data: { email, displayName, roles: ['ADMIN'], passwordHash: await unusableHash(), mustChangePassword: true },
    });
    accountId = account.id;
    audit.record({ action: 'CREATE', resourceType: 'account', resourceId: account.id, meta: { roles: ['ADMIN'], via: 'seed-admin' } });
  }

  const link = await issueSetupLink(accountId, existing ? 'RESET' : 'SETUP', null);
  audit.record({ action: 'PASSWORD_RESET', resourceType: 'account', resourceId: accountId, meta: { via: 'seed-admin', linkIssued: true } });

  console.log(existing ? 'Issued a fresh setup link.' : 'Created the first administrator.');
  console.log(`\n  Open this link to choose a password (valid ${SETUP_LINK_TTL_MS / 3_600_000} hours, single use):\n`);
  console.log(`  ${link}\n`);
  console.log('  Then sign in and enrol an authenticator app when prompted.\n');
  return 0;
}

runAsSystem('seed-admin', main)
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (err) => {
    // Print the class only — never the message, which can echo query arguments.
    console.error('seed-admin failed:', err instanceof Error ? err.constructor.name : typeof err);
    await prisma.$disconnect();
    process.exit(1);
  });
