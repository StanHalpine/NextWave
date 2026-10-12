/**
 * The FIRST administrator, created from the ADMIN_EMAIL environment variable.
 *
 * Run by every `npm run seed` (so on every deploy, whether or not the service seed has anything to do) and by
 * `npm run seed:admin`. It exists because a host with no shell cannot run the script by hand, and because the
 * service seed deliberately skips a database that already has services: an admin step that lived inside that
 * seed was lost for ever if ADMIN_EMAIL was not yet set the first time it ran.
 *
 * The rule, in full:
 *   • ADMIN_EMAIL unset or blank                       → nothing happens.
 *   • ADMIN_EMAIL is not an email address              → nothing happens; a line in the log says so.
 *   • an account with that email already exists        → nothing changes (and nothing is printed but that fact).
 *   • a DIFFERENT active administrator already exists  → nothing happens. The first admin is a bootstrap step;
 *                                                        further admins are created from the app (Admin → Accounts),
 *                                                        where it is audited. This also stops a stale ADMIN_EMAIL
 *                                                        from minting a new administrator on a database that has
 *                                                        long since moved on.
 *   • otherwise → the administrator is created and ONE one-time setup link is printed.
 *
 * Idempotent, so a repeat deploy changes nothing: "an account with that email exists" is the only state that
 * follows a creation. For that to be true the account, its link and its audit rows are written in ONE
 * transaction — a crash can never leave an account that has no link and is skipped from then on — and two
 * deploys racing each other cannot both create (the unique email decides; the loser reports `exists`).
 *
 * No password is ever created, accepted or printed. The link is a bearer credential: whoever reads it can set
 * the administrator's password until it expires (24 hours) or is used (once). It is printed to `out` — the process's
 * stdout, i.e. the deploy log, for both callers — and goes nowhere else: only its SHA-256 is stored, and
 * the audit log records that a link was issued, never the link.
 */

import { z } from 'zod';
import { basePrisma } from './prismaBase.js';
import { auditInTx, runAsSystem } from './audit.js';

export type BootstrapStatus = 'unset' | 'invalid_email' | 'created' | 'exists' | 'reissued' | 'other_admin';

export interface BootstrapOptions {
  /** The raw ADMIN_EMAIL. */
  email: string | undefined;
  /** ADMIN_NAME — the display name of a NEW account. */
  name?: string | undefined;
  /** `seed-admin --reissue`: give an EXISTING account a fresh link. The deploy seed never sets this. */
  reissue?: boolean;
  /** Who is asking, for the audit trail. */
  via?: 'seed' | 'seed-admin';
  /**
   * Where lines go: the deploy log, for the seed and the script (which pass console.log). Required, not defaulted — this file is under
   * src/, where only the logger may write to the console, and the logger would add a timestamp and a level to a line meant to be copied.
   */
  out: (line: string) => void;
}

/**
 * The app's own start-up checks (config.ts) refused to load — APP_BASE_URL not https, the MFA key missing, … Their messages
 * name the setting and never a value, so unlike a database error this one is safe, and useful, to print whole.
 */
export class BootstrapConfigError extends Error {}

/** The line to search the deploy log for. */
export const SETUP_LINK_MARKER = 'FIRST ADMINISTRATOR SETUP LINK';

const emailSchema = z.string().trim().toLowerCase().email().max(254);

export async function bootstrapAdmin(opts: BootstrapOptions): Promise<BootstrapStatus> {
  const { out } = opts;
  const via = opts.via ?? 'seed';
  const say = (s: string) => out(`admin bootstrap: ${s}`);

  const raw = (opts.email ?? '').trim();
  if (!raw) { say('ADMIN_EMAIL is not set — nothing to do.'); return 'unset'; }
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) { say('ADMIN_EMAIL is not a valid email address — no administrator was created.'); return 'invalid_email'; }
  const email = parsed.data;
  const displayName = (opts.name ?? 'Administrator').trim() || 'Administrator';

  return runAsSystem(via, async () => {
    const existing = await basePrisma.account.findUnique({ where: { email }, select: { id: true } });
    if (existing && !opts.reissue) { say('an account with ADMIN_EMAIL already exists — nothing changed.'); return 'exists'; }

    const otherAdmin = existing ? null : await basePrisma.account.findFirst({
      where: { roles: { has: 'ADMIN' }, active: true, email: { not: email } },
      select: { id: true },
    });
    if (otherAdmin) {
      say('an administrator already exists, so ADMIN_EMAIL was not used. Create further administrators from the app (Admin → Accounts).');
      return 'other_admin';
    }

    // Loaded only now that there is a link to build, not at the top: accountSetup pulls in config.ts, whose production guards
    // (APP_BASE_URL, the MFA key, a TLS database URL) are not this step's business on a deploy that has nothing to do.
    let setup: typeof import('./accountSetup.js');
    try {
      setup = await import('./accountSetup.js');
    } catch (err) {
      throw new BootstrapConfigError(err instanceof Error ? err.message : 'the configuration could not be loaded');
    }
    const { issueSetupLink, SETUP_LINK_TTL_MS, unusableHash } = setup;

    const passwordHash = existing ? null : await unusableHash();
    let link: string;
    try {
      link = await basePrisma.$transaction(async (tx) => {
        let accountId: string;
        if (existing) {
          accountId = existing.id;
        } else {
          const account = await tx.account.create({ data: { email, displayName, roles: ['ADMIN'], passwordHash: passwordHash!, mustChangePassword: true } });
          accountId = account.id;
          await auditInTx(tx, { action: 'CREATE', resourceType: 'account', resourceId: accountId, meta: { roles: ['ADMIN'], via } });
        }
        const issued = await issueSetupLink(accountId, existing ? 'RESET' : 'SETUP', null, tx);
        await auditInTx(tx, { action: 'PASSWORD_RESET', resourceType: 'account', resourceId: accountId, meta: { via, linkIssued: true } });
        return issued;
      });
    } catch (err) {
      // A parallel run created it first (the email is unique): this one has nothing to do.
      if ((err as { code?: string }).code === 'P2002') { say('an account with ADMIN_EMAIL already exists — nothing changed.'); return 'exists'; }
      throw err;
    }

    say(existing ? 'issued a fresh setup link.' : 'created the first administrator.');
    out(`================ ${SETUP_LINK_MARKER} ================`);
    out(`  ${link}`);
    out(`  Open it to choose a password (valid ${SETUP_LINK_TTL_MS / 3_600_000} hours, single use), then sign in and enrol an authenticator app when prompted.`);
    out('  Anyone who can read this log can use the link until it is used or expires.');
    out('================================================================================');
    return existing ? 'reissued' : 'created';
  });
}
