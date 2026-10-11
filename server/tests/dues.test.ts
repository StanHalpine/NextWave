import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { billDues } from '../src/lib/dues.js';
import { enroll, grantDue, updateMembership } from '../src/lib/membership.js';
import { runMembershipGrants } from '../src/jobs/credits.js';
import { setClockForTests } from '../src/lib/clock.js';
import { auditRows, blob, makeAccount } from './helpers.js';
import { makePatient } from './phase2.js';
import { makeMembership, makePlan } from './phase3.js';

/**
 * Dues are billed with the month's credits (lib/dues.ts): one RevenueEvent of payment type DUES per (membership, period), for the
 * tier's price at the time, dated the first day of the period in the clinic's calendar. These tests drive grantDue — exactly what
 * the monthly job calls for each membership — so they touch only their own memberships; one test runs the job itself.
 */
afterAll(() => setClockForTests(null));

const CDT = (local: string) => new Date(`${local}-05:00`);
const CST = (local: string) => new Date(`${local}-06:00`);
const grant = (membershipId: string, now: Date, actorAccountId: string | null = null) =>
  staffTransaction((tx, rec) => grantDue(tx, rec, membershipId, now, { actorAccountId }));
const duesOf = (membershipId: string) => basePrisma.revenueEvent.findMany({ where: { membershipId }, orderBy: { periodStart: 'asc' } });
const periods = async (membershipId: string) => (await duesOf(membershipId)).map((e) => e.periodStart!.toISOString().slice(0, 10));
const enrollNow = async (planCode: string, now: Date, accountId = 'acct-test') => {
  const patient = await makePatient();
  const r = await staffTransaction((tx, rec) => enroll(tx, rec, { patientId: patient.id, planCode, accountId, now }));
  return { patient, membership: r.membership };
};

describe('billing dues with the month\'s credits', () => {
  it('enrolling bills the first month: the tier\'s price, dated its first day, BILLED, with no visit — and audited without the patient', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 17500 });
    const account = await makeAccount({ roles: ['FRONT_DESK'] });
    const { patient, membership } = await enrollNow(plan.code, CST('2036-02-10T14:00:00'), account.id);

    const [e, ...more] = await duesOf(membership.id);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      paymentType: 'DUES', billingStatus: 'BILLED', patientId: patient.id, membershipId: membership.id, planCode: plan.code,
      listPriceCents: 17500, netPriceCents: 17500, discountCents: 0, discountPercent: 0, creditsRedeemed: 0, memberBenefit: null,
      serviceName: 'Membership dues', serviceCategory: 'Membership', encounterId: null, bookingId: null, serviceId: null, staffId: null,
      recordedById: account.id,
    });
    expect(e!.periodStart!.toISOString().slice(0, 10)).toBe('2036-02-10');
    expect(e!.occurredAt.toISOString()).toBe('2036-02-10T06:00:00.000Z');          // local midnight (CST), not the minute they enrolled

    const [row] = await auditRows({ resourceType: 'revenue_event', resourceId: e!.id, action: 'CREATE' });
    expect(row!.meta).toMatchObject({ paymentType: 'DUES', billingStatus: 'BILLED', period: '2036-02-10', plan: plan.code, amountCents: 17500 });
    expect(blob(row)).not.toContain(patient.id);
  });

  it('bills a month once however many times, or how many at once, the grant runs', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 9900 });
    const { membership } = await enrollNow(plan.code, CDT('2036-06-10T09:00:00'));
    expect(await periods(membership.id)).toEqual(['2036-06-10']);

    expect(await grant(membership.id, CDT('2036-06-10T09:05:00'))).toBe(0);
    await Promise.all(Array.from({ length: 6 }, () => grant(membership.id, CDT('2036-06-20T09:00:00'))));
    expect(await periods(membership.id)).toEqual(['2036-06-10']);                 // 20 June is not a grant day

    await Promise.all(Array.from({ length: 6 }, () => grant(membership.id, CDT('2036-07-10T09:00:00'))));
    expect(await periods(membership.id)).toEqual(['2036-06-10', '2036-07-10']);
  });

  it('a repeat bill for the same period is a quiet no-op — not an error, and not a second audit row — even inside one transaction', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 7700 });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2036-11-03');
    const bill = (tx: Parameters<Parameters<typeof staffTransaction>[0]>[0], rec: Parameters<Parameters<typeof staffTransaction>[0]>[1]) =>
      billDues(tx, rec, { membership: { id: m.id, patientId: p.id }, plan, periodStart: '2036-11-03', actorAccountId: null });
    const results = await staffTransaction(async (tx, rec) => [await bill(tx, rec), await bill(tx, rec)]);   // a unique violation would abort this transaction
    expect(results).toEqual([true, false]);
    expect(await duesOf(m.id)).toHaveLength(1);
    expect((await duesOf(m.id))[0]!.recordedById).toBe('system:membership-grant');
    expect(await auditRows({ resourceType: 'revenue_event', resourceId: (await duesOf(m.id))[0]!.id, action: 'CREATE' })).toHaveLength(1);
  });

  it('bills each month on its grant day — a 31st clamps to the short month, including a leap February', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 10000 });
    const { membership } = await enrollNow(plan.code, CST('2036-01-31T10:00:00'));
    await grant(membership.id, CST('2036-02-29T10:00:00'));
    await grant(membership.id, CDT('2036-03-31T10:00:00'));
    expect(await periods(membership.id)).toEqual(['2036-01-31', '2036-02-29', '2036-03-31']);
  });

  it('catches up every month a stopped job missed, each dated its own period — across the daylight-saving change', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 12300 });
    const { membership } = await enrollNow(plan.code, CST('2036-03-01T10:00:00'));
    await grant(membership.id, CDT('2036-05-05T09:00:00'));                        // the job was down from 1 April to 5 May
    expect(await periods(membership.id)).toEqual(['2036-03-01', '2036-04-01', '2036-05-01']);
    const at = (await duesOf(membership.id)).map((e) => e.occurredAt.toISOString());
    expect(at).toEqual(['2036-03-01T06:00:00.000Z', '2036-04-01T05:00:00.000Z', '2036-05-01T05:00:00.000Z']);   // CST, then CDT after 9 March
  });

  it('is billed also when the tier grants no credits, and not at all when the tier is free', async () => {
    const noCredits = (await makePlan({ credits: 0, priceCents: 5000 })).plan;
    const free = (await makePlan({ credits: 4, priceCents: 0 })).plan;
    const a = await enrollNow(noCredits.code, CDT('2036-08-10T09:00:00'));
    const b = await enrollNow(free.code, CDT('2036-08-10T09:00:00'));
    expect((await duesOf(a.membership.id)).map((e) => e.listPriceCents)).toEqual([5000]);
    expect(await basePrisma.creditLedger.count({ where: { membershipId: a.membership.id } })).toBe(0);   // billed, though nothing was granted
    expect(await duesOf(b.membership.id)).toEqual([]);
    expect(await basePrisma.creditLedger.count({ where: { membershipId: b.membership.id } })).toBe(1);   // credits still granted
  });

  it('is not billed while paused or after cancelling; months missed while paused are not made up', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 8000 });
    const { patient, membership } = await enrollNow(plan.code, CST('2036-01-05T10:00:00'));
    await staffTransaction((tx, rec) => updateMembership(tx, rec, { patientId: patient.id, action: 'pause', now: CST('2036-01-20T10:00:00') }));
    await grant(membership.id, CST('2036-02-20T10:00:00'));                         // paused: grantDue does nothing
    await grant(membership.id, CST('2036-03-20T10:00:00'));
    expect(await periods(membership.id)).toEqual(['2036-01-05']);

    await staffTransaction((tx, rec) => updateMembership(tx, rec, { patientId: patient.id, action: 'resume', now: CDT('2036-04-05T10:00:00') }));
    expect(await periods(membership.id)).toEqual(['2036-01-05', '2036-04-05']);     // February and March are not billed

    await staffTransaction((tx, rec) => updateMembership(tx, rec, { patientId: patient.id, action: 'cancel', now: CDT('2036-04-10T10:00:00') }));
    await grant(membership.id, CDT('2036-06-10T10:00:00'));
    expect(await periods(membership.id)).toEqual(['2036-01-05', '2036-04-05']);
  });

  it('bills the price at the time: a later price change touches no earlier month, and a plan change starts at the next one', async () => {
    const a = (await makePlan({ credits: 4, priceCents: 10000 })).plan;
    const b = (await makePlan({ credits: 4, priceCents: 20000 })).plan;
    const { patient, membership } = await enrollNow(a.code, CST('2036-01-12T10:00:00'));

    await prisma.membershipPlan.update({ where: { id: a.id }, data: { priceCents: 11000 } });
    await grant(membership.id, CST('2036-02-12T10:00:00'));
    await staffTransaction((tx, rec) => updateMembership(tx, rec, { patientId: patient.id, action: 'change_plan', planCode: b.code, now: CST('2036-02-20T10:00:00') }));
    await grant(membership.id, CST('2036-03-12T10:00:00'));

    const ev = await duesOf(membership.id);
    expect(ev.map((e) => [e.periodStart!.toISOString().slice(0, 10), e.planCode, e.listPriceCents])).toEqual([
      ['2036-01-12', a.code, 10000], ['2036-02-12', a.code, 11000], ['2036-03-12', b.code, 20000],
    ]);
  });

  it('is what the monthly job does: every period due, once, however many times or how many at once the job runs', async () => {
    const { plan } = await makePlan({ credits: 4, priceCents: 14000 });
    const patient = await makePatient();
    const m = await makeMembership(patient.id, plan.code, '2026-08-14');          // started 14 Aug; the job runs on 14 Oct
    const now = CDT('2026-10-14T09:00:00');
    await runMembershipGrants({ now });
    expect(await periods(m.id)).toEqual(['2026-08-14', '2026-09-14', '2026-10-14']);
    await runMembershipGrants({ now });
    await Promise.all(Array.from({ length: 8 }, () => runMembershipGrants({ now })));
    expect(await periods(m.id)).toEqual(['2026-08-14', '2026-09-14', '2026-10-14']);
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id, reason: 'MONTHLY_GRANT' } })).toBe(3);   // the credits match the dues, month for month
  });
});

describe('the database refuses a dues event that is not one', () => {
  const base = { patientId: 'p', serviceName: 'Membership dues', serviceCategory: 'Membership', paymentType: 'DUES' as const, billingStatus: 'BILLED' as const, listPriceCents: 5000, netPriceCents: 5000, occurredAt: new Date('2036-09-01T05:00:00Z'), recordedById: 'x' };
  const mk = async () => {
    const { plan } = await makePlan({ credits: 1, priceCents: 5000 });
    const p = await makePatient();
    return { m: await makeMembership(p.id, plan.code, '2036-09-01'), p };
  };
  const insert = (extra: object) => basePrisma.revenueEvent.create({ data: { ...base, ...extra } as never });

  it('needs a membership and a period', async () => {
    const { m, p } = await mk();
    await expect(insert({ patientId: p.id, periodStart: new Date('2036-09-01') })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
    await expect(insert({ patientId: p.id, membershipId: m.id })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
    await expect(insert({ patientId: p.id, membershipId: m.id, periodStart: new Date('2036-09-01'), billingStatus: null })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
  });

  it('is billed in full, with no discount, credits or benefit — and has no visit', async () => {
    const { m, p } = await mk();
    const ok = { patientId: p.id, membershipId: m.id, periodStart: new Date('2036-09-01') };
    await expect(insert({ ...ok, netPriceCents: 4000 })).rejects.toThrow(/RevenueEvent_consistent|check constraint/i);
    await expect(insert({ ...ok, discountCents: 500, discountPercent: 10, netPriceCents: 4500 })).rejects.toThrow(/RevenueEvent_consistent|check constraint/i);
    await expect(insert({ ...ok, creditsRedeemed: 1 })).rejects.toThrow(/RevenueEvent_consistent|check constraint/i);
    await expect(insert({ ...ok, memberBenefit: 'CREDITS' })).rejects.toThrow(/RevenueEvent_consistent|check constraint/i);
    await expect(insert({ ...ok, listPriceCents: 0, netPriceCents: 0 })).rejects.toThrow(/RevenueEvent_consistent|check constraint/i);
    await expect(insert({ ...ok, serviceId: 'svc' })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
    await expect(insert({ ...ok, bookingId: 'bk' })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
    await expect(insert(ok)).resolves.toMatchObject({ paymentType: 'DUES' });
  });

  it('is unique per membership and period, and a visit event can no longer lack its visit', async () => {
    const { m, p } = await mk();
    const ok = { patientId: p.id, membershipId: m.id, periodStart: new Date('2036-09-01') };
    await insert(ok);
    await expect(insert(ok)).rejects.toThrow(/Unique constraint|RevenueEvent_membershipId_periodStart_key/i);
    await expect(insert({ ...ok, periodStart: new Date('2036-10-01') })).resolves.toBeTruthy();   // another month is another bill
    // A cash visit event with no encounter is not allowed (every row was one before dues existed).
    await expect(basePrisma.revenueEvent.create({ data: { patientId: p.id, serviceName: 's', serviceCategory: 'c', paymentType: 'CASH', listPriceCents: 100, netPriceCents: 100, occurredAt: new Date(), recordedById: 'x' } as never })).rejects.toThrow(/RevenueEvent_kind|check constraint/i);
  });

  it('stays append-only: a dues event can be neither edited nor deleted', async () => {
    const { m, p } = await mk();
    const e = await insert({ patientId: p.id, membershipId: m.id, periodStart: new Date('2036-09-01') });
    await expect(basePrisma.$executeRawUnsafe(`UPDATE "RevenueEvent" SET "billingStatus" = 'BILLED' WHERE id = '${e.id}'`)).rejects.toThrow(/append-only/);
    await expect(basePrisma.$executeRawUnsafe(`DELETE FROM "RevenueEvent" WHERE id = '${e.id}'`)).rejects.toThrow(/append-only/);
  });
});
