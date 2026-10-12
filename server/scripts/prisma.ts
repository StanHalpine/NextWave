/**
 * Run the Prisma CLI with the right database URL.
 *
 *   npm run migrate:deploy          apply every pending migration (what the blueprint's pre-deploy step runs)
 *   npm run migrate:status          which migrations the database has
 *   npm run migrate                 prisma migrate dev (development)
 *   npm run prisma -- <anything>    any other Prisma CLI command
 *
 * The schema says `directUrl = env("DIRECT_URL")` so that migrations use a DIRECT connection while the app uses DATABASE_URL (on
 * Supabase, the transaction pooler, which cannot run migrations). Prisma does not fall back when DIRECT_URL is unset; this does, in
 * development only — see src/lib/dbEnv.ts for the rules. In production DIRECT_URL must be set.
 *
 * Calling `npx prisma migrate …` directly skips all of this and needs DIRECT_URL set in the environment.
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { DbEnvError, prismaCliEnv } from '../src/lib/dbEnv.js';

const args = process.argv.slice(2);
if (args.length === 0) { console.error('Usage: tsx scripts/prisma.ts <prisma arguments>   (for example: migrate deploy)'); process.exit(2); }

let cli;
try {
  cli = prismaCliEnv(process.env, args[0]);
} catch (e) {
  if (!(e instanceof DbEnvError)) throw e;
  console.error(`prisma ${args[0]}: ${e.message}`);
  process.exit(1);
}
if (cli.using === 'DATABASE_URL' && ['migrate', 'db', 'studio', 'validate'].includes(args[0]!)) {
  console.error('DIRECT_URL is not set: using DATABASE_URL for this command (development only; production requires DIRECT_URL).');
}
const r = spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', env: cli.env });
process.exit(r.status ?? 1);
