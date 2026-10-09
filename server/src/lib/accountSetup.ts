import { prisma } from './prisma.js';
import { config } from '../config.js';
import { randomToken, sha256Hex } from './crypto.js';
import { hashPassword } from './password.js';

export const SETUP_LINK_TTL_MS = 24 * 60 * 60_000;

/**
 * Mint a one-time link that lets a new (or reset) account choose its own
 * password. The raw token is returned ONCE and only its SHA-256 is stored, so
 * the database cannot be used to reconstruct a link.
 *
 * The token rides in the URL FRAGMENT (#token=…), which browsers never send to
 * the server — so it cannot land in access logs, a proxy's logs, or a Referer
 * header. The setup page reads it client-side and POSTs it in a body.
 */
export async function issueSetupLink(accountId: string, purpose: 'SETUP' | 'RESET', createdById: string | null): Promise<string> {
  // Supersede any outstanding links so only the newest works.
  await prisma.setupToken.updateMany({ where: { accountId, usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken(32);
  await prisma.setupToken.create({
    data: { accountId, tokenHash: sha256Hex(token), purpose, expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS), createdById },
  });
  return `${config.appBaseUrl}/app/setup#token=${token}`;
}

/** A password hash for an account nobody can log into until the setup link is used. */
export async function unusableHash(): Promise<string> {
  return hashPassword(randomToken(48));
}
