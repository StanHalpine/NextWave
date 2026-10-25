import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DateTime } from 'luxon';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { balanceOf, chargesOf } from '../src/lib/money.js';
import { app, auditRows } from './helpers.js';
import { makePatient, post, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, providerLogin, visit, type VisitOpts } from './phase4.js';
import { grantLot, makeCategory, makeMembership, makePlan } from './phase3.js';

/**
 * The money layer (Phase 2b, rev 2.2) through its HTTP surface: combined check-out with payment, payments, reversals, account credit,
 * promotions and desk adjustments. docs/MONEY_LAYER_DESIGN.md §0 lists the owner's decisions these tests hold the code to.
 * The clock is Tuesday 2026-10-13, 10:07 in Chicago.
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));
afterEach(() => setClockForTests(TUESDAY_1007));

const key = () => `t${randomUUID().replace(/-/g, '')}`;
type S = Awaited<ReturnType<typeof frontDeskLogin>>;
const at = (hhmm: string, date = '2026-10-13') => slotAt(hhmm, date);
const local = (iso: string) => DateTime.fromISO(iso, { zone: 'America/Chicago' }).toJSDate();

async function ledger(s: S, patientId: string) {
  const r = await s.agent.get(`/api/fd/patients/${patientId}/ledger`);
  expect(r.status).toBe(200);
  return r.body;
}
async function checkout(s: S, patientId: string, body: Record<string, unknown>, version?: string) {
  const v = version ?? (await ledger(s, patientId)).money.version;
  return post(s, `/api/fd/patients/${patientId}/checkout`, { idempotencyKey: key(), expectedVersion: v, ...body });
}
async function payment(s: S, patientId: string, body: Record<string, unknown>) {
  const v = (await ledger(s, patientId)).money.version;
  return post(s, `/api/fd/patients/${patientId}/payments`, { idempotencyKey: key(), expectedVersion: v, ...body });
}
async function reverse(s: S, patientId: string, paymentId: string, body: Record<string, unknown> = { reason: 'ENTERED_IN_ERROR' }) {
  const v = (await ledger(s, patientId)).money.version;
  return post(s, `/api/fd/patients/${patientId}/payments/${paymentId}/reverse`, { idempotencyKey: key(), expectedVersion: v, ...body });
}

/** A checked-in visit for the patient, with a price (and credit cost) of its own service. */
async function priced(o: VisitOpts & { patientId: string }, price: number | null = 5500, credits: number | null = 2) {
  const v = await visit({ encounter: 'CHECKED_IN', ...o });
  await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: price, creditCost: credits } });
  return v;
}
const money = (b: { bookingId: string }, extra: Record<string, unknown> = {}) => ({ bookingId: b.bookingId, pay: 'MONEY', ...extra });
const ofV = (v: Awaited<ReturnType<typeof priced>>) => ({ bookingId: v.booking.id });
const encounter = (v: Awaited<ReturnType<typeof priced>>) => basePrisma.encounter.findUniqueOrThrow({ where: { bookingId: v.booking.id } });
const chargeOf = (v: Awaited<ReturnType<typeof priced>>) => basePrisma.revenueEvent.findFirstOrThrow({ where: { bookingId: v.booking.id } });
async function promo(serviceId: string, o: { kind?: 'PERCENT' | 'FIXED_CENTS'; value: number; startsOn?: string; endsOn?: string; active?: boolean; name?: string }) {
  return basePrisma.promotion.create({
    data: { name: o.name ?? 'Test promotion', kind: o.kind ?? 'PERCENT', value: o.value, startsOn: new Date(`${o.startsOn ?? '2026-10-01'}T00:00:00Z`),
      endsOn: new Date(`${o.endsOn ?? '2026-10-31'}T00:00:00Z`), active: o.active ?? true, createdById: 'test', services: { create: [{ serviceId }] } },
  });
}
/** The last posted line must equal the derived balance — the two are computed independently. */
function checkRunning(l: any) {
  const posted = l.money.posted as Array<{ amountCents: number; balanceAfterCents: number }>;
  const sum = posted.reduce((n, e) => n + e.amountCents, 0);
  expect(sum).toBe(l.money.balanceCents);
  expect(posted.length ? posted[posted.length - 1]!.balanceAfterCents : 0).toBe(l.money.balanceCents);
}

// =====================================================================================================================================

describe('combined check-out with a payment', () => {
  it('Ben: an adjustment and a red light, both checked out and paid in one go — one batch, one payment, oldest first, nothing owed', async () => {
    const ben = await makePatient({ firstName: 'Ben' });
    const adjust = await priced({ patientId: ben.id, start: at('09:00') });
    const light = await priced({ patientId: ben.id, start: at('09:30'), requiresNote: false });
    const fd = await frontDeskLogin();

    const r = await checkout(fd, ben.id, { visits: [money(ofV(light)), money(ofV(adjust))], payment: { tender: 'CASH', amountCents: 11000 } });
    expect(r.status).toBe(200);
    expect(r.body.visits.map((v: any) => v.bookingId)).toEqual([adjust.booking.id, light.booking.id]);       // oldest visit first
    expect(r.body.payment).toMatchObject({ tender: 'CASH', amountCents: 11000, collectedOn: '2026-10-13', refund: null, toAccountCreditCents: 0 });
    expect(r.body.payment.allocations.map((x: any) => x.cents)).toEqual([5500, 5500]);
    expect(r.body).toMatchObject({ balanceCents: 0, accountCreditCents: 0 });

    for (const v of [adjust, light]) expect((await encounter(v)).status).toBe('CHECKED_OUT');
    const charges = await basePrisma.revenueEvent.findMany({ where: { patientId: ben.id } });
    expect(new Set(charges.map((c) => c.batchId))).toEqual(new Set([r.body.batchId]));
    expect(await basePrisma.payment.count({ where: { patientId: ben.id } })).toBe(1);

    const l = await ledger(fd, ben.id);
    expect(l.money.balanceCents).toBe(0);
    checkRunning(l);
  });

  it('a check-out with no payment leaves the whole amount owed, on the Ledger\'s last line', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    expect((await checkout(fd, p.id, { visits: [money(ofV(v))] })).status).toBe(200);
    const l = await ledger(fd, p.id);
    expect(l.money.balanceCents).toBe(5500);
    expect(l.money.posted.at(-1)).toMatchObject({ kind: 'charge', amountCents: 5500, balanceAfterCents: 5500 });
    checkRunning(l);
  });

  it('a partial payment needs explicit confirmation — without it nothing at all is written', async () => {
    const p = await makePatient();
    const a = await priced({ patientId: p.id, start: at('09:00') });
    const b = await priced({ patientId: p.id, start: at('09:30') });
    const fd = await frontDeskLogin();
    const before = { re: await basePrisma.revenueEvent.count({ where: { patientId: p.id } }), pay: await basePrisma.payment.count({ where: { patientId: p.id } }) };

    const no = await checkout(fd, p.id, { visits: [money(ofV(a)), money(ofV(b))], payment: { tender: 'CARD', amountCents: 4000 } });
    expect([no.status, no.body.code, no.body.dueCents]).toEqual([400, 'partial_needs_confirmation', 11000]);
    expect(await basePrisma.revenueEvent.count({ where: { patientId: p.id } })).toBe(before.re);
    expect(await basePrisma.payment.count({ where: { patientId: p.id } })).toBe(before.pay);
    expect((await encounter(a)).status).toBe('CHECKED_IN');

    const yes = await checkout(fd, p.id, { visits: [money(ofV(a)), money(ofV(b))], payment: { tender: 'CARD', amountCents: 4000 }, confirmPartial: true });
    expect(yes.status).toBe(200);
    expect(yes.body.payment.allocations).toEqual([{ revenueEventId: (await chargeOf(a)).id, cents: 4000 }]);  // oldest charge first
    expect(yes.body.balanceCents).toBe(7000);
  });

  it('the rest carries forward, and a later payment settles the OLDEST charge first — across days', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    // Monday: a visit checked out, partly paid
    setClockForTests(local('2026-10-12T11:00:00'));
    const mon = await priced({ patientId: p.id, start: local('2026-10-12T10:00:00') });
    expect((await checkout(fd, p.id, { visits: [money(ofV(mon))], payment: { tender: 'CASH', amountCents: 2000 }, confirmPartial: true })).status).toBe(200);
    // Tuesday: another visit, and a payment that does not cover both
    setClockForTests(TUESDAY_1007);
    const tue = await priced({ patientId: p.id, start: at('09:00') });
    const r = await checkout(fd, p.id, { visits: [money(ofV(tue))], payment: { tender: 'CHECK', amountCents: 5000, reference: 'chk 1042' }, confirmPartial: true });
    expect(r.status).toBe(200);
    const monId = (await chargeOf(mon)).id; const tueId = (await chargeOf(tue)).id;
    expect(r.body.payment.allocations).toEqual([{ revenueEventId: monId, cents: 3500 }, { revenueEventId: tueId, cents: 1500 }]);
    expect(r.body.balanceCents).toBe(4000);
    // and a payment on its own (no visit) finishes it
    const last = await payment(fd, p.id, { payment: { tender: 'HSA_FSA', amountCents: 4000 } });
    expect(last.status).toBe(200);
    expect(last.body).toMatchObject({ batchId: null, visits: [], balanceCents: 0 });
    expect(last.body.payment.allocations).toEqual([{ revenueEventId: tueId, cents: 4000 }]);
    const l = await ledger(fd, p.id);
    checkRunning(l);
    // payments are shown on the day they were collected
    expect(l.money.posted.filter((e: any) => e.kind === 'payment').map((e: any) => e.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-13']);
  });

  it('every tender type is accepted; "Other" needs a note; nothing card-shaped is ever stored', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    for (const tender of ['CASH', 'CARD', 'CHECK', 'HSA_FSA']) {
      const v = await priced({ patientId: p.id, start: at('08:00') });
      expect((await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender, amountCents: 5500 } })).status, tender).toBe(200);
    }
    const v = await priced({ patientId: p.id, start: at('08:30') });
    expect((await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'OTHER', amountCents: 5500 } })).body.code).toBe('tender_note_required');
    expect((await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'CARD', amountCents: 5500, reference: '4242 4242 4242 4242' } })).body.code).toBe('card_number_refused');
    expect((await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'OTHER', amountCents: 5500, note: 'gift card 5555555555554444' } })).body.code).toBe('card_number_refused');
    const ok = await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'OTHER', amountCents: 5500, note: 'Venmo', reference: 'receipt 20261013-0042' } });
    expect(ok.status).toBe(200);
    expect(await basePrisma.payment.findUniqueOrThrow({ where: { id: ok.body.payment.id } })).toMatchObject({ tender: 'OTHER', note: 'Venmo', reference: 'receipt 20261013-0042' });
  });

  it('a visit paid with membership credits and one paid in money, together', async () => {
    const { plan } = await makePlan({ credits: 6 });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-10-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-13', now: TUESDAY_1007 });
    const a = await priced({ patientId: p.id, start: at('09:00') });
    const b = await priced({ patientId: p.id, start: at('09:30') });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [{ bookingId: a.booking.id, pay: 'CREDITS' }, money(ofV(b))], payment: { tender: 'CASH', amountCents: 5500 } });
    expect(r.status).toBe(200);
    expect(r.body.visits[0]).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, netPriceCents: 0 });
    expect(r.body.payment.allocations).toEqual([{ revenueEventId: (await chargeOf(b)).id, cents: 5500 }]);
    expect((await ledger(fd, p.id)).credits.balance).toBe(4);
  });
});

describe('overpayment: a refund or account credit — the patient\'s choice (decision 4)', () => {
  it('asks what to do with the difference, and writes nothing until told', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: 6000 } });
    expect([r.status, r.body.code, r.body.overCents]).toEqual([400, 'overpayment_choice_required', 500]);
    expect((await encounter(v)).status).toBe('CHECKED_IN');
  });

  it('REFUND: the difference goes back as a refund row with its tender; nothing is held on account', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'CARD', amountCents: 6000 }, overpayment: { as: 'REFUND', tender: 'CASH' } });
    expect(r.status).toBe(200);
    expect(r.body.payment.refund).toMatchObject({ tender: 'CASH', amountCents: 500 });
    expect(await basePrisma.refund.findUniqueOrThrow({ where: { id: r.body.payment.refund.id } })).toMatchObject({ source: 'OVERPAYMENT', paymentId: r.body.payment.id, amountCents: 500, tender: 'CASH' });
    expect(r.body).toMatchObject({ balanceCents: 0, accountCreditCents: 0 });
  });

  it('REFUND in "Other": allowed, with a note saying how — refused without one, whether chosen or carried over from the payment', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const go = (overpayment: Record<string, unknown>, payment: Record<string, unknown> = { tender: 'CASH', amountCents: 6000 }) =>
      checkout(fd, p.id, { visits: [money(ofV(v))], payment, overpayment });
    expect((await go({ as: 'REFUND', tender: 'OTHER' })).body.code).toBe('tender_note_required');
    expect((await go({ as: 'REFUND', tender: 'OTHER', note: '   ' })).body.code).toBe('tender_note_required');
    expect((await go({ as: 'REFUND' }, { tender: 'OTHER', amountCents: 6000, note: 'Venmo' })).body.code).toBe('tender_note_required');   // the payment's note is not the refund's
    expect((await go({ as: 'REFUND', tender: 'OTHER', note: '4242 4242 4242 4242' })).body.code).toBe('card_number_refused');
    const r = await go({ as: 'REFUND', tender: 'OTHER', note: ' Store gift card ' });
    expect(r.status).toBe(200);
    expect(await basePrisma.refund.findUniqueOrThrow({ where: { id: r.body.payment.refund.id } })).toMatchObject({ tender: 'OTHER', note: 'Store gift card', amountCents: 500 });
  });

  it('ACCOUNT CREDIT: the difference is held in dollars, applied later when the desk chooses — and never touches membership credits', async () => {
    const { plan } = await makePlan({ credits: 6 });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-10-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-13', now: TUESDAY_1007 });
    const first = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const membershipRows = () => basePrisma.creditLedger.count({ where: { patientId: p.id } });
    const rowsBefore = await membershipRows();

    const r = await checkout(fd, p.id, { visits: [money(ofV(first))], payment: { tender: 'CASH', amountCents: 8000 }, overpayment: { as: 'ACCOUNT_CREDIT' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ balanceCents: 0, accountCreditCents: 2500 });
    let l = await ledger(fd, p.id);
    expect(l.money.accountCreditCents).toBe(2500);          // "Account credit ($)"
    expect(l.credits.balance).toBe(6);                      // "Membership credits" — untouched
    expect(await membershipRows()).toBe(rowsBefore);

    // a later visit: the desk applies some of it, the patient pays the rest
    const second = await priced({ patientId: p.id, start: at('10:00') });
    const r2 = await checkout(fd, p.id, { visits: [money(ofV(second))], applyAccountCreditCents: 2000, payment: { tender: 'CASH', amountCents: 3500 } });
    expect(r2.status).toBe(200);
    expect(r2.body.accountCreditApplied).toEqual([{ revenueEventId: (await chargeOf(second)).id, cents: 2000 }]);
    expect(r2.body).toMatchObject({ balanceCents: 0, accountCreditCents: 500 });
    l = await ledger(fd, p.id);
    expect(l.credits.balance).toBe(6);
    expect(await membershipRows()).toBe(rowsBefore);
    expect(l.money.accountCredit.map((e: any) => [e.kind, e.deltaCents])).toEqual([['OVERPAYMENT', 2500], ['APPLIED', -2000]]);
    checkRunning(l);
    // the two never share a table: account credit is not in CreditLedger and membership credits are not in AccountCreditEntry
    expect(await basePrisma.accountCreditEntry.count({ where: { patientId: p.id } })).toBe(2);
    expect(await basePrisma.creditLedger.count({ where: { patientId: p.id, reason: { notIn: ['MONTHLY_GRANT'] } } })).toBe(0);
  });

  it('applying more account credit than the patient has is 409; more than is due is 400', async () => {
    const p = await makePatient();
    const a = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    expect((await checkout(fd, p.id, { visits: [money(ofV(a))], payment: { tender: 'CASH', amountCents: 6000 }, overpayment: { as: 'ACCOUNT_CREDIT' } })).status).toBe(200);
    const b = await priced({ patientId: p.id, start: at('09:30') }, 300, null);
    expect((await checkout(fd, p.id, { visits: [money(ofV(b))], applyAccountCreditCents: 501 })).body.code).toBe('account_credit_insufficient');
    expect((await checkout(fd, p.id, { visits: [money(ofV(b))], applyAccountCreditCents: 400 })).body.code).toBe('account_credit_exceeds_due');
  });

  it('only an admin (MFA) refunds account credit, as a refund row with its tender', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: 7000 }, overpayment: { as: 'ACCOUNT_CREDIT' } });
    const body = async (s: S) => ({ idempotencyKey: key(), expectedVersion: (await ledger(s, p.id)).money.version, amountCents: 1500, tender: 'CHECK' });
    const desk = await post(fd, `/api/fd/patients/${p.id}/account-credit/refund`, await body(fd));
    expect([desk.status, desk.body.code]).toEqual([403, 'admin_required']);
    const admin = await adminLogin();
    const ok = await post(admin, `/api/fd/patients/${p.id}/account-credit/refund`, await body(admin));
    expect(ok.status).toBe(200);
    expect(ok.body.accountCreditCents).toBe(0);
    expect(await basePrisma.refund.findUniqueOrThrow({ where: { id: ok.body.refundId } })).toMatchObject({ source: 'ACCOUNT_CREDIT', tender: 'CHECK', amountCents: 1500, paymentId: null });
    const again = await post(admin, `/api/fd/patients/${p.id}/account-credit/refund`, await body(admin));
    expect(again.body.code).toBe('account_credit_insufficient');
  });
});

describe('promotions (decisions 1 and 2) and desk adjustments (decision 3)', () => {
  async function member(percent: number) {
    const { plan } = await makePlan({ credits: 4 });
    const p = await makePatient();
    await makeMembership(p.id, plan.code, '2026-10-13');
    return { p, plan, percent };
  }

  it('the better of tier discount and promotion — the promotion when it is better, recorded without the tier discount', async () => {
    const { p, plan } = await member(10);
    const v = await priced({ patientId: p.id, start: at('09:00') });
    await makeCategory({ serviceIds: [v.service.id], percents: { [plan.id]: 10 } });
    await promo(v.service.id, { value: 20, name: 'Red light week' });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v), { expectedNetCents: 4400 })] });
    expect(r.status).toBe(200);
    expect(r.body.visits[0]).toMatchObject({ discountPercent: 0, discountCents: 0, promotion: { name: 'Red light week', cents: 1100 }, netPriceCents: 4400 });
    expect(await chargeOf(v)).toMatchObject({ discountCents: 0, promotionCents: 1100, netPriceCents: 4400 });
  });

  it('… and the tier discount when IT is better, with no promotion recorded — never both', async () => {
    const { p, plan } = await member(25);
    const v = await priced({ patientId: p.id, start: at('09:00') });
    await makeCategory({ serviceIds: [v.service.id], percents: { [plan.id]: 25 } });
    await promo(v.service.id, { value: 20 });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v))] });
    expect(r.body.visits[0]).toMatchObject({ discountPercent: 25, discountCents: 1375, promotion: null, netPriceCents: 4125 });
    expect(await chargeOf(v)).toMatchObject({ promotionId: null, promotionCents: 0, discountCents: 1375 });
  });

  it('a non-member gets the promotion; an inactive one, or one for another service, does nothing; two promotions never stack', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    await promo(v.service.id, { value: 10 });
    await promo(v.service.id, { kind: 'FIXED_CENTS', value: 1500 });
    await promo(v.service.id, { value: 50, active: false });
    const other = await priced({ patientId: p.id, start: at('09:30') });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v)), money(ofV(other))] });
    expect(r.body.visits[0]).toMatchObject({ promotion: { cents: 1500 }, netPriceCents: 4000 });   // the single best: $15 fixed beats 10%
    expect(r.body.visits[1]).toMatchObject({ promotion: null, netPriceCents: 5500 });
  });

  it('a promotion goes by the VISIT\'s clinic date: the last day\'s visit keeps it when checked out the next morning; the next day\'s visit does not get it', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    const lastDay = await priced({ patientId: p.id, start: local('2026-10-13T16:00:00') });
    const nextDay = await priced({ patientId: p.id, start: local('2026-10-14T09:00:00') });
    await promo(lastDay.service.id, { value: 20, endsOn: '2026-10-13' });
    await promo(nextDay.service.id, { value: 20, endsOn: '2026-10-13' });
    setClockForTests(local('2026-10-14T09:30:00'));
    const r = await checkout(fd, p.id, { visits: [money(ofV(lastDay)), money(ofV(nextDay))] });
    expect(r.status).toBe(200);
    expect(r.body.visits.map((v: any) => v.promotion?.cents ?? 0)).toEqual([1100, 0]);
  });

  it('Chicago time at the edges: 23:30 on the last day is in (already tomorrow in UTC), 00:15 the next day is out; the first day starts at local midnight', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    const mk = async (iso: string) => { const v = await priced({ patientId: p.id, start: local(iso) }); await promo(v.service.id, { value: 20, startsOn: '2026-10-13', endsOn: '2026-10-13' }); return v; };
    const late = await mk('2026-10-13T23:30:00');
    const after = await mk('2026-10-14T00:15:00');
    const before = await mk('2026-10-12T23:45:00');
    const first = await mk('2026-10-13T00:00:00');
    expect(late.booking.startTime.toISOString()).toBe('2026-10-14T04:30:00.000Z');
    setClockForTests(local('2026-10-14T10:00:00'));
    const r = await checkout(fd, p.id, { visits: [late, after, before, first].map((v) => money(ofV(v))) });
    expect(r.status).toBe(200);
    const by = new Map(r.body.visits.map((v: any) => [v.bookingId, v.promotion?.cents ?? 0]));
    expect([by.get(before.booking.id), by.get(first.booking.id), by.get(late.booking.id), by.get(after.booking.id)]).toEqual([0, 1100, 1100, 0]);
  });

  it('across the fall-back night (2026-11-01, 25 hours): 23:30 CST on the last day is in, 00:30 on Nov 2 is out', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    const mk = async (iso: string) => { const v = await priced({ patientId: p.id, start: local(iso) }); await promo(v.service.id, { value: 20, startsOn: '2026-11-01', endsOn: '2026-11-01' }); return v; };
    const early = await mk('2026-11-01T01:30:00');
    const late = await mk('2026-11-01T23:30:00');
    const next = await mk('2026-11-02T00:30:00');
    expect(late.booking.startTime.toISOString()).toBe('2026-11-02T05:30:00.000Z');
    setClockForTests(local('2026-11-02T10:00:00'));
    const r = await checkout(fd, p.id, { visits: [early, late, next].map((v) => money(ofV(v))) });
    expect(r.status).toBe(200);
    const by = new Map(r.body.visits.map((v: any) => [v.bookingId, v.promotion?.cents ?? 0]));
    expect([by.get(early.booking.id), by.get(late.booking.id), by.get(next.booking.id)]).toEqual([1100, 1100, 0]);
  });

  it('the desk adjustment cap, at the boundary: $55 list → $11.00 allowed, $11.01 refused (an admin may); $200 list → $25.00 allowed, $25.01 refused', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient();
    const adj = (cents: number, reason = 'SERVICE_RECOVERY') => ({ adjustment: { cents, reason } });

    const a = await priced({ patientId: p.id, start: at('08:00') });
    const over = await checkout(fd, p.id, { visits: [money(ofV(a), adj(1101))] });
    expect([over.status, over.body.code, over.body.capCents]).toEqual([403, 'adjustment_needs_admin', 1100]);
    expect((await encounter(a)).status).toBe('CHECKED_IN');
    expect((await checkout(fd, p.id, { visits: [money(ofV(a), adj(1100))] })).body.visits[0]).toMatchObject({ adjustmentCents: 1100, netPriceCents: 4400 });

    const b = await priced({ patientId: p.id, start: at('08:30') }, 20000);
    expect((await checkout(fd, p.id, { visits: [money(ofV(b), adj(2501))] })).body.code).toBe('adjustment_needs_admin');
    expect((await checkout(fd, p.id, { visits: [money(ofV(b), adj(2500))] })).body.visits[0]).toMatchObject({ adjustmentCents: 2500, netPriceCents: 17500 });

    const c = await priced({ patientId: p.id, start: at('09:00') }, 20000);
    const big = await checkout(admin, p.id, { visits: [money(ofV(c), adj(4000, 'BILLING_ERROR'))] });
    expect(big.status).toBe(200);
    expect(await chargeOf(c)).toMatchObject({ adjustmentCents: 4000, adjustmentReason: 'BILLING_ERROR', netPriceCents: 16000 });
  });

  it('an adjustment needs a reason (Other needs a note), never takes a visit below zero, and is not for a credit-paid visit', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') }, 1000);
    expect((await checkout(fd, p.id, { visits: [money(ofV(v), { adjustment: { cents: 100 } })] })).status).toBe(400);                         // no reason
    expect((await checkout(fd, p.id, { visits: [money(ofV(v), { adjustment: { cents: 100, reason: 'OTHER' } })] })).body.code).toBe('adjustment_note_required');
    expect((await checkout(admin, p.id, { visits: [money(ofV(v), { adjustment: { cents: 1001, reason: 'COURTESY' } })] })).body.code).toBe('adjustment_too_large');
    expect((await checkout(fd, p.id, { visits: [{ bookingId: v.booking.id, pay: 'CREDITS', adjustment: { cents: 100, reason: 'COURTESY' } }] })).body.code).toBe('adjustment_only_for_money');
    const ok = await checkout(fd, p.id, { visits: [money(ofV(v), { adjustment: { cents: 200, reason: 'OTHER', note: 'long wait' } })] });
    expect(ok.status).toBe(200);
    expect(await chargeOf(v)).toMatchObject({ adjustmentNote: 'long wait', adjustmentReason: 'OTHER' });
  });

  it('a promotion and an adjustment on the same visit: net = list − promotion − adjustment; the cap is still 20% of LIST', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    await promo(v.service.id, { value: 20 });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v), { adjustment: { cents: 1100, reason: 'COURTESY' } })] });
    expect(r.body.visits[0]).toMatchObject({ promotion: { cents: 1100 }, adjustmentCents: 1100, netPriceCents: 3300 });
  });
});

describe('reversing a payment (decision 6)', () => {
  async function paid(fd: S, amount = 5500, over: Record<string, unknown> = {}) {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const r = await checkout(fd, p.id, { visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: amount }, ...over });
    expect(r.status).toBe(200);
    return { p, v, paymentId: r.body.payment.id as string };
  }

  it('the front desk may reverse it the same clinic day: the payment stays, marked, and exactly what it paid is owed again', async () => {
    const fd = await frontDeskLogin();
    const { p, paymentId } = await paid(fd);
    const r = await reverse(fd, p.id, paymentId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paymentId, reversedOn: '2026-10-13', balanceCents: 5500 });
    expect(await basePrisma.payment.findUnique({ where: { id: paymentId } })).not.toBeNull();
    const l = await ledger(fd, p.id);
    expect(l.money.posted.find((e: any) => e.kind === 'payment')).toMatchObject({ reversed: true, reversibleByDesk: false });
    expect(l.money.posted.at(-1)).toMatchObject({ kind: 'reversal', amountCents: 5500, balanceAfterCents: 5500 });
    checkRunning(l);
    expect((await reverse(fd, p.id, paymentId)).body.code).toBe('already_reversed');
  });

  it('the next day only an admin may — the desk gets 403', async () => {
    const fd = await frontDeskLogin();
    const { p, paymentId } = await paid(fd);
    setClockForTests(local('2026-10-14T08:00:00'));
    const desk = await reverse(fd, p.id, paymentId);
    expect([desk.status, desk.body.code]).toEqual([403, 'reversal_needs_admin']);
    const admin = await adminLogin();
    expect((await reverse(admin, p.id, paymentId)).status).toBe(200);
  });

  it('"the same clinic day" is Chicago\'s: 23:50 is still the day of a payment taken that morning; 00:05 is the next day', async () => {
    const fd = await frontDeskLogin();
    const a = await paid(fd);
    setClockForTests(local('2026-10-13T23:50:00'));
    expect((await reverse(fd, a.p.id, a.paymentId)).status).toBe(200);
    setClockForTests(TUESDAY_1007);
    const b = await paid(fd);
    setClockForTests(local('2026-10-14T00:05:00'));
    expect((await reverse(fd, b.p.id, b.paymentId)).body.code).toBe('reversal_needs_admin');
  });

  it('reversing takes back the account credit the payment created — refused if it has been used; refused if the overpayment was refunded', async () => {
    const fd = await frontDeskLogin();
    const credited = await paid(fd, 7000, { overpayment: { as: 'ACCOUNT_CREDIT' } });
    const ok = await reverse(fd, credited.p.id, credited.paymentId);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ accountCreditCents: 0, balanceCents: 5500 });

    const used = await paid(fd, 7000, { overpayment: { as: 'ACCOUNT_CREDIT' } });
    const next = await priced({ patientId: used.p.id, start: at('10:00') });
    await checkout(fd, used.p.id, { visits: [money(ofV(next))], applyAccountCreditCents: 1500, confirmPartial: true });
    expect((await reverse(fd, used.p.id, used.paymentId)).body.code).toBe('account_credit_used');

    const refunded = await paid(fd, 7000, { overpayment: { as: 'REFUND' } });
    expect((await reverse(fd, refunded.p.id, refunded.paymentId)).body.code).toBe('payment_refunded');
  });

  it('a reversal needs a reason; Other needs a note', async () => {
    const fd = await frontDeskLogin();
    const { p, paymentId } = await paid(fd);
    expect((await reverse(fd, p.id, paymentId, {})).status).toBe(400);
    expect((await reverse(fd, p.id, paymentId, { reason: 'OTHER' })).body.code).toBe('reversal_note_required');
    expect((await reverse(fd, p.id, paymentId, { reason: 'OTHER', note: 'wrong patient' })).status).toBe(200);
  });
});

describe('one request, once: idempotency and 409 on a concurrent change', () => {
  it('a double click — the same key, twice at once — records one payment and returns the same answer to both', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const body = { idempotencyKey: key(), expectedVersion: (await ledger(fd, p.id)).money.version, visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: 5500 } };
    const [a, b] = await Promise.all([post(fd, `/api/fd/patients/${p.id}/checkout`, body), post(fd, `/api/fd/patients/${p.id}/checkout`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(await basePrisma.payment.count({ where: { patientId: p.id } })).toBe(1);
    expect(await basePrisma.checkoutBatch.count({ where: { patientId: p.id } })).toBe(1);
  });

  it('a retry after success returns the recorded answer; the same key with a different body is refused', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const body = { idempotencyKey: key(), expectedVersion: (await ledger(fd, p.id)).money.version, visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: 5500 } };
    const first = await post(fd, `/api/fd/patients/${p.id}/checkout`, body);
    const retry = await post(fd, `/api/fd/patients/${p.id}/checkout`, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const changed = await post(fd, `/api/fd/patients/${p.id}/checkout`, { ...body, payment: { tender: 'CASH', amountCents: 5000 }, confirmPartial: true });
    expect([changed.status, changed.body.code]).toEqual([409, 'idempotency_key_reused']);
    expect(await basePrisma.payment.count({ where: { patientId: p.id } })).toBe(1);
  });

  it('two desks check out the same patient at once from the same screen: one wins, the other gets 409 with the fresh Ledger; one payment', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const deskA = await frontDeskLogin(); const deskB = await frontDeskLogin();
    const version = (await ledger(deskA, p.id)).money.version;
    const [a, b] = await Promise.all([
      checkout(deskA, p.id, { visits: [money(ofV(v))], payment: { tender: 'CASH', amountCents: 5500 } }, version),
      checkout(deskB, p.id, { visits: [money(ofV(v))], payment: { tender: 'CARD', amountCents: 5500 } }, version),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const lost = a.status === 409 ? a : b;
    expect(['ledger_changed', 'already_checked_out']).toContain(lost.body.code);
    expect(lost.body.ledger.money.balanceCents).toBe(0);
    expect(lost.body.ledger.todayVisits.find((x: any) => x.id === v.booking.id).state).toBe('checked_out');
    expect(await basePrisma.payment.count({ where: { patientId: p.id } })).toBe(1);
  });

  it('a stale screen is refused with 409 ledger_changed and the fresh state — nothing written', async () => {
    const p = await makePatient();
    const a = await priced({ patientId: p.id, start: at('09:00') });
    const b = await priced({ patientId: p.id, start: at('09:30') });
    const fd = await frontDeskLogin();
    const stale = (await ledger(fd, p.id)).money.version;
    await checkout(fd, p.id, { visits: [money(ofV(a))] });                          // someone else checks out visit a
    const r = await checkout(fd, p.id, { visits: [money(ofV(b))], payment: { tender: 'CASH', amountCents: 5500 } }, stale);
    expect([r.status, r.body.code]).toEqual([409, 'ledger_changed']);
    expect(r.body.ledger.money.balanceCents).toBe(5500);
    expect(r.body.version).toBe(r.body.ledger.money.version);
    expect((await encounter(b)).status).toBe('CHECKED_IN');
    expect(await basePrisma.payment.count({ where: { patientId: p.id } })).toBe(0);
  });
});

describe('scoping, access and audit', () => {
  it('a visit of another patient, or one not checked in, or already checked out, is refused', async () => {
    const p = await makePatient(); const other = await makePatient();
    const theirs = await priced({ patientId: other.id, start: at('09:00') });
    const notIn = await priced({ patientId: p.id, start: at('09:30'), encounter: null });
    const fd = await frontDeskLogin();
    expect((await checkout(fd, p.id, { visits: [money(ofV(theirs))] })).status).toBe(404);
    expect((await checkout(fd, p.id, { visits: [money(ofV(notIn))] })).body.code).toBe('not_checked_in');
    const mine = await priced({ patientId: p.id, start: at('10:00') });
    await checkout(fd, p.id, { visits: [money(ofV(mine))] });
    expect((await checkout(fd, p.id, { visits: [money(ofV(mine))] })).body.code).toBe('already_checked_out');
    // a reversal of another patient's payment is unknown
    const pr = await checkout(fd, other.id, { visits: [money(ofV(theirs))], payment: { tender: 'CASH', amountCents: 5500 } });
    expect((await reverse(fd, p.id, pr.body.payment.id)).status).toBe(404);
  });

  it('front desk and admin only; providers and anonymous callers are refused', async () => {
    const p = await makePatient();
    expect((await request(app).post(`/api/fd/patients/${p.id}/checkout`).send({})).status).toBe(401);
    const prov = await providerLogin('PROVIDER_CHIRO');
    expect((await post(prov, `/api/fd/patients/${p.id}/payments`, { idempotencyKey: key(), expectedVersion: 'v:x', payment: { tender: 'CASH', amountCents: 100 } })).status).toBe(403);
  });

  it('audit rows name ids, codes and counts — never an amount, a note or a name', async () => {
    const p = await makePatient({ firstName: 'Audra', lastName: 'Moneyless' });
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    const r = await checkout(fd, p.id, { visits: [money(ofV(v), { adjustment: { cents: 750, reason: 'OTHER', note: 'secret reason text' } })], payment: { tender: 'CASH', amountCents: 9999 }, overpayment: { as: 'ACCOUNT_CREDIT' } });
    expect(r.status).toBe(200);
    await reverse(fd, p.id, r.body.payment.id);
    const rows = await auditRows({ resourceType: { in: ['payment', 'checkout_batch', 'account_credit', 'payment_reversal', 'refund', 'revenue_event'] } }, 1);
    const mine = rows.filter((x) => [r.body.payment.id, r.body.batchId, p.id, (r.body.visits[0].revenueEventId as string)].includes(String(x.resourceId)) || JSON.stringify(x.meta).includes(r.body.payment.id));
    expect(mine.length).toBeGreaterThanOrEqual(4);
    const blob = JSON.stringify(mine.map((x) => x.meta));
    for (const s of ['4750', '9999', '5249', '750', 'secret', 'Audra', 'Moneyless', 'Cents"']) expect(blob, s).not.toContain(s);
  });
});

describe('charges from before payments were tracked (decision 7)', () => {
  it('a charge with a settlement row is owed nothing and cannot be paid; the Ledger shows it settled', async () => {
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const fd = await frontDeskLogin();
    expect((await checkout(fd, p.id, { visits: [money(ofV(v))] })).status).toBe(200);
    // what the migration does for every charge that exists when it runs
    await basePrisma.preTrackingSettlement.create({ data: { revenueEventId: (await chargeOf(v)).id } });
    expect(await balanceOf(basePrisma, p.id)).toBe(0);
    const l = await ledger(fd, p.id);
    expect(l.money.posted.map((e: any) => [e.kind, e.amountCents])).toEqual([['charge', 5500], ['settled_before_tracking', -5500]]);
    checkRunning(l);
    // nothing is due, so money paid now is all overpayment
    const r = await payment(fd, p.id, { payment: { tender: 'CASH', amountCents: 100 } });
    expect(r.body.code).toBe('overpayment_choice_required');
  });
});

describe('the balance is always the sum of the rows', () => {
  it('after charges, partial payments, account credit, a refund and a reversal, three independent computations agree', async () => {
    const p = await makePatient();
    const fd = await frontDeskLogin();
    const a = await priced({ patientId: p.id, start: at('08:00') }, 5500);
    const b = await priced({ patientId: p.id, start: at('08:30') }, 11000);
    const c = await priced({ patientId: p.id, start: at('09:00') }, 4000);
    await checkout(fd, p.id, { visits: [money(ofV(a))], payment: { tender: 'CASH', amountCents: 2000 }, confirmPartial: true });
    const second = await checkout(fd, p.id, { visits: [money(ofV(b))], payment: { tender: 'CARD', amountCents: 20000 }, overpayment: { as: 'ACCOUNT_CREDIT' } });
    await checkout(fd, p.id, { visits: [money(ofV(c))], applyAccountCreditCents: 1000, payment: { tender: 'CASH', amountCents: 500 }, confirmPartial: true });
    await reverse(fd, p.id, (await basePrisma.payment.findFirstOrThrow({ where: { patientId: p.id, amountCents: 2000 } })).id);
    await payment(fd, p.id, { payment: { tender: 'CHECK', amountCents: 3000 }, confirmPartial: true });
    expect(second.status).toBe(200);

    // 1. the derived balance; 2. the Ledger's running total; 3. straight from the tables
    const derived = await balanceOf(basePrisma, p.id);
    const l = await ledger(fd, p.id);
    checkRunning(l);
    const charges = await basePrisma.revenueEvent.aggregate({ where: { patientId: p.id, paymentType: { not: 'DUES' } }, _sum: { netPriceCents: true } });
    const allocs = await basePrisma.paymentAllocation.aggregate({ where: { payment: { patientId: p.id, reversal: null } }, _sum: { amountCents: true } });
    const applied = await basePrisma.accountCreditEntry.aggregate({ where: { patientId: p.id, kind: 'APPLIED' }, _sum: { deltaCents: true } });
    const fromTables = (charges._sum.netPriceCents ?? 0) - (allocs._sum.amountCents ?? 0) + (applied._sum.deltaCents ?? 0);
    expect(derived).toBe(fromTables);
    expect(l.money.balanceCents).toBe(derived);
    // Billed 5500 + 11000 + 4000. The card's 20000 paid the OLDEST first — a's remaining 3500, then b's 11000 — and 5500 went to account
    // credit. c: 1000 of that credit + 500 cash. The 2000 cash on a was reversed (a owes 2000 again). The cheque's 3000: a's 2000, then
    // 1000 of c. Owed: c's 1500.
    expect(derived).toBe(1500);
    // account credit: +5500 from the overpayment, −1000 applied
    expect(l.money.accountCreditCents).toBe(4500);
    // per charge, never below zero and never more than it owes (its net plus any tax)
    for (const ch of await chargesOf(basePrisma, p.id)) { expect(ch.outstandingCents).toBeGreaterThanOrEqual(0); expect(ch.outstandingCents).toBeLessThanOrEqual(ch.owedCents); }
  });
});
