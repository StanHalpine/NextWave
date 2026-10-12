/**
 * Which database URL the PRISMA CLI connects with, as distinct from the one the running app uses.
 *
 * The app connects with DATABASE_URL. On Supabase that is the TRANSACTION pooler (port 6543, ?pgbouncer=true), which is right
 * for a server and wrong for migrations: Prisma Migrate takes a session-level advisory lock and runs statements that a transaction
 * pooler cannot carry, so a migration through it hangs or fails. The schema therefore declares `directUrl = env("DIRECT_URL")`,
 * which only the CLI reads (the running app never does), and migrations go through that: a direct connection, or Supabase's session
 * pooler (port 5432).
 *
 * Prisma itself will not fall back: with `directUrl` declared and DIRECT_URL unset, every migrate command stops with P1012. So
 * prisma.config.ts — which the Prisma CLI loads before it reads the schema, however it is invoked (`npx prisma …`, the npm scripts, the
 * Render build command) — runs prismaCliEnv() and applies the result:
 *
 *   • DIRECT_URL set                → used, after two checks: it must not be a transaction pooler, and in production it must require TLS;
 *   • DIRECT_URL unset, DEVELOPMENT → DATABASE_URL is used (one database, no pooler: nothing else to choose between);
 *   • DIRECT_URL unset, PRODUCTION  → refused. A silent fallback to a pooled URL is exactly the failure this exists to prevent;
 *                                     a database with no pooler sets DIRECT_URL to the same value as DATABASE_URL.
 *
 * Nothing here ever puts a URL in a message: they carry the database password.
 */

export class DbEnvError extends Error {
  constructor(message: string) { super(message); this.name = 'DbEnvError'; }
}

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** A transaction-mode pooler: Supabase's port 6543, or Prisma's own pgbouncer=true flag. (Port 5432 on a pooler host is session mode, which is fine.) */
export function isTransactionPooler(url: string): boolean {
  const u = parse(url);
  return !!u && (u.port === '6543' || (u.searchParams.get('pgbouncer') ?? '').toLowerCase() === 'true');
}

/** Does this connection string insist on TLS? (sslmode=require | verify-ca | verify-full, or ssl=true.) An unparseable URL does not. */
export function urlRequiresTls(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  const mode = (u.searchParams.get('sslmode') ?? '').toLowerCase();
  return ['require', 'verify-ca', 'verify-full'].includes(mode) || u.searchParams.get('ssl') === 'true';
}

export interface CliEnv {
  env: NodeJS.ProcessEnv;
  /** Which variable the CLI will connect with. */
  using: 'DIRECT_URL' | 'DATABASE_URL';
  /** True when DIRECT_URL was unset and DATABASE_URL was used instead, for a command that connects (development only). */
  fellBack: boolean;
}

/** The CLI commands that open a connection. Everything else (generate, format …) never needs the database, so is never refused. */
const CONNECTING = new Set(['migrate', 'db', 'studio', 'validate']);
export const isConnectingCommand = (command: string): boolean => CONNECTING.has(command);

/**
 * The environment to run a Prisma CLI command with. Throws DbEnvError (no URL in the message) when the command must not go ahead.
 * @param command the first CLI argument ("migrate", "generate", …); "" or a flag such as --version connects to nothing
 */
export function prismaCliEnv(env: NodeJS.ProcessEnv = process.env, command = 'migrate'): CliEnv {
  const direct = (env.DIRECT_URL ?? '').trim();
  const database = (env.DATABASE_URL ?? '').trim();
  const production = env.NODE_ENV === 'production';

  if (!CONNECTING.has(command)) {
    // generate / format / version: no connection is made, so nothing to check — just keep the schema's env() happy.
    return { env: { ...env, ...(direct || database ? { DIRECT_URL: direct || database } : {}) }, using: direct ? 'DIRECT_URL' : 'DATABASE_URL', fellBack: false };
  }

  if (direct) {
    if (!parse(direct)) throw new DbEnvError('DIRECT_URL is not a valid URL.');
    if (isTransactionPooler(direct)) {
      throw new DbEnvError('DIRECT_URL points at a transaction pooler (port 6543, or ?pgbouncer=true). Prisma Migrate holds a session-level advisory lock, which a transaction pooler cannot carry, so migrations would hang or fail. Use the direct connection, or the session pooler (port 5432), and leave pgbouncer=true off it.');
    }
    if (production && !urlRequiresTls(direct)) throw new DbEnvError('NODE_ENV=production but DIRECT_URL does not require TLS. Add ?sslmode=require (or verify-full) to it.');
    return { env: { ...env, DIRECT_URL: direct }, using: 'DIRECT_URL', fellBack: false };
  }

  if (production) {
    throw new DbEnvError('DIRECT_URL is not set. Migrations need a direct (non-pooled) connection: a direct connection string, or the session pooler on port 5432. If this database is not behind a pooler at all, set DIRECT_URL to the same value as DATABASE_URL.');
  }
  if (!database) throw new DbEnvError('Neither DIRECT_URL nor DATABASE_URL is set.');
  if (!parse(database)) throw new DbEnvError('DATABASE_URL is not a valid URL.');
  if (isTransactionPooler(database)) {
    throw new DbEnvError('DIRECT_URL is not set, and DATABASE_URL is a transaction pooler (port 6543, or ?pgbouncer=true), which cannot run migrations. Set DIRECT_URL to the direct connection (or the session pooler on port 5432).');
  }
  return { env: { ...env, DIRECT_URL: database }, using: 'DATABASE_URL', fellBack: true };
}
