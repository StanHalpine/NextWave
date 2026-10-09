import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { runMembershipGrants } from '../src/jobs/credits.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { del, makeClinic, makePatient, patch, post, TUESDAY_1007 } from './phase2.js';
import { grantLot, ledgerSum, makeMembership, makePlan } from './phase3.js';

const TODAY = '2026-10-13';
beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
const adminLogin = async () => signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);
const credits = (s: any, id: string, q = '') => s.agent.get(`/api/fd/patients/${id}/credits${q}`);
const enroll = (s: any, id: string, planCode: string) => post(s, `/api/fd/patients/${id}/membership`, { planCode });

describe('access', () => {
  it('is closed to anonymous callers and providers; adjustment is admin only; writes need the CSRF token', async () => {
    const p = await makePatient();
    for (const [m, u] of [['get', `/api/fd/patients/${p.id}/credits`], ['post', `/api/fd/patients/${p.id}/membership`], ['post', `/api/fd/patients/${p.id}/credits/adjust`], ['get', '/api/membership-plans'], ['get', '/api/admin/membership-plans']] as const) {
      expect((await (request(app) as any)[m](u).send({})).status, u).toBe(401);
    }
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await credits(prov, p.id)).status).toBe(403);
    expect((await enroll(prov, p.id, 'PREVENT')).status).toBe(403);

    const fd = await fdLogin();
    expect((await post(fd, `/api/fd/patients/${p.id}/credits/adjust`, { amount: 1, reasonCode: 'goodwill' })).status).toBe(403);
    expect((await fd.agent.get('/api/admin/membership-plans')).status).toBe(403);
    expect((await fd.agent.post(`/api/fd/patients/${p.id}/membership`).send({ planCode: 'PREVENT' })).status).toBe(403);   // no CSRF token
    expect((await fd.agent.get('/api/membership-plans')).status).toBe(200);
  });
});

describe('enrolling', () => {
  it('lists the tiers, enrols a patient, grants the first month at once, and audits without values', async () => {
    const fd = await fdLogin();
    const plans = (await fd.agent.get('/api/membership-plans')).body.plans;
    expect(plans.slice(0, 3).map((x: any) => [x.code, x.creditsPerMonth, x.priceCents])).toEqual([['PREVENT', 4, 9900], ['RESTORE', 6, 19900], ['OPTIMIZE', 8, 29900]]);

    const p = await makePatient();
    const res = await enroll(fd, p.id, 'RESTORE');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ plan: 'Restore', firstGrant: 6, balance: 6 });

    const m = await prisma.membership.findFirstOrThrow({ where: { patientId: p.id } });
    expect(m).toMatchObject({ status: 'ACTIVE', createdById: fd.state.account.id });
    expect(m.startedOn.toISOString().slice(0, 10)).toBe(TODAY);
    expect(m.nextGrantOn.toISOString().slice(0, 10)).toBe('2026-11-13');
    expect(await ledgerSum(p.id)).toBe(6);

    expect(await auditRows({ resourceType: 'membership', resourceId: m.id, action: 'CREATE' })).toHaveLength(1);
    const ledgerAudit = await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'CREATE' });
    expect(ledgerAudit).toHaveLength(1);
    expect(blob(ledgerAudit)).not.toContain(p.lastName);
  });

  it('refuses a second membership, an unknown or inactive plan, an unknown or removed patient', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    expect((await enroll(fd, p.id, 'PREVENT')).status).toBe(201);
    const dup = await enroll(fd, p.id, 'OPTIMIZE');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('already_member');
    expect(await ledgerSum(p.id)).toBe(4);                                          // and nothing was granted by the refused attempt

    const q = await makePatient();
    expect((await enroll(fd, q.id, 'NOPE')).body.code).toBe('unknown_plan');
    const { plan } = await makePlan({ active: false });
    expect((await enroll(fd, q.id, plan.code)).status).toBe(400);
    expect((await enroll(fd, 'no-such-patient', 'PREVENT')).status).toBe(404);
    const gone = await makePatient();
    await prisma.patient.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect((await enroll(fd, gone.id, 'PREVENT')).status).toBe(404);
    expect((await post(fd, `/api/fd/patients/${q.id}/membership`, { planCode: 'PREVENT', extra: 1 })).status).toBe(400);
  });

  it('two simultaneous enrolments make one membership and grant once', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    const results = await Promise.all(Array.from({ length: 6 }, () => enroll(fd, p.id, 'PREVENT')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await prisma.membership.count({ where: { patientId: p.id } })).toBe(1);
    expect(await ledgerSum(p.id)).toBe(4);
  });
});

describe('the Credit Tracker read', () => {
  it('returns balance, lots with their dates, perks, and a history whose running total adds up', async () => {
    const fd = await fdLogin();
    const admin = await adminLogin();
    const p = await makePatient();
    await enroll(fd, p.id, 'PREVENT');
    expect((await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: 3, reasonCode: 'goodwill' })).status).toBe(200);
    expect((await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: -2, reasonCode: 'correction' })).status).toBe(200);

    const r = await credits(fd, p.id);
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe(5);
    expect(r.body.membership).toMatchObject({ status: 'ACTIVE', startedOn: TODAY, nextGrantOn: '2026-11-13', plan: { code: 'PREVENT', creditsPerMonth: 4 } });
    expect(r.body.lots.map((l: any) => [l.source, l.granted, l.remaining, l.status, l.expiresOn])).toEqual([
      ['MONTHLY_GRANT', 4, 2, 'ACTIVE', '2027-01-11'],                              // the 2 removed came from the OLDEST lot
      ['ADJUSTMENT', 3, 3, 'ACTIVE', '2027-01-11'],
    ]);
    const h = r.body.history.entries;
    expect(h.map((e: any) => [e.reason, e.delta, e.runningTotal])).toEqual([['ADJUSTMENT', -2, 5], ['ADJUSTMENT', 3, 7], ['MONTHLY_GRANT', 4, 4]]);   // newest first
    expect(h[0]).toMatchObject({ reasonCode: 'correction', by: 'Test Person', date: TODAY });
    expect(r.body.history.nextBefore).toBeNull();
    expect(r.body.expiringSoon).toBeNull();
    expect(await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'READ' })).toHaveLength(1);
  });

  it('pages a long history 50 at a time without losing or repeating a row', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2020-01-01');
    for (let i = 0; i < 55; i++) {
      await basePrisma.creditLedger.create({ data: { patientId: p.id, membershipId: m.id, reason: 'ADJUSTMENT', delta: 1, lotExpiresOn: new Date('2030-01-01'), reasonCode: 'other' } });
    }
    const first = (await credits(fd, p.id)).body.history;
    expect(first.entries).toHaveLength(50);
    expect(first.nextBefore).not.toBeNull();
    const second = (await credits(fd, p.id, `?before=${first.nextBefore}`)).body.history;
    expect(second.entries).toHaveLength(5);
    expect(second.nextBefore).toBeNull();
    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(55);
    expect(first.entries[0].runningTotal).toBe(55);
    expect(second.entries.at(-1).runningTotal).toBe(1);
    expect((await credits(fd, p.id, '?before=abc')).status).toBe(200);              // a malformed cursor is ignored, not an error
  });

  it('is a 404 for an unknown or removed patient', async () => {
    const fd = await fdLogin();
    expect((await credits(fd, 'nope')).status).toBe(404);
    const gone = await makePatient();
    await prisma.patient.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expect((await credits(fd, gone.id)).status).toBe(404);
  });

  it('shows a non-member an empty tracker', async () => {
    const fd = await fdLogin();
    const r = await credits(fd, (await makePatient()).id);
    expect(r.body).toMatchObject({ membership: null, balance: 0, lots: [], perks: [], expiringSoon: null });
  });
});

describe('pause, resume, change plan, cancel', () => {
  it('pause stops grants, resume restarts them from the next grant date without making up the gap', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    await enroll(fd, p.id, 'PREVENT');                                               // started 13 Oct; next grant 13 Nov
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'pause' })).body.status).toBe('PAUSED');
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'pause' })).status).toBe(409);

    await runMembershipGrants({ now: at('2026-11-13') });
    await runMembershipGrants({ now: at('2026-12-13') });
    expect(await ledgerSum(p.id)).toBe(4);                                           // nothing while paused

    setClockForTests(at('2026-12-20'));
    try {
      expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'resume' })).body.status).toBe('ACTIVE');
      const m = await prisma.membership.findFirstOrThrow({ where: { patientId: p.id } });
      expect(m.nextGrantOn.toISOString().slice(0, 10)).toBe('2027-01-13');           // Nov and Dec are NOT made up
      expect(await ledgerSum(p.id)).toBe(4);
      expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'resume' })).status).toBe(409);
    } finally { setClockForTests(TUESDAY_1007); }
    await runMembershipGrants({ now: at('2027-01-13') });
    expect(await ledgerSum(p.id)).toBe(8);
  });

  it('a plan change takes effect at the NEXT grant — nothing is granted or clawed back now', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    await enroll(fd, p.id, 'PREVENT');
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'change_plan', planCode: 'OPTIMIZE' })).body.changed).toBe(true);
    expect(await ledgerSum(p.id)).toBe(4);
    await runMembershipGrants({ now: at('2026-11-13') });
    expect(await ledgerSum(p.id)).toBe(4 + 8);
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'change_plan', planCode: 'OPTIMIZE' })).body.changed).toBe(false);
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'change_plan' })).status).toBe(400);
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'change_plan', planCode: 'NOPE' })).status).toBe(400);
    const log = await auditRows({ resourceType: 'membership', action: 'UPDATE' });
    expect(blob(log)).toContain('OPTIMIZE');
  });

  it('cancel stops new grants but leaves credits already granted spendable, and the patient can rejoin', async () => {
    const fd = await fdLogin();
    const p = await makePatient();
    await enroll(fd, p.id, 'RESTORE');
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'cancel' })).body.status).toBe('CANCELLED');
    await runMembershipGrants({ now: at('2026-11-13') });
    const r = await credits(fd, p.id);
    expect(r.body.membership).toBeNull();
    expect(r.body.balance).toBe(6);                                                  // existing lot runs out its rollover
    expect((await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'pause' })).body ?? {}).toMatchObject({ code: 'no_membership' });

    expect((await enroll(fd, p.id, 'PREVENT')).status).toBe(201);
    expect((await credits(fd, p.id)).body.balance).toBe(10);
  });

  it('answers 404 when there is no membership to change', async () => {
    const fd = await fdLogin();
    const r = await patch(fd, `/api/fd/patients/${(await makePatient()).id}/membership`, { action: 'cancel' });
    expect(r.status).toBe(404);
  });
});

describe('manual adjustment (admin only, with a reason code)', () => {
  it('adds a new lot, removes oldest-first, refuses to overdraw, and records the code and the person — never free text', async () => {
    const admin = await adminLogin();
    const p = await makePatient();
    const add = await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: 5, reasonCode: 'opening_balance' });
    expect(add.body).toEqual({ balanceBefore: 0, balanceAfter: 5 });
    const lot = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id } });
    expect(lot).toMatchObject({ reason: 'ADJUSTMENT', delta: 5, reasonCode: 'opening_balance', actorAccountId: admin.state.account.id });
    expect(lot.lotExpiresOn!.toISOString().slice(0, 10)).toBe('2027-01-11');         // 90 days from 13 Oct

    expect((await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: -3, reasonCode: 'correction' })).body).toEqual({ balanceBefore: 5, balanceAfter: 2 });
    const over = await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: -3, reasonCode: 'correction' });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('insufficient_credits');
    expect(await ledgerSum(p.id)).toBe(2);

    const rows = await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'CREATE' }, 2);
    expect(blob(rows)).toContain('opening_balance');
    expect(blob(rows)).not.toContain(p.lastName);
  });

  it('uses a member\'s own rollover period for the new lot', async () => {
    const admin = await adminLogin();
    const { plan } = await makePlan({ rolloverDays: 30 });
    const p = await makePatient();
    await prisma.membership.create({ data: { patientId: p.id, planId: plan.id, startedOn: new Date('2026-10-01'), nextGrantOn: new Date('2027-10-01'), createdById: admin.state.account.id } });
    await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, { amount: 2, reasonCode: 'goodwill' });
    expect((await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id } })).lotExpiresOn!.toISOString().slice(0, 10)).toBe('2026-11-12');
  });

  it('validates: a whole number other than zero, a code from the list, nothing extra', async () => {
    const admin = await adminLogin();
    const p = await makePatient();
    const bad = [
      { amount: 0, reasonCode: 'goodwill' }, { amount: 1.5, reasonCode: 'goodwill' }, { amount: 2000, reasonCode: 'goodwill' },
      { amount: 2, reasonCode: 'she was upset about her diagnosis' }, { amount: 2 }, { amount: 2, reasonCode: 'goodwill', note: 'free text' },
    ];
    for (const b of bad) expect((await post(admin, `/api/fd/patients/${p.id}/credits/adjust`, b)).status, JSON.stringify(b)).toBe(400);
    expect((await post(admin, '/api/fd/patients/nope/credits/adjust', { amount: 1, reasonCode: 'goodwill' })).status).toBe(404);
    expect(await ledgerSum(p.id)).toBe(0);
  });
});

describe('perks as entitlement counters', () => {
  async function setup(perk: { quantity: number; period?: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'; serviceIds?: string[]; active?: boolean }) {
    const { plan, perks } = await makePlan({ perks: [{ key: 'guest_pass', label: 'Guest passes', ...perk }] });
    const fd = await fdLogin();
    const p = await makePatient();
    expect((await enroll(fd, p.id, plan.code)).status).toBe(201);
    return { fd, p, plan, perk: perks[0]! };
  }
  const use = (s: any, patientId: string, perkId: string) => post(s, `/api/fd/patients/${patientId}/perks/${perkId}/use`);

  it('counts guest passes per quarter, refuses the extra one, and starts again in the next quarter', async () => {
    const { fd, p, perk } = await setup({ quantity: 2, period: 'QUARTERLY' });
    let r = await credits(fd, p.id);
    expect(r.body.perks).toEqual([expect.objectContaining({ label: 'Guest passes', quantity: 2, used: 0, remaining: 2, periodKey: '2026-Q4' })]);
    expect((await use(fd, p.id, perk.id)).body.remaining).toBe(1);
    expect((await use(fd, p.id, perk.id)).body.remaining).toBe(0);
    const third = await use(fd, p.id, perk.id);
    expect(third.status).toBe(409);
    expect(third.body.code).toBe('perk_used_up');
    expect((await credits(fd, p.id)).body.perks[0]).toMatchObject({ used: 2, remaining: 0 });

    setClockForTests(at('2027-01-05'));                                              // Q1 2027
    try {
      r = await credits(fd, p.id);
      expect(r.body.perks[0]).toMatchObject({ used: 0, remaining: 2, periodKey: '2027-Q1' });
      expect((await use(fd, p.id, perk.id)).status).toBe(200);
    } finally { setClockForTests(TUESDAY_1007); }
    expect(await basePrisma.perkUsage.count({ where: { patientId: p.id } })).toBe(3);
  });

  it('counts a monthly perk per calendar month', async () => {
    const { fd, p, perk } = await setup({ quantity: 1, period: 'MONTHLY' });
    expect((await use(fd, p.id, perk.id)).status).toBe(200);
    expect((await use(fd, p.id, perk.id)).status).toBe(409);
    setClockForTests(at('2026-11-02'));
    try { expect((await use(fd, p.id, perk.id)).status).toBe(200); } finally { setClockForTests(TUESDAY_1007); }
  });

  it('can never be over-used by simultaneous requests', async () => {
    const { fd, p, perk } = await setup({ quantity: 2, period: 'QUARTERLY' });
    const results = await Promise.all(Array.from({ length: 6 }, () => use(fd, p.id, perk.id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await basePrisma.perkUsage.count({ where: { patientId: p.id } })).toBe(2);
  });

  it('hides a perk that is switched off, and a perk that covers a service is used by checking that service out', async () => {
    const off = await setup({ quantity: 2, active: false });
    expect((await credits(off.fd, off.p.id)).body.perks).toEqual([]);
    expect((await use(off.fd, off.p.id, off.perk.id)).status).toBe(409);

    const clinic = await makeClinic();
    const tied = await setup({ quantity: 1, serviceIds: [clinic.service.id] });
    const r = await use(tied.fd, tied.p.id, tied.perk.id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('used_at_checkout');
  });

  it('is available only on an active membership of the plan that has it', async () => {
    const { fd, p, perk } = await setup({ quantity: 2, period: 'QUARTERLY' });
    await patch(fd, `/api/fd/patients/${p.id}/membership`, { action: 'pause' });
    expect((await use(fd, p.id, perk.id)).body.code).toBe('membership_not_active');
    const stranger = await makePatient();
    expect((await use(fd, stranger.id, perk.id)).status).toBe(404);
    const { fd: fd2, p: other } = await setup({ quantity: 1 });
    expect((await use(fd2, other.id, perk.id)).status).toBe(404);                    // another plan's perk
    void fd;
  });
});

describe('administering the tiers', () => {
  it('lists every tier with perks and member counts, and edits a tier — audited from → to, applying at the next grant', async () => {
    const admin = await adminLogin();
    const { plan } = await makePlan({ credits: 3, priceCents: 11100 });
    const fd = await fdLogin();
    const p = await makePatient();
    await enroll(fd, p.id, plan.code);
    expect(await ledgerSum(p.id)).toBe(3);

    const list = (await admin.agent.get('/api/admin/membership-plans')).body;
    const mine = list.plans.find((x: any) => x.id === plan.id);
    expect(mine).toMatchObject({ code: plan.code, creditsPerMonth: 3, priceCents: 11100, members: 1 });
    expect(list.plans.slice(0, 3).map((x: any) => x.code)).toEqual(['PREVENT', 'RESTORE', 'OPTIMIZE']);
    expect(list.services.length).toBeGreaterThan(5);

    const res = await patch(admin, `/api/admin/membership-plans/${plan.id}`, { creditsPerMonth: 7, priceCents: 15000, name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(await ledgerSum(p.id)).toBe(3);                                           // credits already granted are untouched
    await runMembershipGrants({ now: at('2026-11-13') });
    expect(await ledgerSum(p.id)).toBe(3 + 7);                                       // the next grant uses the new number

    const rows = await auditRows({ resourceType: 'membership_plan', resourceId: plan.id, action: 'UPDATE' });
    expect(blob(rows)).toContain('creditsPerMonth');
    expect(JSON.stringify(rows[0]!.meta)).toMatch(/"from":3/);
    expect(JSON.stringify(rows[0]!.meta)).toMatch(/"to":7/);
  });

  it('validates tier edits, and is admin only', async () => {
    const admin = await adminLogin();
    const fd = await fdLogin();
    const { plan } = await makePlan();
    for (const bad of [{ creditsPerMonth: -1 }, { creditsPerMonth: 1.5 }, { rolloverDays: 0 }, { priceCents: -5 }, { name: '' }, { code: 'X' }, {}]) {
      expect((await patch(admin, `/api/admin/membership-plans/${plan.id}`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(admin, '/api/admin/membership-plans/nope', { name: 'x' })).status).toBe(404);
    expect((await patch(fd, `/api/admin/membership-plans/${plan.id}`, { name: 'x' })).status).toBe(403);
  });

  it('switches a perk on, sets its quantity and the services it covers — audited — and refuses unknown services', async () => {
    const admin = await adminLogin();
    const clinic = await makeClinic();
    const { plan, perks } = await makePlan({ perks: [{ key: 'monthly_shot_or_iv', quantity: 1, active: false }] });
    const url = `/api/admin/membership-plans/${plan.id}/perks/${perks[0]!.id}`;
    const res = await patch(admin, url, { active: true, quantity: 3, serviceIds: [clinic.service.id] });
    expect(res.status).toBe(200);
    expect(res.body.perk).toMatchObject({ active: true, quantity: 3, serviceIds: [clinic.service.id] });
    expect(await prisma.planPerkService.count({ where: { perkId: perks[0]!.id } })).toBe(1);
    const rows = await auditRows({ resourceType: 'membership_plan', resourceId: plan.id, action: 'UPDATE' });
    expect(JSON.stringify(rows[0]!.meta)).toMatch(/"active":false/);
    expect(JSON.stringify(rows[0]!.meta)).toMatch(/"active":true/);

    expect((await patch(admin, url, { serviceIds: ['no-such-service'] })).status).toBe(400);
    expect((await patch(admin, url, { quantity: -1 })).status).toBe(400);
    expect((await patch(admin, `/api/admin/membership-plans/${plan.id}/perks/nope`, { active: false })).status).toBe(404);
    expect((await patch(admin, url, { serviceIds: [] })).status).toBe(200);
    expect(await prisma.planPerkService.count({ where: { perkId: perks[0]!.id } })).toBe(0);
  });
});

describe('price and credit cost on the admin services route', () => {
  it('sets and clears a credit cost, refuses nonsense, and audits price and credit-cost changes before → after', async () => {
    const admin = await adminLogin();
    const fd = await fdLogin();
    const { service } = await makeClinic();
    const url = `/api/admin/services/${service.id}`;

    expect((await patch(admin, url, { creditCost: 3, priceCents: 7000 })).status).toBe(200);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: service.id } })).toMatchObject({ creditCost: 3, priceCents: 7000 });
    expect((await admin.agent.get('/api/admin/services')).body.services.find((s: any) => s.id === service.id)).toMatchObject({ creditCost: 3, priceCents: 7000 });

    expect((await patch(admin, url, { creditCost: null })).status).toBe(200);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: service.id } })).creditCost).toBeNull();
    for (const bad of [{ creditCost: 0 }, { creditCost: -2 }, { creditCost: 2.5 }, { creditCost: 'two' }, { creditCost: 101 }]) {
      expect((await patch(admin, url, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(fd, url, { creditCost: 5 })).status).toBe(403);

    const rows = await auditRows({ resourceType: 'service', resourceId: service.id, action: 'UPDATE' }, 2);
    const meta = JSON.stringify(rows.map((r) => r.meta));
    expect(meta).toContain('creditCost');
    expect(meta).toContain('priceCents');
    void del; void grantLot;
  });
});
