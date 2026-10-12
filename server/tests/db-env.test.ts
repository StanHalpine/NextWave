import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basePrisma } from '../src/lib/prismaBase.js';
import { DbEnvError, isTransactionPooler, prismaCliEnv, urlRequiresTls } from '../src/lib/dbEnv.js';

/**
 * Migrations go through DIRECT_URL (a direct connection, or Supabase's session pooler); the app goes through DATABASE_URL (on Supabase,
 * the transaction pooler, which cannot run migrations). These tests pin that split: which URL the CLI gets, what it refuses, that the
 * raw Prisma CLI applies it (prisma.config.ts), that with-schema cannot send a test run's migrations to the real schema, and — against a
 * real database — that `migrate deploy` connects with DIRECT_URL while the running app's client connects with DATABASE_URL.
 */

const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
const POOLER_6543 = 'postgresql://postgres.abcdefgh:s3cretpw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require';
const SESSION_5432 = 'postgresql://postgres.abcdefgh:s3cretpw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';
const DIRECT = 'postgresql://postgres:s3cretpw@db.abcdefgh.supabase.co:5432/postgres?sslmode=require';
const LOCAL = 'postgresql://dev:s3cretpw@localhost:5432/nextwave_dev?schema=public';

const refusal = (e: NodeJS.ProcessEnv, command?: string) => { try { prismaCliEnv(e, command); return null; } catch (x) { expect(x).toBeInstanceOf(DbEnvError); return (x as Error).message; } };

describe('which connection strings are which', () => {
  it('tells a transaction pooler (port 6543, or pgbouncer=true) from the session pooler and a direct connection', () => {
    expect(isTransactionPooler(POOLER_6543)).toBe(true);
    expect(isTransactionPooler('postgresql://u:p@h:6543/db')).toBe(true);
    expect(isTransactionPooler('postgresql://u:p@h:5432/db?pgbouncer=true')).toBe(true);
    expect(isTransactionPooler('postgresql://u:p@h:5432/db?pgbouncer=TRUE')).toBe(true);
    expect(isTransactionPooler(SESSION_5432)).toBe(false);          // session mode: migrations work
    expect(isTransactionPooler(DIRECT)).toBe(false);
    expect(isTransactionPooler(LOCAL)).toBe(false);
    expect(isTransactionPooler('not a url')).toBe(false);
  });

  it('knows when a URL insists on TLS — the same test the app applies to DATABASE_URL in production', () => {
    for (const ok of [`${DIRECT}`, 'postgresql://u:p@h/db?sslmode=verify-full', 'postgresql://u:p@h/db?sslmode=verify-ca', 'postgresql://u:p@h/db?ssl=true']) expect(urlRequiresTls(ok), ok).toBe(true);
    for (const no of [LOCAL, 'postgresql://u:p@h/db?sslmode=disable', 'postgresql://u:p@h/db?sslmode=prefer', 'nonsense']) expect(urlRequiresTls(no), no).toBe(false);
  });
});

describe('the URL the Prisma CLI is given', () => {
  it('uses DIRECT_URL when it is set, and leaves DATABASE_URL (the app\'s) alone', () => {
    const r = prismaCliEnv(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: SESSION_5432 }));
    expect(r.using).toBe('DIRECT_URL');
    expect(r.env.DIRECT_URL).toBe(SESSION_5432);
    expect(r.env.DATABASE_URL).toBe(POOLER_6543);
    expect(prismaCliEnv(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: `  ${DIRECT}  ` })).env.DIRECT_URL).toBe(DIRECT);           // stray spaces from a pasted value
  });

  it('falls back to DATABASE_URL in development when DIRECT_URL is unset or blank', () => {
    const unset: Array<Record<string, string>> = [{ DATABASE_URL: LOCAL }, { DATABASE_URL: LOCAL, DIRECT_URL: '' }, { DATABASE_URL: LOCAL, DIRECT_URL: '   ' }, { DATABASE_URL: LOCAL, NODE_ENV: 'development' }, { DATABASE_URL: LOCAL, NODE_ENV: 'test' }];
    for (const e of unset) {
      const r = prismaCliEnv(env(e));
      expect(r.using, JSON.stringify(e)).toBe('DATABASE_URL');
      expect(r.env.DIRECT_URL).toBe(LOCAL);
    }
  });

  it('REFUSES that fallback when it would send migrations through a pooler — a dev machine pointed at the staging pooler', () => {
    expect(refusal(env({ DATABASE_URL: POOLER_6543 }))).toMatch(/DATABASE_URL is a transaction pooler/);
    expect(refusal(env({ DATABASE_URL: 'postgresql://u:p@h:5432/db?pgbouncer=true' }))).toMatch(/transaction pooler/);
  });

  it('REFUSES an unset DIRECT_URL in production rather than fall back to a pooled URL, and says what to set', () => {
    for (const database of [POOLER_6543, DIRECT, SESSION_5432]) {
      expect(refusal(env({ DATABASE_URL: database, NODE_ENV: 'production' })), database).toMatch(/DIRECT_URL is not set.*same value as DATABASE_URL/);
    }
  });

  it('refuses a DIRECT_URL that is itself a transaction pooler, in any environment', () => {
    for (const nodeEnv of ['production', 'development', 'test']) {
      expect(refusal(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: POOLER_6543, NODE_ENV: nodeEnv })), nodeEnv).toMatch(/DIRECT_URL points at a transaction pooler/);
    }
    expect(refusal(env({ DATABASE_URL: LOCAL, DIRECT_URL: 'postgresql://u:p@h:5432/db?pgbouncer=true' }))).toMatch(/transaction pooler/);
  });

  it('accepts the session pooler (port 5432) and a direct connection for DIRECT_URL — what Supabase recommends for migrations', () => {
    expect(prismaCliEnv(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: SESSION_5432, NODE_ENV: 'production' })).using).toBe('DIRECT_URL');
    expect(prismaCliEnv(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: DIRECT, NODE_ENV: 'production' })).using).toBe('DIRECT_URL');
  });

  it('requires TLS on DIRECT_URL in production only, and a valid URL always', () => {
    expect(refusal(env({ DATABASE_URL: POOLER_6543, DIRECT_URL: 'postgresql://u:p@h:5432/db', NODE_ENV: 'production' }))).toMatch(/does not require TLS/);
    expect(prismaCliEnv(env({ DATABASE_URL: LOCAL, DIRECT_URL: LOCAL, NODE_ENV: 'development' })).using).toBe('DIRECT_URL');           // local Postgres without TLS is fine
    expect(refusal(env({ DATABASE_URL: LOCAL, DIRECT_URL: 'not a url' }))).toMatch(/DIRECT_URL is not a valid URL/);
    expect(refusal(env({ DATABASE_URL: 'not a url' }))).toMatch(/DATABASE_URL is not a valid URL/);
    expect(refusal(env({}))).toMatch(/Neither DIRECT_URL nor DATABASE_URL is set/);
  });

  it('never puts a connection string, a host or a password in a message', () => {
    const cases = [
      env({ DATABASE_URL: POOLER_6543 }), env({ DATABASE_URL: POOLER_6543, NODE_ENV: 'production' }),
      env({ DATABASE_URL: POOLER_6543, DIRECT_URL: POOLER_6543 }), env({ DATABASE_URL: SESSION_5432, DIRECT_URL: 'postgresql://postgres:s3cretpw@db.abcdefgh.supabase.co/postgres', NODE_ENV: 'production' }),
    ];
    for (const c of cases) {
      const m = refusal(c)!;
      expect(m).toBeTruthy();
      for (const leak of ['s3cretpw', 'abcdefgh', 'supabase', 'postgres.', 'postgresql://']) expect(m, leak).not.toContain(leak);
    }
  });

  it('never refuses a command that opens no connection (generate, format): the Render builds run `prisma generate` with no DIRECT_URL', () => {
    expect(prismaCliEnv(env({ NODE_ENV: 'production' }), 'generate').env.DIRECT_URL).toBeUndefined();
    expect(prismaCliEnv(env({ NODE_ENV: 'production', DATABASE_URL: POOLER_6543 }), 'generate').env.DIRECT_URL).toBe(POOLER_6543);   // only to satisfy the schema's env()
    expect(prismaCliEnv(env({ DATABASE_URL: POOLER_6543 }), 'format')).toBeTruthy();
    expect(refusal(env({ NODE_ENV: 'production', DATABASE_URL: POOLER_6543 }), 'migrate')).toBeTruthy();
    expect(refusal(env({ NODE_ENV: 'production', DATABASE_URL: POOLER_6543 }), 'db')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------
/** The Prisma CLI exactly as the Render build, the pre-deploy step and a developer run it: `npx prisma …`, with prisma.config.ts in force. */
const run = (args: string[], over: Record<string, string | undefined>, timeout = 60_000) => {
  const e: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: '/dev/null', ...over };
  for (const k of Object.keys(over)) if (over[k] === undefined) delete e[k];
  return spawnSync('npx', ['prisma', ...args], { cwd: process.cwd(), env: e, encoding: 'utf8', timeout });
};

describe('the Prisma CLI, run raw (as the Render build and pre-deploy run it)', () => {
  it('stops with a clear message and a non-zero exit — before it reads the schema or the database — when production has no DIRECT_URL', () => {
    const r = run(['migrate', 'deploy'], { NODE_ENV: 'production', DATABASE_URL: POOLER_6543, DIRECT_URL: undefined });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/prisma migrate: DIRECT_URL is not set\./);
    for (const leak of ['s3cretpw', 'abcdefgh', 'supabase']) expect(r.stdout + r.stderr, leak).not.toContain(leak);
  });

  it('stops when DIRECT_URL is a transaction pooler', () => {
    const r = run(['migrate', 'deploy'], { DATABASE_URL: LOCAL, DIRECT_URL: POOLER_6543 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DIRECT_URL points at a transaction pooler/);
  });

  it('still runs `prisma generate` in production with no DIRECT_URL and a pooled DATABASE_URL — the Render build step touches no database', () => {
    const r = run(['generate'], { NODE_ENV: 'production', DATABASE_URL: POOLER_6543, DIRECT_URL: undefined }, 120_000);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Generated Prisma Client/);
  }, 150_000);

  it('does not print the fallback note for a command that connects to nothing', () => {
    const r = run(['--version'], { DATABASE_URL: LOCAL, DIRECT_URL: undefined });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('DIRECT_URL is not set');
  });
});

describe('scripts/with-schema.mjs', () => {
  it('overrides DIRECT_URL as well as DATABASE_URL, so a test run\'s migrations can never reach the real schema', () => {
    const probe = 'process.stdout.write(JSON.stringify({ same: process.env.DIRECT_URL === process.env.DATABASE_URL, poisoned: process.env.DIRECT_URL.includes("POISON"), schema: new URL(process.env.DIRECT_URL).searchParams.get("schema") }))';
    const r = spawnSync('node', ['scripts/with-schema.mjs', 'run', 'nw_probe_only', '--', 'node', '-e', probe], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DIRECT_URL: 'postgresql://real:pw@POISON.example.invalid/real?schema=public' },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ same: true, poisoned: false, schema: 'nw_probe_only' });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('`migrate deploy` connects with DIRECT_URL, not DATABASE_URL (against a real database)', () => {
  const SCHEMA = `nw_dirurl_${process.pid}`;
  const urlFor = (schema: string, port?: string) => {
    const u = new URL(process.env.DATABASE_URL!);
    u.searchParams.set('schema', schema);
    u.searchParams.delete('options');
    if (port) u.port = port;
    return u.toString();
  };
  const migrations = readdirSync('prisma/migrations').filter((d) => statSync(`prisma/migrations/${d}`).isDirectory()).length;
  const applied = async () => Number((await basePrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${SCHEMA}"."_prisma_migrations" WHERE finished_at IS NOT NULL`))[0]!.n);

  beforeAll(async () => { await basePrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); await basePrisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`); });
  afterAll(async () => { await basePrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`); });

  it('applies every migration over DIRECT_URL while DATABASE_URL points at nothing (as a transaction pooler would for migrations)', async () => {
    const r = run(['migrate', 'deploy'], { DATABASE_URL: urlFor(SCHEMA, '1'), DIRECT_URL: urlFor(SCHEMA) }, 180_000);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(await applied()).toBe(migrations);
    expect(r.stderr).not.toContain('DIRECT_URL is not set');
  }, 240_000);

  it('does NOT connect with DATABASE_URL: a good DATABASE_URL and a dead DIRECT_URL fails', () => {
    const r = run(['migrate', 'deploy'], { DATABASE_URL: urlFor(SCHEMA), DIRECT_URL: urlFor(SCHEMA, '1') });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/P1001|Can't reach database server|connect/i);
  }, 120_000);

  it('falls back to DATABASE_URL when DIRECT_URL is unset in development — and says so', () => {
    const r = run(['migrate', 'deploy'], { DATABASE_URL: urlFor(SCHEMA), DIRECT_URL: undefined });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).toContain('DIRECT_URL is not set: using DATABASE_URL');
    expect(r.stdout).toMatch(/No pending migrations|successfully applied/);
  }, 120_000);

  // The other half: the RUNNING APP's client (src/lib/prismaBase.ts) connects with DATABASE_URL and never with DIRECT_URL.
  const ping = (over: Record<string, string | undefined>) => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...over };
    for (const k of Object.keys(over)) if (over[k] === undefined) delete e[k];
    const code = "import('./src/lib/prismaBase.ts').then(async ({ basePrisma }) => { try { await basePrisma.$queryRawUnsafe('SELECT 1'); console.log('PING_OK'); } catch { console.log('PING_FAIL'); } finally { await basePrisma.$disconnect(); } })";
    return spawnSync('npx', ['tsx', '-e', code], { cwd: process.cwd(), env: e, encoding: 'utf8', timeout: 60_000 }).stdout.match(/PING_(OK|FAIL)/)?.[1];
  };

  it('the app\'s client connects with DATABASE_URL: it works with DIRECT_URL dead, or unset', () => {
    expect(ping({ DATABASE_URL: urlFor(SCHEMA), DIRECT_URL: urlFor(SCHEMA, '1') })).toBe('OK');
    expect(ping({ DATABASE_URL: urlFor(SCHEMA), DIRECT_URL: undefined })).toBe('OK');
  }, 120_000);

  it('the app\'s client does NOT connect with DIRECT_URL: a dead DATABASE_URL fails even with a good DIRECT_URL', () => {
    expect(ping({ DATABASE_URL: urlFor(SCHEMA, '1'), DIRECT_URL: urlFor(SCHEMA) })).toBe('FAIL');
  }, 60_000);

  it('migrate status reads the same database through the same URL', () => {
    const r = run(['migrate', 'status'], { DATABASE_URL: urlFor(SCHEMA, '1'), DIRECT_URL: urlFor(SCHEMA) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Database schema is up to date/);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------
describe('the wiring that makes production use it', () => {
  const blueprint = readFileSync('../render.yaml', 'utf8');
  const webSection = blueprint.slice(blueprint.indexOf('- type: web'), blueprint.indexOf('- type: cron'));
  const cronSection = blueprint.slice(blueprint.indexOf('- type: cron'));

  it('the web service migrates through the wrapper, with DIRECT_URL declared as a secret; the cron job, which runs no migrations, needs none', () => {
    expect(webSection).toMatch(/preDeployCommand: npm run migrate:deploy && npm run seed/);
    expect(webSection).not.toMatch(/preDeployCommand:.*npx prisma migrate/);          // the raw CLI would skip the pooler and TLS checks
    expect(webSection).toMatch(/- key: DIRECT_URL\n\s+sync: false/);
    expect(cronSection).not.toMatch(/key: DIRECT_URL/);
    expect(cronSection).not.toMatch(/migrate/);
    expect(blueprint.match(/buildCommand:.*prisma generate/g)).toHaveLength(2);       // `generate` needs no DIRECT_URL, so neither build does
  });

  it('the free-plan build command in render.yaml and in the staging checklist is the blueprint\'s own build command plus migrate and seed — last, and identical in both places', () => {
    const buildLine = webSection.match(/buildCommand: (.+)/)![1]!.trim();
    const expected = `${buildLine} && npm run migrate:deploy && npm run seed`;
    const inBlueprint = blueprint.match(/^ *# {3}(npm ci .+)$/m)?.[1]?.trim();
    const inChecklist = readFileSync('../docs/STAGING_CHECKLIST.md', 'utf8').match(/Build Command\*\*, exactly \(one line\):\s*`([^`]+)`/)?.[1]?.trim();
    expect(inBlueprint).toBe(expected);
    expect(inChecklist).toBe(expected);
    expect(expected.indexOf('npm run build ')).toBeLessThan(expected.indexOf('npm run migrate:deploy'));   // migrations after the compile
  });

  it('the schema declares the direct URL, and prisma.config.ts — which every Prisma command loads — applies the rules', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string>; prisma?: unknown };
    expect(pkg.scripts['migrate:deploy']).toBe('prisma migrate deploy');
    expect(pkg.scripts['migrate:status']).toBe('prisma migrate status');
    expect(pkg.prisma).toBeUndefined();                          // the deprecated package.json#prisma: its seed moved into the config
    const config = readFileSync('prisma.config.ts', 'utf8');
    expect(config).toMatch(/prismaCliEnv\(process\.env, command\)/);
    expect(config).toContain("seed: 'tsx prisma/seed.ts'");
    expect(readFileSync('prisma/schema.prisma', 'utf8')).toMatch(/datasource db \{[^}]*url\s+= env\("DATABASE_URL"\)[^}]*directUrl\s+= env\("DIRECT_URL"\)/);
  });
});
