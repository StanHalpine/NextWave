/**
 * Creates a throwaway Postgres SCHEMA inside the configured database, migrates
 * and seeds it, points the tests at it, and drops it afterwards.
 *
 * A schema, not the real tables, because AuditLog is append-only: rows a test
 * writes to the real schema could never be cleaned up. The connection string is
 * derived in-process and never printed.
 */
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();

const SCHEMA = `nw_test_${process.pid}`;

function run(args: string[]) {
  execFileSync('node', ['scripts/with-schema.mjs', ...args], { stdio: 'pipe' });
}

export async function setup() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set — tests need a database to create a scratch schema in.');
  run(['create', SCHEMA]);
  run(['run', SCHEMA, '--', 'npx', 'prisma', 'migrate', 'deploy']);
  run(['run', SCHEMA, '--', 'npx', 'tsx', 'prisma/seed.ts']);

  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', SCHEMA);
  // NW_TEST_POOL=3 re-runs the suite with a tiny connection pool — the setting under which
  // a lock-order mistake turns from "rare" into "every time". See tests/walkin-race.test.ts.
  if (process.env.NW_TEST_POOL) url.searchParams.set('connection_limit', process.env.NW_TEST_POOL);
  // The DATABASE SESSION's time zone for the run. Every DateTime column is a UTC `timestamp without time zone`, and raw SQL that
  // binds a bare Date (or writes now()) reads it in the session zone — invisible on a UTC database, wrong by the offset anywhere
  // else (see lib/sqlTime.ts). So the suite runs in a zone that is neither UTC nor the clinic's, with a half-hour offset to
  // catch a whole-hour assumption too. NW_TEST_TZ=UTC (or America/Chicago, Pacific/Auckland …) runs it under another.
  url.searchParams.set('options', `-c timezone=${process.env.NW_TEST_TZ ?? 'Asia/Kolkata'}`);
  process.env.DATABASE_URL = url.toString();
}

export async function teardown() {
  // DATABASE_URL was overwritten in setup(); restore the original from the env
  // file (override:true — a second `import 'dotenv/config'` would be a cached no-op).
  delete process.env.DATABASE_URL;
  dotenv.config({ override: true });
  try { run(['drop', SCHEMA]); } catch { /* best effort — the name is unique per run */ }
}
