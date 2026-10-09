import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { app, auditRows, blob, chiroStaff, makeAccount, makeBooking, signIn, signInFully, uniqueEmail } from './helpers.js';

const post = (s: { agent: any; csrf: string }, url: string, body: object = {}) => s.agent.post(url).set('x-csrf-token', s.csrf).send(body);
const patch = (s: { agent: any; csrf: string }, url: string, body: object = {}) => s.agent.patch(url).set('x-csrf-token', s.csrf).send(body);

describe('route protection', () => {
  it('rejects anonymous callers on every staff surface but leaves the public widget open', async () => {
    for (const url of ['/api/front-desk/schedule?date=2026-10-12', '/api/front-desk/pending', '/api/admin/staff', '/api/admin/accounts', '/api/admin/audit']) {
      expect((await request(app).get(url)).status, url).toBe(401);
    }
    expect((await request(app).get('/api/services')).status).toBe(200);
    expect((await request(app).get('/api/config')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('keeps front desk out of admin, and admin-only routes out of reach of providers', async () => {
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    for (const url of ['/api/admin/staff', '/api/admin/accounts', '/api/admin/audit']) {
      expect((await fd.agent.get(url)).status, url).toBe(403);
    }
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await prov.agent.get('/api/admin/accounts')).status).toBe(403);
    expect((await prov.agent.get('/api/front-desk/schedule?date=2026-10-12')).status).toBe(403);
  });

  it('lets front desk use the grid', async () => {
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    expect((await fd.agent.get('/api/front-desk/schedule?date=2026-10-12')).status).toBe(200);
  });

  it('has removed the purge endpoints and the patient lookup that put an email in the URL', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    expect((await post(admin, '/api/admin/purge', { confirm: 'DELETE ALL BOOKINGS' })).status).toBe(404);
    expect((await admin.agent.get('/api/admin/purge')).status).toBe(404);
    expect((await admin.agent.get('/api/patients?email=zelda.q@example.test')).status).toBe(404);
    expect((await post(admin, '/api/patients/search', { email: 'nobody@example.test' })).status).toBe(200);
  });

  it('sets no-store and hardening headers, echoes a safe request id, replaces an unsafe one', async () => {
    const r = await request(app).get('/api/services').set('x-request-id', 'trace-1234abcd');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-request-id']).toBe('trace-1234abcd');
    // An upstream value that is not a plain id (markup, or absurdly long) is replaced, never echoed.
    for (const hostile of ['<script>alert(1)</script>', 'a'.repeat(300)]) {
      const bad = await request(app).get('/api/services').set('x-request-id', hostile);
      expect(bad.headers['x-request-id']).not.toBe(hostile);
      expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('answers malformed JSON with a clean 400 that does not echo the body', async () => {
    const r = await request(app).post('/api/auth/login').set('content-type', 'application/json').send('{"email": "zelda.q@example.test", ');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('zelda');
  });
});

describe('account administration', () => {
  it('creates an account with a one-time link and NEVER a password', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const email = uniqueEmail('new');
    const res = await post(admin, '/api/admin/accounts', { email, displayName: 'New Person', roles: ['FRONT_DESK'] });
    expect(res.status).toBe(201);
    expect(res.body.setupLink).toMatch(/\/app\/setup#token=/);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    // and the account cannot be used until the link is redeemed
    expect((await request(app).post('/api/auth/login').send({ email, password: 'anything-at-all-123' })).status).toBe(401);
  });

  it('enforces role rules: provider needs a matching provider record, at most one provider role', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const chiro = await chiroStaff();
    const np = await prisma.staff.findFirstOrThrow({ where: { role: 'NURSE_PRACTITIONER' } });

    expect((await post(admin, '/api/admin/accounts', { email: uniqueEmail(), displayName: 'X', roles: ['PROVIDER_CHIRO'] })).status).toBe(400); // no staff link
    expect((await post(admin, '/api/admin/accounts', { email: uniqueEmail(), displayName: 'X', roles: ['PROVIDER_CHIRO'], staffId: np.id })).status).toBe(400); // wrong kind
    expect((await post(admin, '/api/admin/accounts', { email: uniqueEmail(), displayName: 'X', roles: ['PROVIDER_CHIRO', 'PROVIDER_NP'], staffId: chiro.id })).status).toBe(400); // two providers
    const ok = await post(admin, '/api/admin/accounts', { email: uniqueEmail(), displayName: 'Dr X', roles: ['ADMIN', 'PROVIDER_CHIRO'], staffId: chiro.id });
    expect(ok.status).toBe(201); // admin + provider: allowed
    expect(ok.body.account.roles.sort()).toEqual(['ADMIN', 'PROVIDER_CHIRO']);
    // the same provider record cannot back two logins
    expect((await post(admin, '/api/admin/accounts', { email: uniqueEmail(), displayName: 'Y', roles: ['PROVIDER_CHIRO'], staffId: chiro.id })).status).toBe(400);
  });

  it('refuses to remove the last administrator, and to deactivate yourself', async () => {
    // Make this the ONLY active admin in the schema for the duration of the check.
    await prisma.account.updateMany({ where: { roles: { has: 'ADMIN' } }, data: { active: false } });
    const me = await makeAccount({ roles: ['ADMIN'] });
    const s = await signInFully(me.email);
    expect((await patch(s, `/api/admin/accounts/${me.id}`, { roles: ['FRONT_DESK'] })).body.code).toBe('last_admin');
    expect((await patch(s, `/api/admin/accounts/${me.id}`, { active: false })).status).toBe(409);
  });

  it('deactivating an account kills its live sessions immediately', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const victim = await makeAccount({ roles: ['FRONT_DESK'] });
    const v = await signIn(victim.email);
    expect((await v.agent.get('/api/auth/me')).status).toBe(200);
    expect((await patch(admin, `/api/admin/accounts/${victim.id}`, { active: false })).status).toBe(200);
    expect((await v.agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('clinical notes: authorship is proven, not claimed', () => {
  it('records the author from the SESSION, and refuses a spoofed authorId', async () => {
    const { booking, staff } = await makeBooking();
    const prov = await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id });
    const s = await signInFully(prov.email);

    // the old API took authorId from the body; sending it now is an error, not an impersonation
    const spoof = await post(s, `/api/bookings/${booking.id}/notes`, { authorId: '00000000-0000-4000-8000-000000000000', body: 'x' });
    expect(spoof.status).toBe(400);

    const ok = await post(s, `/api/bookings/${booking.id}/notes`, { body: 'SECRET-CLINICAL-TEXT lumbar restriction', kind: 'SUBJECTIVE' });
    expect(ok.status).toBe(201);
    const row = await prisma.visitNote.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(row.authorId).toBe(staff.id);
    expect(row.authorAccountId).toBe(prov.id);
    expect(row.authorRole).toBe('PROVIDER_CHIRO');
  });

  it('records the provider ROLE used when a person also holds admin', async () => {
    const { booking, staff } = await makeBooking();
    const both = await makeAccount({ roles: ['ADMIN', 'PROVIDER_CHIRO'], staffId: staff.id });
    const s = await signInFully(both.email);
    const r = await post(s, `/api/bookings/${booking.id}/notes`, { body: 'note by a dual-role user' });
    expect(r.status).toBe(201);
    expect((await prisma.visitNote.findUniqueOrThrow({ where: { id: r.body.id } })).authorRole).toBe('PROVIDER_CHIRO');
  });

  it('does not let front desk, an admin-only account, or an unlinked provider write notes', async () => {
    const { booking } = await makeBooking();
    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    const adminOnly = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const unlinked = await signInFully((await makeAccount({ roles: ['PROVIDER_NP'], staffId: null })).email);
    expect((await post(fd, `/api/bookings/${booking.id}/notes`, { body: 'x' })).status).toBe(403);
    expect((await post(adminOnly, `/api/bookings/${booking.id}/notes`, { body: 'x' })).status).toBe(403);
    const u = await post(unlinked, `/api/bookings/${booking.id}/notes`, { body: 'x' });
    expect(u.status).toBe(403);
    expect(u.body.code).toBe('no_provider_identity');
  });

  it('shows note TEXT to providers and admins but only a COUNT to front desk', async () => {
    const { booking, staff, user } = await makeBooking();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    await post(prov, `/api/bookings/${booking.id}/notes`, { body: 'SECRET-CLINICAL-TEXT' });

    const fd = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);

    const asFd = await fd.agent.get(`/api/bookings/${booking.id}/notes`);
    expect(asFd.body).toMatchObject({ restricted: true, noteCount: 1, notes: [] });
    expect(JSON.stringify(asFd.body)).not.toContain('SECRET-CLINICAL-TEXT');

    expect(JSON.stringify((await prov.agent.get(`/api/bookings/${booking.id}/notes`)).body)).toContain('SECRET-CLINICAL-TEXT');
    expect(JSON.stringify((await admin.agent.get(`/api/bookings/${booking.id}/notes`)).body)).toContain('SECRET-CLINICAL-TEXT');

    const hist = await fd.agent.get(`/api/patients/${user.id}/history`);
    expect(hist.status).toBe(200);
    expect(JSON.stringify(hist.body)).not.toContain('SECRET-CLINICAL-TEXT');
    expect(hist.body.visits[0].noteCount).toBe(1);
  });

  it('amends by inserting a new version attributed to the amender, never editing in place', async () => {
    const { booking, staff } = await makeBooking();
    const prov = await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id });
    const s = await signInFully(prov.email);
    const first = await post(s, `/api/bookings/${booking.id}/notes`, { body: 'original text' });
    const am = await post(s, `/api/visit-notes/${first.body.id}/amend`, { body: 'corrected text', amendReason: 'typo' });
    expect(am.status).toBe(201);
    const [orig, amended] = await Promise.all([
      prisma.visitNote.findUniqueOrThrow({ where: { id: first.body.id } }),
      prisma.visitNote.findUniqueOrThrow({ where: { id: am.body.id } }),
    ]);
    expect(orig.body).toBe('original text'); // preserved verbatim
    expect(amended.amendsId).toBe(orig.id);
    expect(amended.authorAccountId).toBe(prov.id);
  });
});

describe('audit trail', () => {
  it('attributes writes to the acting account (existing code path, no edits) and records denials', async () => {
    const { booking, staff } = await makeBooking();
    const prov = await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id });
    const fdAcct = await makeAccount({ roles: ['FRONT_DESK'] });
    const p = await signInFully(prov.email);
    const fd = await signInFully(fdAcct.email);

    const note = await post(p, `/api/bookings/${booking.id}/notes`, { body: 'SECRET-CLINICAL-TEXT' });
    const created = await auditRows({ action: 'CREATE', resourceType: 'visit_note', resourceId: note.body.id });
    expect(created[0]).toMatchObject({ actorAccountId: prov.id, actorRoles: 'PROVIDER_CHIRO', success: true });

    await post(fd, `/api/bookings/${booking.id}/notes`, { body: 'x' }); // forbidden
    const denied = await auditRows({ action: 'ACCESS_DENIED', actorAccountId: fdAcct.id });
    expect(denied.length).toBeGreaterThan(0);

    // A status change is a write on the EXISTING booking route (which this work
    // does not edit). The Prisma extension must still see it and name the actor.
    // (Cancel rather than approve: approval re-checks live capacity, which is
    // irrelevant here and would refuse a fixture booked at an arbitrary time.)
    const cancel = await patch(fd, `/api/bookings/${booking.id}`, { status: 'CANCELLED' });
    expect(cancel.status).toBe(200);
    const updated = await auditRows({ action: 'UPDATE', resourceType: 'appointment', resourceId: booking.id, actorAccountId: fdAcct.id });
    expect(updated.length).toBe(1);
    expect((updated[0]!.meta as any).fields).toContain('status');
  });

  it('logs READS of patient data, and a list read once per window rather than per refresh', async () => {
    const { booking } = await makeBooking();
    const fdAcct = await makeAccount({ roles: ['FRONT_DESK'] });
    const fd = await signInFully(fdAcct.email);

    await fd.agent.get(`/api/bookings/${booking.id}/notes`);
    const single = await auditRows({ action: 'READ', resourceType: 'visit_note', resourceId: booking.id, actorAccountId: fdAcct.id });
    expect(single.length).toBe(1);

    await fd.agent.get('/api/front-desk/schedule?date=2026-10-12');
    await fd.agent.get('/api/front-desk/schedule?date=2026-10-12');
    await fd.agent.get('/api/front-desk/schedule?date=2026-10-12');
    await new Promise((r) => setTimeout(r, 300));
    const lists = await prisma.auditLog.findMany({ where: { action: 'READ', resourceType: 'appointment', resourceId: null, actorAccountId: fdAcct.id } });
    expect(lists.length).toBe(1);
  });

  it('contains NO patient data and no clinical text, only opaque ids, counts and field names', async () => {
    const { booking, staff } = await makeBooking({ name: 'Ingrid Blomquist', email: 'ingrid.b@example.test', phone: '6125550142' });
    const p = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    await post(p, `/api/bookings/${booking.id}/notes`, { body: 'SECRET-CLINICAL-TEXT sciatica' });
    await p.agent.get(`/api/bookings/${booking.id}/notes`);
    await new Promise((r) => setTimeout(r, 400));

    const all = await prisma.auditLog.findMany();
    expect(all.length).toBeGreaterThan(10);
    const text = blob(all);
    for (const forbidden of ['Ingrid', 'Blomquist', 'ingrid.b', '6125550142', 'SECRET-CLINICAL-TEXT', 'sciatica', 'Zelda']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('is append-only at the database: UPDATE, DELETE and TRUNCATE are all rejected', async () => {
    await auditRows({}, 1);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "success" = false`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditLog"`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "AuditLog"`)).rejects.toThrow();
  });
});

describe('the anonymous booking widget is unchanged — and now audited', () => {
  async function findSlot() {
    const svc = await prisma.service.findFirstOrThrow({ where: { slug: 'spinal-xrays' } });
    for (let d = 1; d <= 20; d++) {
      const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const r = await request(app).get(`/api/availability?serviceId=${svc.id}&date=${date}`);
      if (r.body.slots?.length) return { serviceId: svc.id, start: r.body.slots[0].start as string };
    }
    throw new Error('no slot found in the next 20 days');
  }

  it('lets an anonymous visitor hold a slot, refuses a second hold, and audits both', async () => {
    const { serviceId, start } = await findSlot();
    const first = await request(app).post('/api/holds').send({ serviceId, start });
    expect(first.status).toBe(201);
    // X-ray has ONE room: the second hold must lose
    const second = await request(app).post('/api/holds').send({ serviceId, start });
    expect(second.status).toBe(409);

    const created = await auditRows({ action: 'CREATE', resourceType: 'appointment', resourceId: first.body.holdId, actorAccountId: null });
    expect(created.length).toBe(1);
    expect(created[0]!.actorRoles).toBeNull(); // anonymous
    const refused = await auditRows({ action: 'CREATE', resourceType: 'appointment', success: false });
    expect(refused.some((r) => (r.meta as any)?.status === 409)).toBe(true);
  });
});
