// Run a command against a throwaway Postgres SCHEMA inside the configured
// database, without ever printing or exposing the connection string.
//
//   node scripts/with-schema.mjs create nw_e2e
//   node scripts/with-schema.mjs run    nw_e2e -- npx prisma migrate deploy
//   node scripts/with-schema.mjs drop   nw_e2e
//
// Why a schema and not a second database: it needs no extra privileges beyond
// CREATE on the database you already have, and it isolates test writes from the
// real tables — important because AuditLog is append-only, so test rows written
// to the real schema could never be cleaned up.
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const [mode, name, ...rest] = process.argv.slice(2);
if (!/^[a-z_][a-z0-9_]{0,40}$/.test(name ?? '')) { console.error('Schema name must match [a-z_][a-z0-9_]*'); process.exit(2); }
if (name === 'public') { console.error('Refusing to touch the public schema.'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }

const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', name);

if (mode === 'create' || mode === 'drop') {
  const db = new PrismaClient({ log: [] });
  try {
    if (mode === 'create') await db.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${name}"`);
    else await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    console.log(`${mode} schema ${name}: ok`);
  } catch (e) {
    console.error(`${mode} schema failed:`, e?.code ?? e?.constructor?.name);
    process.exit(1);
  } finally { await db.$disconnect(); }
} else if (mode === 'run') {
  const cmd = rest[0] === '--' ? rest.slice(1) : rest;
  // DIRECT_URL too: the schema declares directUrl, which `prisma migrate` uses INSTEAD of DATABASE_URL. Left alone, a DIRECT_URL in the
  // developer's environment would send this command's migrations to the REAL schema while everything else ran in the scratch one.
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString() } });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  console.error('Usage: with-schema.mjs create|drop <name>  |  run <name> -- <command...>'); process.exit(2);
}
