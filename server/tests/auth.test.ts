import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { currentTotp } from '../src/lib/totp.js';
import { IDLE_MS } from '../src/lib/sessions.js';
import { issueSetupLink } from '../src/lib/accountSetup.js';
import { app, auditRows, blob, makeAccount, PASSWORD, signIn, signInFully, uniqueEmail } from './helpers.js';

describe('login', () => {
  it('signs in and sets an httpOnly, SameSite=Strict cookie holding only an opaque token', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const res = await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/nw_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    // only the hash is stored — the raw cookie value must not appear in the DB
    const raw = /nw_session=([^;]+)/.exec(cookie)![1]!;
    const rows = await prisma.session.findMany({ where: { accountId: a.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(raw);
  });

  it('gives the SAME answer for unknown email, wrong password and deactivated account', async () => {
    const real = await makeAccount({ roles: ['FRONT_DESK'] });
    const off = await makeAccount({ roles: ['FRONT_DESK'], active: false });
    const bodies = await Promise.all([
      request(app).post('/api/auth/login').send({ email: uniqueEmail('nobody'), password: PASSWORD }),
      request(app).post('/api/auth/login').send({ email: real.email, password: 'wrong-password-1' }),
      request(app).post('/api/auth/login').send({ email: off.email, password: PASSWORD }),
    ]);
    for (const r of bodies) expect(r.status).toBe(401);
    expect(new Set(bodies.map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it('locks the account after 5 bad passwords, even for the correct one, and an admin can unlock', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/login').send({ email: a.email, password: `wrong-guess-${i}-xx` })).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD })).status).toBe(401);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).lockedUntil).not.toBeNull();

    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const un = await admin.agent.post(`/api/admin/accounts/${a.id}/unlock`).set('x-csrf-token', admin.csrf).send({});
    expect(un.status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD })).status).toBe(200);
  });

  it('attributes a successful sign-in to the person who signed in (and a failure to no one)', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    await request(app).post('/api/auth/login').send({ email: a.email, password: 'wrong-guess-xyz-12' });
    await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    const ok = await auditRows({ action: 'LOGIN', resourceId: a.id });
    expect(ok[0]).toMatchObject({ actorAccountId: a.id, actorRoles: 'FRONT_DESK', success: true });
    const bad = await auditRows({ action: 'LOGIN_FAILED', resourceId: a.id });
    expect(bad[0]).toMatchObject({ actorAccountId: null, success: false });
  });

  it('never writes the attempted email or password into the audit trail', async () => {
    const probe = uniqueEmail('probe');
    await request(app).post('/api/auth/login').send({ email: probe, password: 'hunter2-hunter2' });
    const rows = await auditRows({ action: 'LOGIN_FAILED', success: false }, 1);
    const text = blob(rows);
    expect(text).not.toContain(probe);
    expect(text).not.toContain('hunter2');
  });
});

describe('MFA (TOTP) for admins', () => {
  it('forces enrolment, blocks every protected route until done, then lets them in', async () => {
    const a = await makeAccount({ roles: ['ADMIN'] });
    const s = await signIn(a.email);
    expect(s.state.needs).toEqual(['mfa_enroll']);

    const blocked = await s.agent.get('/api/admin/accounts');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('step_up_required');

    const start = await s.agent.post('/api/auth/mfa/enroll/start').set('x-csrf-token', s.csrf).send({});
    expect(start.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const bad = await s.agent.post('/api/auth/mfa/enroll/confirm').set('x-csrf-token', s.csrf).send({ code: '000000' });
    expect(bad.status).toBe(400);
    const ok = await s.agent.post('/api/auth/mfa/enroll/confirm').set('x-csrf-token', s.csrf).send({ code: currentTotp(start.body.secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);

    expect((await s.agent.get('/api/admin/accounts')).status).toBe(200);

    // the TOTP seed is encrypted at rest — the plaintext secret is nowhere in the row
    const row = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.mfaSecretEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(start.body.secret);
  });

  it('requires a code on every later sign-in and rejects a wrong one', async () => {
    const a = await makeAccount({ roles: ['ADMIN'] });
    const first = await signInFully(a.email);
    await first.agent.post('/api/auth/logout').set('x-csrf-token', first.csrf);

    const again = await signIn(a.email);
    expect(again.state.needs).toEqual(['mfa_verify']);
    expect((await again.agent.get('/api/admin/accounts')).status).toBe(403);
    const wrong = await again.agent.post('/api/auth/mfa/verify').set('x-csrf-token', again.csrf).send({ code: '123456' });
    expect(wrong.status).toBe(401);
  });

  it('rejects a replayed code (same time step) on a second session', async () => {
    const a = await makeAccount({ roles: ['ADMIN'] });
    const first = await signInFully(a.email); // enrolment consumed the current time step
    const second = await signIn(a.email);
    const replay = await second.agent.post('/api/auth/mfa/verify').set('x-csrf-token', second.csrf).send({ code: currentTotp(first.totpSecret!) });
    expect(replay.status).toBe(401);
  });

  it('accepts a recovery code exactly once', async () => {
    const a = await makeAccount({ roles: ['ADMIN'] });
    const s = await signIn(a.email);
    const start = await s.agent.post('/api/auth/mfa/enroll/start').set('x-csrf-token', s.csrf).send({});
    const conf = await s.agent.post('/api/auth/mfa/enroll/confirm').set('x-csrf-token', s.csrf).send({ code: currentTotp(start.body.secret) });
    const code: string = conf.body.recoveryCodes[0];

    const one = await signIn(a.email);
    expect((await one.agent.post('/api/auth/mfa/verify').set('x-csrf-token', one.csrf).send({ recoveryCode: code })).status).toBe(200);
    const two = await signIn(a.email);
    expect((await two.agent.post('/api/auth/mfa/verify').set('x-csrf-token', two.csrf).send({ recoveryCode: code })).status).toBe(401);
  });

  it('explains (409, not 500) and does not count an attempt when the server key can no longer decrypt the secret', async () => {
    const a = await makeAccount({ roles: ['ADMIN'] });
    const first = await signInFully(a.email);
    await first.agent.post('/api/auth/logout').set('x-csrf-token', first.csrf);
    // simulate a rotated/lost MFA_ENCRYPTION_KEY: the stored blob no longer decrypts
    await prisma.account.update({ where: { id: a.id }, data: { mfaSecretEnc: 'v1.AAAA.AAAA.AAAA' } });

    const s = await signIn(a.email);
    const r = await s.agent.post('/api/auth/mfa/verify').set('x-csrf-token', s.csrf).send({ code: '123456' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('mfa_unreadable');
    expect(r.body.error).toMatch(/administrator/i);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).failedLoginCount).toBe(0);
  });

  it('does not force MFA on a front desk account', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    expect((await signIn(a.email)).state.needs).toEqual([]);
  });
});

describe('sessions', () => {
  it('logout revokes the session SERVER-SIDE: replaying the old cookie fails', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    // Raw requests with an explicit Cookie header, so the cookie can be replayed
    // after logout (a cookie-jar agent would simply drop it).
    const login = await request(app).post('/api/auth/login').send({ email: a.email, password: PASSWORD });
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!).join('; ');
    expect((await request(app).get('/api/auth/me').set('Cookie', cookieHeader)).status).toBe(200);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookieHeader).set('x-csrf-token', login.body.csrfToken);
    expect(out.status).toBe(200);
    expect((await prisma.session.findFirstOrThrow({ where: { accountId: a.id } })).revokedReason).toBe('logout');

    const replay = await request(app).get('/api/auth/me').set('Cookie', cookieHeader);
    expect(replay.status).toBe(401);
  });

  it('expires after 15 minutes of inactivity and revokes the row', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const s = await signIn(a.email);
    await prisma.session.updateMany({ where: { accountId: a.id }, data: { lastActivityAt: new Date(Date.now() - IDLE_MS - 1000) } });
    const res = await s.agent.get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('idle_timeout');
    expect((await prisma.session.findFirstOrThrow({ where: { accountId: a.id } })).revokedReason).toBe('idle');
  });

  it('does NOT slide the idle clock on a GET (background polling must not keep a screen alive)', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const s = await signIn(a.email);
    const stale = new Date(Date.now() - 10 * 60_000);
    await prisma.session.updateMany({ where: { accountId: a.id }, data: { lastActivityAt: stale } });
    await s.agent.get('/api/front-desk/pending');
    await s.agent.get('/api/auth/me');
    const after = await prisma.session.findFirstOrThrow({ where: { accountId: a.id } });
    expect(after.lastActivityAt.getTime()).toBe(stale.getTime());
  });

  it('DOES slide on a ping (a person is present)', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const s = await signIn(a.email);
    await prisma.session.updateMany({ where: { accountId: a.id }, data: { lastActivityAt: new Date(Date.now() - 10 * 60_000) } });
    const res = await s.agent.post('/api/auth/ping').set('x-csrf-token', s.csrf).send({});
    expect(res.status).toBe(200);
    expect(res.body.idleSecondsRemaining).toBeGreaterThan(14 * 60);
  });

  it('refuses a state-changing request with no CSRF token, or a wrong one', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const s = await signIn(a.email);
    const none = await s.agent.post('/api/auth/ping').send({});
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('csrf');
    expect((await s.agent.post('/api/auth/ping').set('x-csrf-token', 'nope').send({})).status).toBe(403);
  });

  it('ends other sessions when the password changes, keeping the current one', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const one = await signIn(a.email);
    const two = await signIn(a.email);
    const res = await two.agent.post('/api/auth/change-password').set('x-csrf-token', two.csrf)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-passphrase-9' });
    expect(res.status).toBe(200);
    expect((await one.agent.get('/api/auth/me')).status).toBe(401);
    expect((await two.agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('one-time setup links', () => {
  it('lets a new account choose its own password exactly once; the token is in a fragment', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'], mustChangePassword: true });
    const link = await issueSetupLink(a.id, 'SETUP', null);
    expect(link).toMatch(/\/app\/setup#token=/);
    const token = link.split('#token=')[1]!;

    const weak = await request(app).post('/api/auth/setup').send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);
    const good = await request(app).post('/api/auth/setup').send({ token, newPassword: 'my-own-chosen-passphrase-3' });
    expect(good.status).toBe(200);
    const reuse = await request(app).post('/api/auth/setup').send({ token, newPassword: 'another-passphrase-here-4' });
    expect(reuse.status).toBe(400);

    expect((await request(app).post('/api/auth/login').send({ email: a.email, password: 'my-own-chosen-passphrase-3' })).status).toBe(200);
    // only a hash of the token is stored
    expect(JSON.stringify(await prisma.setupToken.findMany({ where: { accountId: a.id } }))).not.toContain(token);
  });

  it('rejects an expired link and a superseded one', async () => {
    const a = await makeAccount({ roles: ['FRONT_DESK'] });
    const old = (await issueSetupLink(a.id, 'RESET', null)).split('#token=')[1]!;
    const fresh = (await issueSetupLink(a.id, 'RESET', null)).split('#token=')[1]!;
    expect((await request(app).post('/api/auth/setup').send({ token: old, newPassword: 'passphrase-number-one-5' })).status).toBe(400);

    await prisma.setupToken.updateMany({ where: { accountId: a.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/setup').send({ token: fresh, newPassword: 'passphrase-number-two-6' })).status).toBe(400);
  });
});
