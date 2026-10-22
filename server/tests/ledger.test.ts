import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { app, auditRows, makeAccount, signInFully } from './helpers.js';
import { makePatient, post, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, providerLogin, saveSoap, URL, visit, type VisitOpts } from './phase4.js';
import { grantLot, makeCategory, makeMembership, makePlan } from './phase3.js';

/**
 * GET /api/fd/patients/:id/ledger — the patient ledger (lib/ledger.ts). One read-only view of a patient's visits and what they come to,
 * keyed by the patient alone, so it is the same from every way in. It posts nothing, and it shows no balance (no payments exist yet).
 *
 * "Today" is the clinic's calendar day (America/Chicago): the clock is pinned to Tuesday 2026-10-13, 10:07 local.
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const LEDGER = (id: string) => `/api/fd/patients/${id}/ledger`;
const get = (s: { agent: { get: (u: string) => Promise<request.Response> } }, id: string, qs = '') => s.agent.get(LEDGER(id) + qs);

/** A visit for `patientId` with a price ($55, 2 credits) of its own — Ben's adjustment, say. */
async function priced(o: VisitOpts & { patientId: string }, price: number | null = 5500, credits: number | null = 2) {
  const v = await visit(o);
  await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: price, creditCost: credits } });
  return v;
}
const at = (hhmm: string, date = '2026-10-13') => slotAt(hhmm, date);
const find = (body: any, bookingId: string) => [...body.todayVisits, ...body.priorVisits].find((v: any) => v.id === bookingId);

describe('what it shows for today', () => {
  // Rev 2.0 (was: the adjustment SEEN and "ready", the red light "waiting on provider"): check-out no longer waits for the note, so
  // both are ready, and each says where its note is instead — the adjustment's is pending, the red light needs none.
  it('Ben: an adjustment whose note is not written yet and a red light that needs none — both ready to check out, each with its note status', async () => {
    const ben = await makePatient({ firstName: 'Ben', lastName: 'Ledger' });
    const adjust = await priced({ patientId: ben.id, encounter: 'CHECKED_IN', start: at('09:00') });
    const light = await priced({ patientId: ben.id, encounter: 'CHECKED_IN', start: at('09:30'), staffRole: 'REGISTERED_NURSE', requiresNote: false });
    const fd = await frontDeskLogin();

    const r = await get(fd, ben.id);
    expect(r.status).toBe(200);
    expect(r.body.patient).toEqual({ id: ben.id, name: 'Ben Ledger' });
    expect(r.body.today).toBe('2026-10-13');
    expect(r.body.todayVisits.map((v: any) => v.id)).toEqual([adjust.booking.id, light.booking.id]);          // in time order

    const [a, l] = r.body.todayVisits;
    expect(a).toMatchObject({ state: 'ready_to_check_out', note: 'PENDING', service: adjust.service.name });
    expect(l).toMatchObject({ state: 'ready_to_check_out', note: 'NOT_REQUIRED', service: light.service.name });
    expect(l.provider).toMatch(/^T4 Staff /);
    for (const v of [a, l]) {
      expect(v).not.toHaveProperty('waitingOn');
      expect(v.charge).toMatchObject({ basis: 'projected', listPriceCents: 5500, discountPercent: 0, discountCents: 0, creditsApplied: null, creditCost: 2, netCents: 5500, priceKnown: true, paidWith: null });
    }
    expect(r.body.todayTotals.recorded).toEqual({ visits: 0, listPriceCents: 0, discountCents: 0, creditsApplied: 0, netCents: 0 });
    expect(r.body.todayTotals.pending).toEqual({ visits: 2, readyToCheckOut: 2, notArrived: 0, listPriceCents: 11000, discountCents: 0, cashNetCents: 11000, unpricedVisits: 0 });
    expect(r.body.todayTotals.notesPending).toBe(1);
    // no balance, no payments: nothing in the answer implies either exists
    expect(JSON.stringify(r.body).toLowerCase()).not.toMatch(/outstanding|balancedue|amountdue|owed/);
  });

  it('shows the tier discount on cash, and whether the credits would cover it', async () => {
    const { plan } = await makePlan({ credits: 6 });
    const p = await makePatient();
    const v = await priced({ patientId: p.id, encounter: 'SEEN', start: at('11:00') });
    await makeCategory({ serviceIds: [v.service.id], percents: { [plan.id]: 15 } });
    const m = await makeMembership(p.id, plan.code, '2026-10-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-13', now: TUESDAY_1007 });
    const fd = await frontDeskLogin();

    const r = (await get(fd, p.id)).body;
    expect(find(r, v.booking.id).charge).toMatchObject({ listPriceCents: 5500, discountPercent: 15, discountCents: 825, netCents: 4675, creditCost: 2, creditsAvailable: true });
    expect(r.todayTotals.pending).toMatchObject({ listPriceCents: 5500, discountCents: 825, cashNetCents: 4675 });
    expect(r.credits).toMatchObject({ balance: 6, redeemedToDate: 0, membership: { planName: plan.name, status: 'ACTIVE' } });
  });

  it('a visit with no set price is left out of the sums and counted, not priced at zero', async () => {
    const p = await makePatient();
    const priced1 = await priced({ patientId: p.id, encounter: 'SEEN', start: at('08:00') });
    const open = await priced({ patientId: p.id, encounter: 'SEEN', start: at('08:30') }, null, null);
    const r = (await get(await frontDeskLogin(), p.id)).body;
    expect(find(r, open.booking.id).charge).toMatchObject({ priceKnown: false, listPriceCents: null, netCents: null });
    expect(find(r, priced1.booking.id).charge.netCents).toBe(5500);
    expect(r.todayTotals.pending).toMatchObject({ cashNetCents: 5500, unpricedVisits: 1 });
  });

  it('after check-out the same visit shows what was RECORDED — how it was paid — and moves from the estimate to the recorded total', async () => {
    const p = await makePatient();
    const cash = await priced({ patientId: p.id, encounter: 'SEEN', start: at('09:00') });
    const rest = await priced({ patientId: p.id, encounter: 'SEEN', start: at('09:30') });
    const fd = await frontDeskLogin();
    expect((await post(fd, `/api/fd/appointments/${cash.booking.id}/check-out`, { payment: 'CASH' })).status).toBe(200);

    const r = (await get(fd, p.id)).body;
    expect(find(r, cash.booking.id)).toMatchObject({ state: 'checked_out', charge: { basis: 'recorded', listPriceCents: 5500, netCents: 5500, creditsApplied: 0, paidWith: 'CASH' } });
    expect(find(r, cash.booking.id).charge.recordedAt).toBe(TUESDAY_1007.toISOString());
    expect(r.todayTotals.recorded).toMatchObject({ visits: 1, listPriceCents: 5500, netCents: 5500 });
    expect(r.todayTotals.pending).toMatchObject({ visits: 1, readyToCheckOut: 1, cashNetCents: 5500 });
    expect(find(r, rest.booking.id).state).toBe('ready_to_check_out');
  });

  it('a visit paid with credits is recorded with the credits and a net of zero', async () => {
    const { plan } = await makePlan({ credits: 6 });
    const p = await makePatient();
    const v = await priced({ patientId: p.id, encounter: 'SEEN', start: at('10:00') });
    const m = await makeMembership(p.id, plan.code, '2026-10-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-13', now: TUESDAY_1007 });
    const fd = await frontDeskLogin();
    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/check-out`, { payment: 'CREDITS' })).status).toBe(200);

    const r = (await get(fd, p.id)).body;
    expect(find(r, v.booking.id).charge).toMatchObject({ basis: 'recorded', creditsApplied: 2, netCents: 0, paidWith: 'CREDITS', listPriceCents: 5500 });
    expect(r.credits).toMatchObject({ balance: 4, redeemedToDate: 2 });
    expect(r.todayTotals.recorded).toMatchObject({ visits: 1, creditsApplied: 2, netCents: 0 });
  });

  // Rev 2.0 (was: "waiting on provider becomes ready to check out the moment the note is signed"): it was ready all along.
  it('a checked-in visit is ready to check out before its note is signed; signing changes the note status, not whether it can be checked out', async () => {
    const prov = await providerLogin('PROVIDER_CHIRO');
    const p = await makePatient();
    const v = await visit({ staffId: prov.staff.id, doc: 'SOAP', patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    expect(find((await get(fd, p.id)).body, v.booking.id)).toMatchObject({ state: 'ready_to_check_out', note: 'PENDING' });

    const version = await saveSoap(prov, v.booking.id);
    expect(find((await get(fd, p.id)).body, v.booking.id)).toMatchObject({ state: 'ready_to_check_out', note: 'PENDING' });   // a draft is not a signature
    expect((await post(prov, URL.sign(v.booking.id), { version })).status).toBe(201);
    expect(find((await get(fd, p.id)).body, v.booking.id)).toMatchObject({ state: 'ready_to_check_out', note: 'SIGNED' });
  });

  it('lists a visit that has not arrived or was a no-show, without a charge for the no-show; leaves out cancelled and unapproved ones', async () => {
    const p = await makePatient();
    const later = await priced({ patientId: p.id, encounter: null, start: at('16:00') });
    const noShow = await priced({ patientId: p.id, encounter: 'NO_SHOW', start: at('08:00') });
    const cancelled = await priced({ patientId: p.id, encounter: null, start: at('12:00'), bookingStatus: 'CANCELLED' });
    const pending = await priced({ patientId: p.id, encounter: null, start: at('13:00'), bookingStatus: 'PENDING_REVIEW' });
    const r = (await get(await frontDeskLogin(), p.id)).body;
    expect(find(r, later.booking.id)).toMatchObject({ state: 'not_arrived', charge: { basis: 'projected', netCents: 5500 } });
    expect(find(r, noShow.booking.id)).toMatchObject({ state: 'no_show', charge: { basis: 'none', netCents: null } });
    expect(find(r, cancelled.booking.id)).toBeUndefined();
    expect(find(r, pending.booking.id)).toBeUndefined();
    expect(r.todayTotals.pending).toMatchObject({ visits: 1, notArrived: 1, cashNetCents: 5500 });     // the no-show is not a charge
  });
});

describe('earlier visits, credits and dues', () => {
  it('lists earlier visits newest first, with the amounts recorded at their check-out — and a SEEN one never checked out, with none', async () => {
    const p = await makePatient();
    const old = await priced({ patientId: p.id, encounter: 'CHECKED_IN', start: at('10:00', '2026-10-06') });
    const recent = await priced({ patientId: p.id, encounter: 'CHECKED_IN', start: at('10:00', '2026-10-12') });
    const unpaid = await priced({ patientId: p.id, encounter: 'SEEN', start: at('15:00', '2026-10-12') });
    const fd = await frontDeskLogin();
    for (const v of [old, recent]) expect((await post(fd, `/api/fd/appointments/${v.booking.id}/check-out`, { payment: 'CASH' })).status).toBe(200);

    const r = (await get(fd, p.id)).body;
    expect(r.todayVisits).toEqual([]);
    expect(r.priorVisits.map((v: any) => v.id)).toEqual([unpaid.booking.id, recent.booking.id, old.booking.id]);
    expect(r.priorVisits[1].charge).toMatchObject({ basis: 'recorded', listPriceCents: 5500, netCents: 5500, paidWith: 'CASH' });
    expect(r.priorVisits[0]).toMatchObject({ state: 'ready_to_check_out', charge: { basis: 'none', netCents: null } });   // needs check-out; no amount is invented
    expect(r.priorVisitsMore).toBe(false);
  });

  it('shows dues as information, newest first, and they are not part of any total', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 9900 });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-09-13');
    for (const [i, period] of ['2026-09-13', '2026-10-13'].entries()) {
      await basePrisma.revenueEvent.create({
        data: {
          patientId: p.id, serviceName: `${plan.name} membership dues`, serviceCategory: 'Membership', listPriceCents: 9900, paymentType: 'DUES', netPriceCents: 9900,
          planCode: plan.code, membershipId: m.id, periodStart: new Date(`${period}T00:00:00Z`), billingStatus: 'BILLED', occurredAt: new Date(Date.UTC(2026, 8 + i, 13, 5)), recordedById: 'system',
        },
      });
    }
    const r = (await get(await frontDeskLogin(), p.id)).body;
    expect(r.dues.map((d: any) => d.periodStart)).toEqual(['2026-10-13', '2026-09-13']);
    expect(r.dues[0]).toMatchObject({ listPriceCents: 9900, billingStatus: 'BILLED', description: `${plan.name} membership dues` });
    expect(r.todayTotals.pending.cashNetCents).toBe(0);
    expect(r.todayTotals.recorded.netCents).toBe(0);
  });

  it('scopes everything to the patient: another patient\'s visits, dues and credits never appear', async () => {
    const a = await makePatient(); const b = await makePatient();
    const mine = await priced({ patientId: a.id, encounter: 'SEEN', start: at('09:00') });
    const theirs = await priced({ patientId: b.id, encounter: 'SEEN', start: at('09:00') });
    const old = await priced({ patientId: b.id, encounter: 'SEEN', start: at('09:00', '2026-10-01') });
    const r = (await get(await frontDeskLogin(), a.id)).body;
    expect(r.todayVisits.map((v: any) => v.id)).toEqual([mine.booking.id]);
    expect(find(r, theirs.booking.id)).toBeUndefined();
    expect(find(r, old.booking.id)).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(b.id);
  });
});

describe('the same answer from every way in', () => {
  it('is identical from either of Ben\'s Checked-in cards, from patient search, from another desk and from an admin — and a stray booking id changes nothing', async () => {
    const ben = await makePatient({ firstName: 'Ben', lastName: 'Everywhere' });
    const one = await priced({ patientId: ben.id, encounter: 'CHECKED_IN', start: at('09:00') });
    const two = await priced({ patientId: ben.id, encounter: 'CHECKED_IN', start: at('09:30') });
    const deskA = await frontDeskLogin();
    const deskB = await frontDeskLogin();
    const admin = await adminLogin();

    // From each card in the Checked-in column: the card carries the patient id; that is the ONLY thing the ledger is asked.
    const dash = (await deskA.agent.get('/api/fd/dashboard?date=2026-10-13')).body.checkedIn as any[];
    const cards = [one, two].map((v) => dash.find((c) => c.id === v.booking.id));
    expect(cards.map((c) => c.patient.id)).toEqual([ben.id, ben.id]);
    const viaCards = await Promise.all(cards.map((c) => get(deskA, c.patient.id)));
    // From patient search.
    const search = await post(deskA, '/api/fd/patients/search', { q: 'Everywhere' });
    const found = (search.body.patients as any[]).find((x) => x.id === ben.id);
    expect(found).toBeTruthy();
    const viaSearch = await get(deskB, found.id);
    const viaAdmin = await get(admin, ben.id);
    const viaStray = await get(deskB, ben.id, `?bookingId=${two.booking.id}&date=2020-01-01&section=nope`);

    const bodies = [...viaCards, viaSearch, viaAdmin, viaStray].map((r) => { expect(r.status).toBe(200); return JSON.stringify(r.body); });
    expect(new Set(bodies).size).toBe(1);
  });

  it('is current: a check-out on one screen is in the next read on another', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, encounter: 'SEEN', start: at('09:00') });
    const deskA = await frontDeskLogin(); const deskB = await frontDeskLogin();
    expect(find((await get(deskB, p.id)).body, v.booking.id).state).toBe('ready_to_check_out');
    await post(deskA, `/api/fd/appointments/${v.booking.id}/check-out`, { payment: 'CASH' });
    expect(find((await get(deskB, p.id)).body, v.booking.id).state).toBe('checked_out');
  });
});

describe('access', () => {
  it('needs a front desk or admin sign-in; providers and anonymous callers are refused; unknown and deleted patients are 404', async () => {
    const p = await makePatient();
    expect((await request(app).get(LEDGER(p.id))).status).toBe(401);
    const prov = await providerLogin('PROVIDER_CHIRO');
    expect((await prov.agent.get(LEDGER(p.id))).status).toBe(403);
    const other = await signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
    expect((await other.agent.get(LEDGER(p.id))).status).toBe(200);
    expect((await (await adminLogin()).agent.get(LEDGER(p.id))).status).toBe(200);

    expect((await get(other, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get(other, 'not-a-uuid')).status).toBe(404);
    await basePrisma.patient.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    expect((await get(other, p.id)).status).toBe(404);
  });

  it('is GET only: nothing can be posted, patched or deleted at it', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    for (const m of ['post', 'put', 'patch', 'delete'] as const) expect((await (fd.agent as any)[m](LEDGER(p.id)).set('x-csrf-token', fd.csrf).send({})).status, m).toBe(404);
  });
});

describe('audit', () => {
  it('records a read of the patient and of their credit ledger — counts only — once per five minutes of viewing, not once per refresh', async () => {
    const p = await makePatient({ firstName: 'Audrey', lastName: 'Auditable' });
    await priced({ patientId: p.id, encounter: 'SEEN', start: at('09:00') });
    const fd = await frontDeskLogin();
    const actor = (await basePrisma.account.findFirstOrThrow({ where: { email: (fd.state as any).account.email } })).id;

    for (let i = 0; i < 4; i++) expect((await get(fd, p.id)).status).toBe(200);                 // the screen's 10-second refreshes
    const patientRows = await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'READ', actorAccountId: actor });
    const creditRows = await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'READ', actorAccountId: actor });
    expect(patientRows).toHaveLength(1);
    expect(creditRows).toHaveLength(1);
    expect(patientRows[0]!.meta).toEqual({ section: 'ledger', today: 1, prior: 0 });

    // another person's read is their own entry
    const second = await frontDeskLogin();
    const other = (await basePrisma.account.findFirstOrThrow({ where: { email: (second.state as any).account.email } })).id;
    await get(second, p.id);
    expect(await auditRows({ resourceType: 'patient', resourceId: p.id, action: 'READ', actorAccountId: other })).toHaveLength(1);
    // no names, prices or amounts in what was written
    const blob = JSON.stringify([...patientRows, ...creditRows], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(blob).not.toMatch(/Audrey|Auditable|5500|55\.00/);
  });

  it('writes nothing for a refused request beyond the access denial', async () => {
    const p = await makePatient();
    await request(app).get(LEDGER(p.id));
    expect(await basePrisma.auditLog.count({ where: { resourceType: 'patient', resourceId: p.id, action: 'READ' } })).toBe(0);
  });
});

describe('looking posts nothing', () => {
  it('changes no visit, revenue, credit, perk or membership row — and does not write expired credits down', async () => {
    const { plan } = await makePlan({ credits: 4 });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-05-01');
    // a lot whose last day has passed: the expiry JOB writes it down, never a read
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-05-01', rolloverDays: 30, now: new Date('2026-05-01T17:00:00Z') });
    const seen = await priced({ patientId: p.id, encounter: 'SEEN', start: at('09:00') });
    const waiting = await priced({ patientId: p.id, encounter: 'CHECKED_IN', start: at('09:30') });
    const fd = await frontDeskLogin();

    // Every count is this patient's own: audit rows are written AFTER a response is sent, so a global count can move under a test
    // because of some earlier request (the sign-in just above), not because of anything the ledger did.
    const snap = async () => ({
      revenue: await basePrisma.revenueEvent.count({ where: { patientId: p.id } }),
      credit: await basePrisma.creditLedger.count({ where: { patientId: p.id } }),
      alloc: await basePrisma.creditAllocation.count({ where: { ledger: { patientId: p.id } } }),
      perks: await basePrisma.perkUsage.count({ where: { membershipId: m.id } }),
      memberships: JSON.stringify(await basePrisma.membership.findUnique({ where: { id: m.id } })),
      encounters: JSON.stringify(await basePrisma.encounter.findMany({ where: { bookingId: { in: [seen.booking.id, waiting.booking.id] } }, orderBy: { bookingId: 'asc' } })),
      bookings: JSON.stringify(await basePrisma.booking.findMany({ where: { patientId: p.id }, orderBy: { id: 'asc' } })),
      patient: JSON.stringify(await basePrisma.patient.findUnique({ where: { id: p.id } })),
      writesAboutThem: await basePrisma.auditLog.count({ where: { resourceId: { in: [p.id, m.id, seen.booking.id, waiting.booking.id, seen.encounter!.id, waiting.encounter!.id] }, action: { not: 'READ' } } }),
    });
    const before = await snap();
    for (let i = 0; i < 3; i++) expect((await get(fd, p.id)).status).toBe(200);
    // the only audit rows about this patient are the two reads (once, however often it is refreshed)
    const reads = await auditRows({ resourceId: p.id, action: 'READ' }, 2);
    expect(await snap()).toEqual(before);
    expect(reads.map((r) => r.resourceType).sort()).toEqual(['credit_ledger', 'patient']);
  });
});

describe('"today" is the clinic\'s calendar day (America/Chicago)', () => {
  const ZONE = 'America/Chicago';
  const local = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toJSDate();

  it('the first and last minutes of the day are today; the minute before is earlier, and the minute after is neither', async () => {
    const p = await makePatient();
    const mk = (iso: string) => priced({ patientId: p.id, encounter: 'SEEN', start: local(iso) });
    const dayBefore = await mk('2026-10-12T23:59:00');
    const first = await mk('2026-10-13T00:00:00');
    const last = await mk('2026-10-13T23:59:00');
    const nextDay = await mk('2026-10-14T00:00:00');
    const r = (await get(await frontDeskLogin(), p.id)).body;
    expect(r.todayVisits.map((v: any) => v.id)).toEqual([first.booking.id, last.booking.id]);
    expect(r.priorVisits.map((v: any) => v.id)).toEqual([dayBefore.booking.id]);
    expect(find(r, nextDay.booking.id)).toBeUndefined();                                      // upcoming: not part of the ledger yet
    expect(first.booking.startTime.toISOString()).toBe('2026-10-13T05:00:00.000Z');          // CDT, UTC−5
  });

  it('a UTC date is not the clinic date: 23:30 Chicago is still today although it is already tomorrow in UTC', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, encounter: 'SEEN', start: local('2026-10-13T23:30:00') });
    expect(v.booking.startTime.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    expect(find((await get(await frontDeskLogin(), p.id)).body, v.booking.id).localDate).toBe('2026-10-13');
    expect(find((await get(await frontDeskLogin(), p.id)).body, v.booking.id)).toBeDefined();
  });

  describe('on the 25-hour day the clocks go back (2026-11-01)', () => {
    const FALL_BACK = new Date('2026-11-01T16:00:00Z');                                       // 10:00 CST
    beforeAll(() => setClockForTests(FALL_BACK));
    afterAll(() => setClockForTests(TUESDAY_1007));

    it('covers all 25 hours: 23:30 CST is today, 00:00 the next morning is not, and the day before ends at midnight CDT', async () => {
      const p = await makePatient();
      const mk = (iso: string) => priced({ patientId: p.id, encounter: 'SEEN', start: local(iso) });
      const before = await mk('2026-10-31T23:59:00');
      const early = await mk('2026-11-01T00:30:00');
      const lateNight = await mk('2026-11-01T23:30:00');         // 05:30Z next day — past a naive 24-hour window from 05:00Z
      const tomorrow = await mk('2026-11-02T00:00:00');
      const r = (await get(await frontDeskLogin(), p.id)).body;
      expect(r.today).toBe('2026-11-01');
      expect(r.todayVisits.map((v: any) => v.id)).toEqual([early.booking.id, lateNight.booking.id]);
      expect(r.priorVisits.map((v: any) => v.id)).toEqual([before.booking.id]);
      expect(find(r, tomorrow.booking.id)).toBeUndefined();
      expect(lateNight.booking.startTime.toISOString()).toBe('2026-11-02T05:30:00.000Z');
    });
  });
});
