import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { bootstrapAdmin, SETUP_LINK_MARKER } from '../src/lib/bootstrapAdmin.js';
import * as accountSetup from '../src/lib/accountSetup.js';
import { app, makeAccount, uniqueEmail } from './helpers.js';

/**
 * The first-administrator bootstrap that every `npm run seed` runs (src/lib/bootstrapAdmin.ts).
 *
 * The suite's schema already has administrators (other files make them), and the bootstrap refuses to add one beside
 * another. So this file takes every active administrator out of the way for its duration and puts them back after.
 */

const PW = 'a-passphrase-chosen-by-the-admin-8';
const benched = new Set<string>();
const created = new Set<string>();

/** Take every active administrator out of the way — the ones other files left, and the ones this file made a moment ago. */
async function benchAdmins() {
  const admins = await prisma.account.findMany({ where: { roles: { has: 'ADMIN' }, active: true }, select: { id: true } });
  for (const a of admins) benched.add(a.id);
  await prisma.account.updateMany({ where: { id: { in: admins.map((a) => a.id) } }, data: { active: false } });
}

beforeEach(benchAdmins);

afterAll(async () => {
  // Everything this file made goes (sessions and setup tokens cascade); every administrator it benched comes back.
  await prisma.account.deleteMany({ where: { email: { in: [...created] } } });
  await prisma.account.updateMany({ where: { id: { in: [...benched] } }, data: { active: true } });
});

const email = (tag = 'boot') => { const e = uniqueEmail(tag); created.add(e); return e; };

/** Run the bootstrap and collect what it printed. */
async function run(opts: Omit<Parameters<typeof bootstrapAdmin>[0], 'out'>) {
  const lines: string[] = [];
  const status = await bootstrapAdmin({ ...opts, out: (l) => lines.push(l) });
  const text = lines.join('\n');
  const link = /(https?:\/\/\S+#token=\S+)/.exec(text)?.[1] ?? null;
  return { status, lines, text, link, token: link?.split('#token=')[1] ?? null };
}

const accountCount = () => prisma.account.count();

describe('creating the first administrator', () => {
  it('creates an ADMIN with no usable password and prints the one-time link — and only the link', async () => {
    const e = email();
    const r = await run({ email: e, name: 'Dana Admin' });

    expect(r.status).toBe('created');
    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e } });
    expect(acct.roles).toEqual(['ADMIN']);
    expect(acct.displayName).toBe('Dana Admin');
    expect(acct.mustChangePassword).toBe(true);
    expect(acct.active).toBe(true);

    // exactly one link, on its own line, under a marker an operator can search the log for
    expect(r.lines.filter((l) => l.includes('#token=')).length).toBe(1);
    expect(r.text).toContain(SETUP_LINK_MARKER);
    expect(r.link).toMatch(/^http:\/\/localhost:4000\/app\/setup#token=[A-Za-z0-9_-]{20,}$/);

    // nothing else secret was said: not the stored hash, not the stored token hash, no password of any kind
    const stored = await prisma.setupToken.findMany({ where: { accountId: acct.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.purpose).toBe('SETUP');
    for (const secret of [acct.passwordHash, stored[0]!.tokenHash]) expect(r.text).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(r.token!);
    expect(r.text.toLowerCase()).not.toMatch(/password (is|=|:)/);
    // the address itself is not echoed into the log either
    expect(r.text).not.toContain(e);
  });

  it('issues a link that actually works, once: the admin chooses a password and can sign in', async () => {
    const e = email();
    const r = await run({ email: e });
    const setup = await request(app).post('/api/auth/setup').send({ token: r.token, newPassword: PW });
    expect(setup.status).toBe(200);
    expect(setup.body.email).toBe(e);
    expect((await request(app).post('/api/auth/setup').send({ token: r.token, newPassword: 'another-passphrase-9-xx' })).status).toBe(400);
    expect((await prisma.account.findUniqueOrThrow({ where: { email: e } })).mustChangePassword).toBe(false);
    expect((await request(app).post('/api/auth/login').send({ email: e, password: PW })).status).toBe(200);
  });

  it('expires the link after 24 hours', async () => {
    const r = await run({ email: email() });
    const row = await prisma.setupToken.findFirstOrThrow({ where: { account: { email: { in: [...created] } }, usedAt: null }, orderBy: { createdAt: 'desc' } });
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(24, 1);
    expect(r.text).toMatch(/valid 24 hours, single use/);
  });

  it('treats the address case- and whitespace-insensitively, and defaults the name', async () => {
    const e = email('Mixed');
    const r = await run({ email: `  ${e.toUpperCase()}  ` });
    expect(r.status).toBe('created');
    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e.toLowerCase() } });
    expect(acct.displayName).toBe('Administrator');
    created.add(e.toLowerCase());
    expect((await run({ email: e })).status).toBe('exists');
  });

  it('audits the creation and the link, naming the system actor — never the link', async () => {
    const e = email();
    const r = await run({ email: e });
    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e } });
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'account', resourceId: acct.id }, orderBy: { id: 'asc' } });
    expect(rows.map((x) => x.action)).toEqual(['CREATE', 'PASSWORD_RESET']);
    for (const x of rows) { expect(x.actorRoles).toBe('system:seed'); expect(x.success).toBe(true); }
    expect(rows[0]!.meta).toMatchObject({ roles: ['ADMIN'], via: 'seed' });
    expect(rows[1]!.meta).toMatchObject({ via: 'seed', linkIssued: true });
    const blob = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(blob).not.toContain(r.token!);
    expect(blob).not.toContain(e);
  });
});

describe('idempotence', () => {
  it('a second run changes nothing and prints no link; the first link still works', async () => {
    const e = email();
    const first = await run({ email: e });
    const before = { accounts: await accountCount(), tokens: await prisma.setupToken.count(), audit: await prisma.auditLog.count() };

    const again = await run({ email: e });
    expect(again.status).toBe('exists');
    expect(again.link).toBeNull();
    expect(again.text).not.toContain(SETUP_LINK_MARKER);
    expect(await accountCount()).toBe(before.accounts);
    expect(await prisma.setupToken.count()).toBe(before.tokens);
    expect(await prisma.auditLog.count()).toBe(before.audit);

    // not superseded either: the link printed the first time is still the live one
    expect((await request(app).post('/api/auth/setup').send({ token: first.token, newPassword: PW })).status).toBe(200);
  });

  it('leaves an existing account alone even when it is not an administrator', async () => {
    const e = email();
    await makeAccount({ roles: ['FRONT_DESK'], email: e });
    const before = await prisma.setupToken.count();
    const r = await run({ email: e });
    expect(r.status).toBe('exists');
    expect(r.link).toBeNull();
    expect((await prisma.account.findUniqueOrThrow({ where: { email: e } })).roles).toEqual(['FRONT_DESK']);
    expect(await prisma.setupToken.count()).toBe(before);
  });

  it('two runs at the same moment create one account and print one link', async () => {
    const e = email();
    const [a, b] = await Promise.all([run({ email: e }), run({ email: e })]);
    expect([a.status, b.status].sort()).toEqual(['created', 'exists']);
    expect([a, b].filter((x) => x.link).length).toBe(1);
    expect(await prisma.account.count({ where: { email: e } })).toBe(1);
    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e } });
    expect(await prisma.setupToken.count({ where: { accountId: acct.id } })).toBe(1);
  });

  it('never leaves an account with no link: if issuing the link fails, nothing is kept, and the next run succeeds', async () => {
    const e = email();
    const creates = () => prisma.auditLog.count({ where: { resourceType: 'account', action: 'CREATE' } });
    const [accounts, audited] = [await accountCount(), await creates()];
    // The link is issued INSIDE the transaction with the account; make it fail after the account row has been written.
    const spy = vi.spyOn(accountSetup, 'issueSetupLink').mockRejectedValueOnce(new Error('boom'));
    try {
      await expect(run({ email: e })).rejects.toThrow('boom');
    } finally { spy.mockRestore(); }
    expect(await prisma.account.count({ where: { email: e } })).toBe(0);
    expect(await accountCount()).toBe(accounts);
    expect(await creates()).toBe(audited);

    const r = await run({ email: e });
    expect(r.status).toBe('created');
    expect(r.link).not.toBeNull();
  });
});

describe('when there is nothing to do, or it must not be done', () => {
  it.each([undefined, '', '   '])('does nothing when ADMIN_EMAIL is %j', async (value) => {
    const before = await accountCount();
    const r = await run({ email: value });
    expect(r.status).toBe('unset');
    expect(r.link).toBeNull();
    expect(await accountCount()).toBe(before);
  });

  it.each(['not-an-email', 'two@@example.test', 'a b@example.test', `${'x'.repeat(250)}@example.test`])('refuses %j as an address, creates nothing, and does not echo it', async (bad) => {
    const before = await accountCount();
    const r = await run({ email: bad });
    expect(r.status).toBe('invalid_email');
    expect(r.link).toBeNull();
    expect(r.text).toContain('not a valid email address');
    expect(r.text).not.toContain(bad.trim());
    expect(await accountCount()).toBe(before);
  });

  it('does not add a second administrator beside an active one', async () => {
    const other = await makeAccount({ roles: ['ADMIN'], email: email('incumbent') });
    const e = email();
    const before = await accountCount();
    const r = await run({ email: e });
    expect(r.status).toBe('other_admin');
    expect(r.link).toBeNull();
    expect(r.text).toContain('Admin → Accounts');
    expect(await accountCount()).toBe(before);
    expect(await prisma.account.count({ where: { email: e } })).toBe(0);

    // a deactivated administrator does not block it, and neither does an active non-admin
    await prisma.account.update({ where: { id: other.id }, data: { active: false } });
    await makeAccount({ roles: ['FRONT_DESK'], email: email('desk') });
    expect((await run({ email: e })).status).toBe('created');
  });

  it('--reissue (the shell script) gives an existing account a fresh link and retires the old one', async () => {
    const e = email();
    const first = await run({ email: e });
    const again = await run({ email: e, reissue: true, via: 'seed-admin' });
    expect(again.status).toBe('reissued');
    expect(again.token).not.toBeNull();
    expect(again.token).not.toBe(first.token);
    expect((await request(app).post('/api/auth/setup').send({ token: first.token, newPassword: PW })).status).toBe(400);
    expect((await request(app).post('/api/auth/setup').send({ token: again.token, newPassword: PW })).status).toBe(200);
    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e } });
    const rows = await prisma.auditLog.findMany({ where: { resourceType: 'account', resourceId: acct.id, action: 'PASSWORD_RESET', actorRoles: 'system:seed-admin' } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- the real entry point, against a database that already has services ------------------------
//
// This is the staging situation: the catalogue was seeded before ADMIN_EMAIL was set, so the seed now skips. The suite's schema was
// seeded by tests/globalSetup.ts and has its services, so `npm run seed`'s own file is run against it in a child process.

function seedRun(env: Record<string, string>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!('ADMIN_EMAIL' in env)) delete childEnv.ADMIN_EMAIL;
  if (!('ADMIN_NAME' in env)) delete childEnv.ADMIN_NAME;
  const r = spawnSync('npx', ['tsx', 'prisma/seed.ts'], { cwd: process.cwd(), env: childEnv, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('npm run seed, on a database whose services already exist', () => {
  it('skips the catalogue but still creates the administrator and prints the link', async () => {
    const e = email('seedrun');
    const services = await prisma.service.count();
    expect(services).toBeGreaterThan(0);

    const r = seedRun({ ADMIN_EMAIL: e, ADMIN_NAME: 'Staging Admin' });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`skipped — database already has ${services} service(s).`);
    expect(await prisma.service.count()).toBe(services);                       // the catalogue was not touched
    expect(r.out).toContain('admin bootstrap: created the first administrator.');
    expect(r.out).toContain(SETUP_LINK_MARKER);
    expect(r.out.match(/#token=/g)).toHaveLength(1);
    expect(r.out).toContain('Seed complete.');

    const acct = await prisma.account.findUniqueOrThrow({ where: { email: e } });
    expect(acct.roles).toEqual(['ADMIN']);
    expect(acct.displayName).toBe('Staging Admin');
    // the link in the log redeems
    const token = /#token=(\S+)/.exec(r.out)![1]!;
    expect((await request(app).post('/api/auth/setup').send({ token, newPassword: PW })).status).toBe(200);
    // and the log carries nothing else secret
    expect(r.all).not.toContain(acct.passwordHash);
    expect(r.all).not.toContain(e);
  });

  it('on the next deploy it changes nothing and prints no link', async () => {
    const e = email('seedrun');
    expect(seedRun({ ADMIN_EMAIL: e }).code).toBe(0);
    const accounts = await accountCount();
    const tokens = await prisma.setupToken.count();

    const again = seedRun({ ADMIN_EMAIL: e });
    expect(again.code).toBe(0);
    expect(again.out).toContain('an account with ADMIN_EMAIL already exists — nothing changed.');
    expect(again.all).not.toContain('#token=');
    expect(again.out).toContain('Seed complete.');
    expect(await accountCount()).toBe(accounts);
    expect(await prisma.setupToken.count()).toBe(tokens);
  });

  it('with ADMIN_EMAIL unset it says so and creates nothing', async () => {
    const before = await accountCount();
    const r = seedRun({});
    expect(r.code).toBe(0);
    expect(r.out).toContain('ADMIN_EMAIL is not set — nothing to do.');
    expect(r.out).toContain('Seed complete.');
    expect(await accountCount()).toBe(before);
  });

  it('a bad ADMIN_EMAIL is reported in the log but does not fail the deploy', async () => {
    const r = seedRun({ ADMIN_EMAIL: 'not-an-email' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('ADMIN_EMAIL is not a valid email address');
    expect(r.out).toContain('Seed complete.');
  });

  it('a refused configuration (production without a usable APP_BASE_URL) is reported by name, creates nothing, and does not fail the deploy', async () => {
    const e = email('seedrun');
    const r = seedRun({ ADMIN_EMAIL: e, NODE_ENV: 'production', APP_BASE_URL: 'http://not-https.example' });
    expect(r.code).toBe(0);
    expect(r.all).toMatch(/admin bootstrap FAILED \(the app's configuration was refused: Refusing to start: /);
    expect(r.all).toContain('no administrator was created');
    expect(r.all).toContain('Seed complete.');
    expect(r.all).not.toContain('#token=');
    expect(await prisma.account.count({ where: { email: e } })).toBe(0);
  });
});
