import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { app, auditRows, blob } from './helpers.js';
import { del, patch } from './phase2.js';
import { adminLogin, frontDeskLogin, post, providerLogin } from './phase4.js';

const mine = async (p: Awaited<ReturnType<typeof providerLogin>>) => (await p.agent.get('/api/provider/macros')).body;
const addMine = (p: Awaited<ReturnType<typeof providerLogin>>, over: object = {}) =>
  post(p, '/api/provider/macros', { section: 'PLAN', title: 'Home stretching', body: 'Stretch twice daily.', ...over });

describe('access', () => {
  it('is closed to anonymous callers and the front desk, and a provider-only tool: an administrator with no provider role cannot use it', async () => {
    expect((await request(app).get('/api/provider/macros')).status).toBe(401);
    expect((await (await frontDeskLogin()).agent.get('/api/provider/macros')).status).toBe(403);
    const admin = await adminLogin();
    expect((await admin.agent.get('/api/provider/macros')).status).toBe(403);
    expect((await post(admin, '/api/provider/macros', { section: 'PLAN', title: 't', body: 'b' })).status).toBe(403);
  });

  it('keeps shared-set administration to administrators', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    for (const s of [p, fd]) {
      expect((await s.agent.get('/api/admin/macro-sets')).status).toBe(403);
      expect((await post(s, '/api/admin/macro-sets', { name: 'Mine' })).status).toBe(403);
    }
    expect((await (await adminLogin()).agent.get('/api/admin/macro-sets')).status).toBe(200);
  });
});

describe('a provider\'s own macros', () => {
  it('are saved text blocks per note section: add, list in section order, change, delete', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    expect((await mine(p)).personal.macros).toEqual([]);

    const plan = await addMine(p);
    expect(plan.status).toBe(201);
    const subj = await addMine(p, { section: 'SUBJECTIVE', title: 'Low back pain', body: 'Patient reports low back pain.' });
    const plan2 = await addMine(p, { title: 'Ice', body: 'Ice 20 minutes.' });

    const list = (await mine(p)).personal.macros;
    expect(list.map((m: any) => `${m.section}:${m.title}`)).toEqual(['SUBJECTIVE:Low back pain', 'PLAN:Home stretching', 'PLAN:Ice']);
    expect(list[1].sortOrder).toBeLessThan(list[2].sortOrder);

    const edited = await patch(p, `/api/provider/macros/${plan.body.macro.id}`, { title: 'Stretching', body: 'Stretch three times daily.' });
    expect(edited.body.macro).toMatchObject({ title: 'Stretching', body: 'Stretch three times daily.', section: 'PLAN' });
    const moved = await patch(p, `/api/provider/macros/${plan2.body.macro.id}`, { section: 'ASSESSMENT' });
    expect(moved.body.macro.section).toBe('ASSESSMENT');

    expect((await del(p, `/api/provider/macros/${subj.body.macro.id}`)).status).toBe(200);
    expect((await mine(p)).personal.macros.map((m: any) => m.title)).toEqual(['Ice', 'Stretching']);
  });

  it('keeps the text exactly as written — line breaks and all — and is offered for every section including the session-log notes', async () => {
    const p = await providerLogin('PROVIDER_NURSE');
    const body = 'Line one.\n\nLine two with  double  spaces.\n- bullet';
    for (const section of ['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL']) {
      const r = await addMine(p, { section, title: `T ${section}`, body });
      expect(r.status, section).toBe(201);
      expect(r.body.macro.body).toBe(body);
    }
  });

  it('are private: another provider cannot see, change or delete them', async () => {
    const a = await providerLogin('PROVIDER_CHIRO');
    const b = await providerLogin('PROVIDER_CHIRO');
    const m = (await addMine(a, { title: 'Only mine' })).body.macro;
    expect((await mine(b)).personal.macros).toEqual([]);
    expect((await patch(b, `/api/provider/macros/${m.id}`, { title: 'stolen' })).status).toBe(404);
    expect((await del(b, `/api/provider/macros/${m.id}`)).status).toBe(404);
    expect((await mine(a)).personal.macros[0].title).toBe('Only mine');
  });

  it('reuses one personal set per provider', async () => {
    const p = await providerLogin('PROVIDER_NP');
    await addMine(p); await addMine(p, { title: 'Second' });
    expect(await prisma.macroSet.count({ where: { scope: 'PERSONAL', ownerAccountId: p.accountId } })).toBe(1);
  });

  it('validates what is saved', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    for (const bad of [
      { section: 'NOPE' }, { section: 'plan' }, { title: '' }, { title: '   ' }, { title: 'x'.repeat(81) },
      { body: '' }, { body: '   \n ' }, { body: 'x'.repeat(4001) }, { extra: 1 },
    ]) {
      expect((await addMine(p, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await addMine(p, { body: 'x'.repeat(4000), title: 'x'.repeat(80) })).status).toBe(201);
    const m = (await addMine(p)).body.macro;
    for (const bad of [{}, { title: '' }, { body: '' }, { section: 'X' }, { owner: 'me' }]) {
      expect((await patch(p, `/api/provider/macros/${m.id}`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('stop at 200 per provider', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    await addMine(p);
    const set = await prisma.macroSet.findFirstOrThrow({ where: { scope: 'PERSONAL', ownerAccountId: p.accountId } });
    await prisma.macro.createMany({ data: Array.from({ length: 199 }, (_, i) => ({ setId: set.id, section: 'PLAN' as const, title: `m${i}`, body: 'b', sortOrder: i + 10 })) });
    const over = await addMine(p, { title: 'one too many' });
    expect([over.status, over.body.code]).toEqual([409, 'too_many']);
  });

  it('are audited when made, changed and deleted — by id and field name, never the text', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const m = (await addMine(p, { body: 'MACRO-SECRET-TEXT-991' })).body.macro;
    await patch(p, `/api/provider/macros/${m.id}`, { body: 'MACRO-SECRET-TEXT-992' });
    await del(p, `/api/provider/macros/${m.id}`);
    const rows = await auditRows({ resourceType: 'macro', resourceId: m.id }, 3);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    expect(rows.every((r) => r.actorAccountId === p.accountId)).toBe(true);
    expect(blob(rows)).toContain('"body"');
    expect(blob(rows)).not.toContain('MACRO-SECRET');
  });
});

describe('shared macro sets, defined by an administrator', () => {
  const sharedFor = async (p: Awaited<ReturnType<typeof providerLogin>>, name: string) =>
    (await mine(p)).shared.find((s: any) => s.name === name);

  it('are created with a name and the provider roles they are for, filled with macros, and offered to those providers', async () => {
    const admin = await adminLogin();
    const name = `Chiropractic starter ${Date.now()}`;
    const set = (await post(admin, '/api/admin/macro-sets', { name, roles: ['PROVIDER_CHIRO'] })).body.set;
    expect(set).toMatchObject({ name, roles: ['PROVIDER_CHIRO'], active: true, macros: [] });
    await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'SUBJECTIVE', title: 'Chief complaint', body: 'Chief complaint:' });
    await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'Follow up', body: 'Return in one week.' });

    const chiro = await providerLogin('PROVIDER_CHIRO');
    const np = await providerLogin('PROVIDER_NP');
    const seen = await sharedFor(chiro, name);
    expect(seen.macros.map((m: any) => m.title)).toEqual(['Chief complaint', 'Follow up']);
    expect(await sharedFor(np, name)).toBeUndefined();                                      // not for their role
    const listed = (await admin.agent.get('/api/admin/macro-sets')).body.sets.find((s: any) => s.id === set.id);
    expect(listed.macros).toHaveLength(2);
  });

  it('with no roles listed are offered to every provider role, and can be switched off', async () => {
    const admin = await adminLogin();
    const name = `Everyone ${Date.now()}`;
    const set = (await post(admin, '/api/admin/macro-sets', { name })).body.set;
    await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'p', body: 'b' });
    const providers = [await providerLogin('PROVIDER_CHIRO'), await providerLogin('PROVIDER_NP'), await providerLogin('PROVIDER_NURSE')];
    for (const p of providers) expect(await sharedFor(p, name), p.role).toBeDefined();

    expect((await patch(admin, `/api/admin/macro-sets/${set.id}`, { active: false })).body.set.active).toBe(false);
    for (const p of providers) expect(await sharedFor(p, name), p.role).toBeUndefined();
    await patch(admin, `/api/admin/macro-sets/${set.id}`, { active: true, roles: ['PROVIDER_NURSE', 'PROVIDER_NP'], name: `${name} (renamed)` });
    expect(await sharedFor(providers[0]!, `${name} (renamed)`)).toBeUndefined();
    expect(await sharedFor(providers[1]!, `${name} (renamed)`)).toBeDefined();
  });

  it('are read-only to providers: a shared macro cannot be changed or deleted through the personal routes', async () => {
    const admin = await adminLogin();
    const set = (await post(admin, '/api/admin/macro-sets', { name: `Locked ${Date.now()}` })).body.set;
    const m = (await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'x', body: 'y' })).body.macro;
    const p = await providerLogin('PROVIDER_CHIRO');
    expect((await patch(p, `/api/provider/macros/${m.id}`, { title: 'changed' })).status).toBe(404);
    expect((await del(p, `/api/provider/macros/${m.id}`)).status).toBe(404);
    expect((await prisma.macro.findUniqueOrThrow({ where: { id: m.id } })).title).toBe('x');
  });

  it('are edited and deleted by the administrator, a deleted set taking its macros with it', async () => {
    const admin = await adminLogin();
    const set = (await post(admin, '/api/admin/macro-sets', { name: `Edit me ${Date.now()}` })).body.set;
    const m = (await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'old', body: 'old body' })).body.macro;
    expect((await patch(admin, `/api/admin/macros/${m.id}`, { title: 'new', body: 'new body', section: 'ASSESSMENT' })).body.macro).toMatchObject({ title: 'new', body: 'new body', section: 'ASSESSMENT' });
    expect((await del(admin, `/api/admin/macros/${m.id}`)).status).toBe(200);
    const m2 = (await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'again', body: 'b' })).body.macro;
    expect((await del(admin, `/api/admin/macro-sets/${set.id}`)).status).toBe(200);
    expect(await prisma.macro.count({ where: { id: m2.id } })).toBe(0);
    expect((await del(admin, `/api/admin/macro-sets/${set.id}`)).status).toBe(404);
  });

  it('cannot be reached through a personal set\'s id, and a personal set is not an admin-managed one', async () => {
    const admin = await adminLogin();
    const p = await providerLogin('PROVIDER_CHIRO');
    const personal = (await addMine(p)).body.macro;
    const set = await prisma.macroSet.findFirstOrThrow({ where: { scope: 'PERSONAL', ownerAccountId: p.accountId } });
    expect((await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 't', body: 'b' })).status).toBe(404);
    expect((await patch(admin, `/api/admin/macro-sets/${set.id}`, { name: 'hijack' })).status).toBe(404);
    expect((await del(admin, `/api/admin/macro-sets/${set.id}`)).status).toBe(404);
    expect((await patch(admin, `/api/admin/macros/${personal.id}`, { title: 'hijack' })).status).toBe(404);
    expect((await del(admin, `/api/admin/macros/${personal.id}`)).status).toBe(404);
    expect((await admin.agent.get('/api/admin/macro-sets')).body.sets.map((s: any) => s.id)).not.toContain(set.id);
  });

  it('validate names, roles and macros, and stop at 200 macros a set', async () => {
    const admin = await adminLogin();
    for (const bad of [{}, { name: '' }, { name: 'x'.repeat(81) }, { name: 'ok', roles: ['ADMIN'] }, { name: 'ok', roles: ['PROVIDER_CHIRO', 'FRONT_DESK'] }, { name: 'ok', roles: 'PROVIDER_CHIRO' }, { name: 'ok', extra: 1 }]) {
      expect((await post(admin, '/api/admin/macro-sets', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const set = (await post(admin, '/api/admin/macro-sets', { name: `Full ${Date.now()}` })).body.set;
    for (const bad of [{}, { section: 'PLAN', title: '', body: 'b' }, { section: 'PLAN', title: 't', body: '' }, { section: 'X', title: 't', body: 'b' }]) {
      expect((await post(admin, `/api/admin/macro-sets/${set.id}/macros`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(admin, `/api/admin/macro-sets/${set.id}`, {})).status).toBe(400);
    expect((await patch(admin, `/api/admin/macro-sets/${set.id}`, { roles: ['NOPE'] })).status).toBe(400);
    expect((await post(admin, '/api/admin/macro-sets/nope/macros', { section: 'PLAN', title: 't', body: 'b' })).status).toBe(404);
    await prisma.macro.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ setId: set.id, section: 'PLAN' as const, title: `m${i}`, body: 'b', sortOrder: i })) });
    const over = await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 'extra', body: 'b' });
    expect([over.status, over.body.code]).toEqual([409, 'too_many']);
  });

  it('are audited, with the administrator as the actor', async () => {
    const admin = await adminLogin();
    const set = (await post(admin, '/api/admin/macro-sets', { name: `Audited ${Date.now()}`, roles: ['PROVIDER_NP'] })).body.set;
    await patch(admin, `/api/admin/macro-sets/${set.id}`, { active: false });
    const m = (await post(admin, `/api/admin/macro-sets/${set.id}/macros`, { section: 'PLAN', title: 't', body: 'SHARED-SECRET-55' })).body.macro;
    await del(admin, `/api/admin/macros/${m.id}`);
    await del(admin, `/api/admin/macro-sets/${set.id}`);
    const setRows = await auditRows({ resourceType: 'macro_set', resourceId: set.id }, 3);
    expect(setRows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
    const macroRows = await auditRows({ resourceType: 'macro', resourceId: m.id }, 2);
    expect(macroRows.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
    expect([...setRows, ...macroRows].every((r) => r.actorAccountId === admin.state.account.id)).toBe(true);
    expect(blob([...setRows, ...macroRows])).not.toContain('SHARED-SECRET');
  });
});

describe('the database keeps the sets honest', () => {
  it('refuses a personal set with no owner, a shared set with one, and a second personal set for the same owner', async () => {
    const p = await providerLogin('PROVIDER_CHIRO');
    const base = { name: 'x', createdByAccountId: p.accountId };
    await expect(basePrisma.macroSet.create({ data: { ...base, scope: 'PERSONAL' } })).rejects.toThrow();
    await expect(basePrisma.macroSet.create({ data: { ...base, scope: 'SHARED', ownerAccountId: p.accountId } })).rejects.toThrow();
    await basePrisma.macroSet.create({ data: { ...base, scope: 'PERSONAL', ownerAccountId: p.accountId } });
    await expect(basePrisma.macroSet.create({ data: { ...base, scope: 'PERSONAL', ownerAccountId: p.accountId } })).rejects.toThrow();
  });

  it('refuses an empty or oversize macro', async () => {
    const admin = await adminLogin();
    const set = (await post(admin, '/api/admin/macro-sets', { name: `Constraint ${Date.now()}` })).body.set;
    for (const bad of [{ title: '', body: 'b' }, { title: 't', body: '' }, { title: 'x'.repeat(81), body: 'b' }, { title: 't', body: 'x'.repeat(4001) }]) {
      await expect(basePrisma.macro.create({ data: { setId: set.id, section: 'PLAN', ...bad } })).rejects.toThrow();
    }
  });
});
