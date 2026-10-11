import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { checkoutVisit, type PaymentChoice } from '../src/lib/checkout.js';
import { billDues } from '../src/lib/dues.js';
import { duesTable, memberSplit, revenueTable, serviceDemand, signupsByMonth, walkIns, weekendVisits } from '../src/lib/reports.js';
import { DEMAND_CATEGORIES, ReportError, csvCell, currentMonth, demandCategoryOf, dollars, eachDay, eachMonth, resolveRange, toCsv } from '../src/lib/reportFormat.js';
import { app, auditRows, blob, makeAccount, signInFully, type Signed } from './helpers.js';
import { makeClinic, makePatient } from './phase2.js';
import { checkedInVisit, creditService, grantLot, makeCategory, makeMembership, makePlan } from './phase3.js';

afterAll(() => setClockForTests(null));

const get = (s: Signed | null, url: string) => (s ? s.agent.get(url) : request(app).get(url));
const adminLogin = async () => signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
const at = (iso: string) => new Date(iso);
const CDT = (local: string) => new Date(`${local}-05:00`);   // clinic-local wall time in May–October (CDT, UTC-5)
const CST = (local: string) => new Date(`${local}-06:00`);   // … November–March (CST, UTC-6)

// ---------------------------------------------------------------------------------------------------
describe('date ranges', () => {
  it('defaults to the current month in the CLINIC calendar, not UTC', () => {
    // 23:30 on 31 Oct local is already 1 Nov in UTC; it is still October at the clinic.
    expect(currentMonth(CDT('2026-10-31T23:30:00'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(currentMonth(CDT('2026-11-01T00:00:00'))).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(currentMonth(CST('2028-02-15T12:00:00'))).toEqual({ from: '2028-02-01', to: '2028-02-29' });   // leap year
    expect(resolveRange({}, CDT('2026-10-13T10:07:00'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('takes both ends or neither, and refuses nonsense instead of guessing', () => {
    const now = CDT('2026-10-13T10:07:00');
    expect(resolveRange({ from: '2026-03-01', to: '2026-03-31' }, now)).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(resolveRange({ from: '2026-03-05', to: '2026-03-05' }, now)).toEqual({ from: '2026-03-05', to: '2026-03-05' });
    const code = (q: { from?: string; to?: string }) => { try { resolveRange(q, now); return 'ok'; } catch (e) { return e instanceof ReportError ? e.code : 'other'; } };
    expect(code({ from: '2026-03-01' })).toBe('bad_range');
    expect(code({ to: '2026-03-01' })).toBe('bad_range');
    expect(code({ from: '2026-03-02', to: '2026-03-01' })).toBe('bad_range');
    expect(code({ from: '2026-02-30', to: '2026-03-01' })).toBe('bad_date');
    expect(code({ from: '03/01/2026', to: '2026-03-31' })).toBe('bad_date');
    expect(code({ from: '2026-3-1', to: '2026-03-31' })).toBe('bad_date');
    expect(code({ from: '2000-01-01', to: '2026-01-01' })).toBe('range_too_long');
  });

  it('lists every day and month in a range, across the daylight-saving change', () => {
    expect(eachDay({ from: '2033-03-12', to: '2033-03-14' })).toEqual(['2033-03-12', '2033-03-13', '2033-03-14']);   // 13 Mar 2033 is a 23-hour day
    expect(eachDay({ from: '2033-11-05', to: '2033-11-07' })).toEqual(['2033-11-05', '2033-11-06', '2033-11-07']);   // 6 Nov 2033 is a 25-hour day
    expect(eachDay({ from: '2033-05-31', to: '2033-06-01' })).toHaveLength(2);
    expect(eachMonth({ from: '2033-11-20', to: '2034-02-02' })).toEqual(['2033-11', '2033-12', '2034-01', '2034-02']);
    expect(eachMonth({ from: '2033-05-03', to: '2033-05-03' })).toEqual(['2033-05']);
  });
});

describe('CSV', () => {
  it('formats cents as plain decimals', () => {
    expect([0, 5, 99, 100, 1999, 123456, -250].map(dollars)).toEqual(['0.00', '0.05', '0.99', '1.00', '19.99', '1234.56', '-2.50']);
  });

  it('quotes what needs it and defuses a cell a spreadsheet would run as a formula', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    for (const bad of ['=SUM(A1)', '+1', '-1', '@x', '\tx', '\rx']) expect(csvCell(bad)).toMatch(/^"?'/);
    expect(csvCell(-250, 'money')).toBe('-2.50');         // our own negative number is not a formula
    expect(csvCell(7, 'int')).toBe('7');
  });

  it('writes a header, the rows and the totals, one CRLF per line', () => {
    const csv = toCsv(
      [{ key: 'n', label: 'Name', kind: 'text' }, { key: 'c', label: 'Net', kind: 'money' }],
      [{ n: 'A, Inc', c: 1999 }, { n: '=bad', c: 5 }],
      { n: 'Total', c: 2004 },
    );
    expect(csv).toBe('Name,Net\r\n"A, Inc",19.99\r\n\'=bad,0.05\r\nTotal,20.04\r\n');
  });
});

describe('service demand categories', () => {
  it('maps the categories the owner named, and sends anything else to Other', () => {
    expect(DEMAND_CATEGORIES.map((c) => c.key)).toEqual(['chiropractic', 'hbot', 'red_light', 'iv', 'injections', 'consult', 'bloodwork']);
    expect(demandCategoryOf('manual-adjustment').key).toBe('chiropractic');
    expect(demandCategoryOf('spinal-xrays').key).toBe('chiropractic');
    expect(demandCategoryOf('hyperbaric-oxygen-therapy').key).toBe('hbot');
    expect(demandCategoryOf('red-light-therapy').key).toBe('red_light');
    expect(demandCategoryOf('iv-therapy').key).toBe('iv');
    expect(demandCategoryOf('vitamin-shots').key).toBe('injections');
    expect(demandCategoryOf('functional-medicine-consult').key).toBe('consult');
    expect(demandCategoryOf('biomarker-testing').key).toBe('bloodwork');
    expect(demandCategoryOf('something-new').key).toBe('other');
  });

  it('leaves exactly one seeded service in Other (the seed\'s own ids, not other tests\' fixtures), on purpose — adding a service fails this until someone decides', async () => {
    const slugs = (await basePrisma.service.findMany({ where: { id: { startsWith: '5e401ce0-' } }, select: { slug: true } })).map((s) => s.slug);
    expect(slugs.length).toBeGreaterThan(10);
    const other = [...new Set(slugs.filter((s) => demandCategoryOf(s).key === 'other'))].sort();
    // Body composition is in none of the named categories (SPEC A-6); vitamin shots moved out at Phase 5 approval.
    expect(other, `services in "Other" — map them in lib/reportFormat.ts: ${other.join(', ')}`).toEqual(['body-composition']);
  });
});

// ---------------------------------------------------------------------------------------------------
// The books: real check-outs at pinned instants, each checked against a hand-written expectation.
// ---------------------------------------------------------------------------------------------------

interface Sale { key: string; at: Date; local: string; month: string; staffId: string; service: string; planCode: string | null; bucket: string; payment: 'CASH' | 'MEMBER'; list: number; discount: number; net: number; credits: number; covered: number }
const sales: Sale[] = [];
interface Due { key: string; periodStart: string; month: string; tier: string; cents: number }
const DUES: Due[] = [];
const ctx = {} as { accountId: string; s100: Awaited<ReturnType<typeof creditService>>; s1999: Awaited<ReturnType<typeof creditService>>; cat: { id: string; code: string }; restore: { id: string; code: string; priceCents: number }; prevent: { id: string; code: string; priceCents: number }; admin: Signed; fd: Signed };
const MAY = { from: '2033-05-01', to: '2033-05-31' };
const WHOLE = { from: '2033-05-01', to: '2033-06-30' };

const sum = (rows: Sale[], k: 'list' | 'discount' | 'net' | 'credits' | 'covered') => rows.reduce((t, r) => t + r[k], 0);
const metrics = (rows: Sale[]) => ({ visits: rows.length, listCents: sum(rows, 'list'), discountCents: sum(rows, 'discount'), netCents: sum(rows, 'net'), coveredCents: sum(rows, 'covered'), credits: sum(rows, 'credits') });
const inRange = (r: Sale, from: string, to: string) => r.local >= from && r.local <= to;
const only = (t: { rows: Array<Record<string, string | number>> }, key: string, value: string) => t.rows.find((r) => r[key] === value);

beforeAll(async () => {
  ctx.accountId = (await makeAccount({ roles: ['FRONT_DESK'] })).id;
  ctx.s100 = await creditService({ priceCents: 10000, creditCost: 2 });
  ctx.s1999 = await creditService({ priceCents: 1999, creditCost: 1 });
  // Tiers of this file's own: the seeded Prevent / Restore / Optimize must stay free of discounts for the tests that assert they start empty.
  ctx.restore = (await makePlan({ credits: 4 })).plan;
  ctx.prevent = (await makePlan({ credits: 4, priceCents: 15000 })).plan;   // restore's dues are the default $123.00; prevent's $150.00
  ctx.cat = await makeCategory({ serviceIds: [ctx.s100.service.id, ctx.s1999.service.id], percents: { [ctx.restore.id]: 15, [ctx.prevent.id]: 10 } });

  const memberOf = async (code: string, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE', credits = 0) => {
    const p = await makePatient();
    const m = await makeMembership(p.id, code, '2033-05-01', { status });
    if (credits) await grantLot({ patientId: p.id, membershipId: m.id, credits, periodStart: '2033-05-01', now: at('2033-05-01T12:00:00Z') });
    return Object.assign(p, { membership: m });
  };
  const sale = async (key: string, clinic: typeof ctx.s100, when: Date, patientId: string | null, pay: PaymentChoice,
    expect_: Omit<Sale, 'key' | 'at' | 'local' | 'month' | 'staffId' | 'service'>) => {
    const { booking } = await checkedInVisit(clinic, patientId);
    await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: ctx.accountId, now: when, ...pay }));
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
    sales.push({ key, at: when, local, month: local.slice(0, 7), staffId: booking.staffId!, service: clinic.service.name, ...expect_ });
  };

  const restore = await memberOf(ctx.restore.code);
  const restoreB = await memberOf(ctx.restore.code);
  const restoreC = await memberOf(ctx.restore.code);
  const prevent = await memberOf(ctx.prevent.code, 'ACTIVE', 6);
  const paused = await memberOf(ctx.restore.code, 'PAUSED');

  const { plan, perks } = await makePlan({ perks: [{ key: 'monthly', label: 'Monthly shot', quantity: 1, serviceIds: [ctx.s1999.service.id] }] });
  const perkPatient = await makePatient();
  await prisma.membership.create({ data: { patientId: perkPatient.id, planId: plan.id, startedOn: new Date('2033-05-01'), nextGrantOn: new Date('2033-06-01'), createdById: 'x' } });

  // 3 May, morning — a non-member, and a Restore member, both paying cash for the $100.00 service.
  await sale('nonmember-cash', ctx.s100, CDT('2033-05-03T10:00:00'), null, { payment: 'CASH' }, { planCode: null, bucket: 'Non-member — cash', payment: 'CASH', list: 10000, discount: 0, net: 10000, credits: 0, covered: 0 });
  await sale('restore-cash', ctx.s100, CDT('2033-05-03T10:30:00'), restore.id, { payment: 'CASH' }, { planCode: ctx.restore.code, bucket: 'Member — cash', payment: 'CASH', list: 10000, discount: 1500, net: 8500, credits: 0, covered: 0 });
  // 3 May, 23:30 local (04:30Z on the 4th): still the 3rd at the clinic. A Prevent member pays with credits.
  await sale('prevent-credits', ctx.s100, CDT('2033-05-03T23:30:00'), prevent.id, { payment: 'CREDITS' }, { planCode: ctx.prevent.code, bucket: 'Member — credits', payment: 'MEMBER', list: 10000, discount: 0, net: 0, credits: 2, covered: 10000 });
  // 4 May, 00:15 local: the next day. 15% of $19.99 = $2.9985 → $3.00 off, $16.99 net.
  await sale('restore-odd-cents', ctx.s1999, CDT('2033-05-04T00:15:00'), restoreB.id, { payment: 'CASH' }, { planCode: ctx.restore.code, bucket: 'Member — cash', payment: 'CASH', list: 1999, discount: 300, net: 1699, credits: 0, covered: 0 });
  // 4 May, daytime — an included perk (worth $19.99, collects nothing), and a PAUSED member (no discount, counts as a non-member).
  await sale('perk', ctx.s1999, CDT('2033-05-04T11:00:00'), perkPatient.id, { payment: 'PERK', perkId: perks[0]!.id }, { planCode: plan.code, bucket: 'Member — included perk', payment: 'MEMBER', list: 1999, discount: 0, net: 0, credits: 0, covered: 1999 });
  await sale('paused-cash', ctx.s100, CDT('2033-05-04T11:30:00'), paused.id, { payment: 'CASH' }, { planCode: null, bucket: 'Non-member — cash', payment: 'CASH', list: 10000, discount: 0, net: 10000, credits: 0, covered: 0 });
  // The month boundary, in both directions: 23:59 on 31 May is May at the clinic (June in UTC); 00:00 on 1 June is June.
  await sale('may-31-late', ctx.s100, CDT('2033-05-31T23:59:00'), null, { payment: 'CASH' }, { planCode: null, bucket: 'Non-member — cash', payment: 'CASH', list: 10000, discount: 0, net: 10000, credits: 0, covered: 0 });
  await sale('june-1-midnight', ctx.s1999, CDT('2033-06-01T00:00:00'), restoreC.id, { payment: 'CASH' }, { planCode: ctx.restore.code, bucket: 'Member — cash', payment: 'CASH', list: 1999, discount: 300, net: 1699, credits: 0, covered: 0 });
  await sale('june-late', ctx.s1999, CDT('2033-06-20T09:00:00'), null, { payment: 'CASH' }, { planCode: null, bucket: 'Non-member — cash', payment: 'CASH', list: 1999, discount: 0, net: 1999, credits: 0, covered: 0 });

  // Dues, billed through the same code the monthly grant uses. Hand-written: who, which month, which tier, how much.
  const dues = async (key: string, who: { id: string; membership: { id: string } }, plan: { code: string; priceCents: number }, periodStart: string) => {
    await staffTransaction((tx, rec) => billDues(tx, rec, { membership: { id: who.membership.id, patientId: who.id }, plan, periodStart, actorAccountId: ctx.accountId }));
    DUES.push({ key, periodStart, month: periodStart.slice(0, 7), tier: plan.code, cents: plan.priceCents });
  };
  await dues('restore-may', restore, ctx.restore, '2033-05-01');
  await dues('restore-june', restore, ctx.restore, '2033-06-01');
  await dues('restoreB-may-31', restoreB, ctx.restore, '2033-05-31');           // dated the first day of its period: 31 May, local midnight
  await dues('prevent-may-3', prevent, ctx.prevent, '2033-05-03');              // the same day as visits
  await dues('restoreC-june-1', restoreC, ctx.restore, '2033-06-01');           // local midnight, the same instant as a visit

  ctx.admin = await adminLogin();
  ctx.fd = await fdLogin();
});

describe('Accounting: the arithmetic', () => {
  it('matches the hand-written sale list for every check-out the books were built from', async () => {
    const rows = await basePrisma.revenueEvent.findMany({ where: { serviceId: { in: [ctx.s100.service.id, ctx.s1999.service.id] } } });
    expect(rows).toHaveLength(sales.length);
    // Sanity on the fixture itself (not the report): list − discount − net is what a membership covered.
    for (const s of sales) expect(s.list - s.discount - s.net).toBe(s.covered);
    expect(sales.some((s) => s.discount > 0)).toBe(true);
    expect(sales.some((s) => s.credits > 0)).toBe(true);
  });

  it('daily revenue puts 23:30 and 00:15 on the clinic\'s days, with list, discount, net and covered totals', async () => {
    const t = await revenueTable({ range: WHOLE }, 'day');
    const days = [...new Set(sales.map((s) => s.local))].sort();
    expect(t.rows.map((r) => r.day)).toEqual(days);                                    // only days with sales; ordered
    expect(only(t, 'day', '2033-05-03')).toMatchObject(metrics(sales.filter((s) => s.local === '2033-05-03')));
    expect(only(t, 'day', '2033-05-04')).toMatchObject(metrics(sales.filter((s) => s.local === '2033-05-04')));
    expect(only(t, 'day', '2033-05-03')).toMatchObject({ visits: 3, listCents: 30000, discountCents: 1500, netCents: 18500, coveredCents: 10000, credits: 2 });
    expect(only(t, 'day', '2033-05-04')).toMatchObject({ visits: 3, listCents: 13998, discountCents: 300, netCents: 11699, coveredCents: 1999 });
    expect(only(t, 'day', '2033-05-31')).toMatchObject({ visits: 1, netCents: 10000 });
    expect(only(t, 'day', '2033-06-01')).toMatchObject({ visits: 1, discountCents: 300, netCents: 1699 });
    expect(t.totals).toMatchObject({ day: 'Total', ...metrics(sales) });
  });

  it('the identity list = discount + covered + net holds in every row and in the totals', async () => {
    for (const g of ['day', 'month', 'service', 'bucket', 'tier', 'paymentType', 'serviceMonth', 'category', 'provider', 'discountCategory'] as const) {
      const t = await revenueTable({ range: WHOLE }, g);
      for (const r of [...t.rows, t.totals]) expect(r.listCents, `${g}`).toBe((r.discountCents as number) + (r.coveredCents as number) + (r.netCents as number));
    }
  });

  it('monthly revenue by service splits at the clinic\'s month end, not UTC\'s', async () => {
    const t = await revenueTable({ range: WHOLE }, 'serviceMonth');
    const want = (service: string, month: string) => metrics(sales.filter((s) => s.service === service && s.month === month));
    // Three (month, service) pairs have sales: both services in May, and only the $19.99 one in June.
    expect(t.rows.map((r) => r.month)).toEqual(['2033-05', '2033-05', '2033-06']);
    for (const [svc, month] of [[ctx.s100, '2033-05'], [ctx.s1999, '2033-05'], [ctx.s1999, '2033-06']] as const) {
      expect(t.rows.find((r) => r.service === svc.service.name && r.month === month), `${svc.service.name} ${month}`).toMatchObject(want(svc.service.name, month));
    }
    // 23:59 on 31 May is May at the clinic (June in UTC); it must not have leaked into June.
    expect(t.rows.find((r) => r.service === ctx.s100.service.name && r.month === '2033-05')).toMatchObject({ visits: 5, netCents: 10000 + 8500 + 0 + 10000 + 10000 });
    expect(t.rows.find((r) => r.service === ctx.s1999.service.name && r.month === '2033-06')).toMatchObject({ visits: 2, discountCents: 300, netCents: 1699 + 1999 });
    expect(t.totals).toMatchObject(metrics(sales));
  });

  it('the range ends are inclusive and nothing outside them is counted', async () => {
    const may = await revenueTable({ range: MAY }, 'month');
    expect(may.rows).toHaveLength(1);
    expect(may.rows[0]).toMatchObject({ month: '2033-05', ...metrics(sales.filter((s) => s.month === '2033-05')) });
    const oneDay = await revenueTable({ range: { from: '2033-05-04', to: '2033-05-04' } }, 'day');
    expect(oneDay.totals).toMatchObject(metrics(sales.filter((s) => s.local === '2033-05-04')));
    const empty = await revenueTable({ range: { from: '2033-07-01', to: '2033-07-31' } }, 'day');
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toMatchObject({ visits: 0, listCents: 0, discountCents: 0, netCents: 0, coveredCents: 0, credits: 0 });
  });

  it('splits members from non-members by who paid and how: a paused member who pays cash is a non-member', async () => {
    const t = await memberSplit({ range: WHOLE });
    const buckets = ['Non-member — cash', 'Member — cash', 'Member — credits', 'Member — included perk'];
    expect(t.rows.map((r) => r.bucket)).toEqual(buckets);
    for (const b of buckets) expect(only(t, 'bucket', b), b).toMatchObject(metrics(sales.filter((s) => s.bucket === b)));
    const isMember = (s: Sale) => s.bucket.startsWith('Member');
    expect(t.subtotals[0]).toMatchObject({ bucket: 'All members', ...metrics(sales.filter(isMember)) });
    expect(t.subtotals[1]).toMatchObject({ bucket: 'Non-members', ...metrics(sales.filter((s) => !isMember(s))) });
    expect(only(t, 'bucket', 'Non-member — cash')!.visits).toBe(4);   // two walk-up non-members, the paused member, and 20 June
    expect(only(t, 'bucket', 'Member — credits')).toMatchObject({ visits: 1, netCents: 0, credits: 2, coveredCents: 10000 });
    expect(only(t, 'bucket', 'Member — included perk')).toMatchObject({ visits: 1, netCents: 0, coveredCents: 1999 });
    expect(t.totals).toMatchObject(metrics(sales));
  });

  it('groups by payment type, tier and discount category', async () => {
    const pay = await revenueTable({ range: WHOLE }, 'paymentType');
    expect(only(pay, 'paymentType', 'Cash')).toMatchObject(metrics(sales.filter((s) => s.payment === 'CASH')));
    expect(only(pay, 'paymentType', 'Covered by membership')).toMatchObject(metrics(sales.filter((s) => s.payment === 'MEMBER')));
    const tier = await revenueTable({ range: WHOLE }, 'tier');
    expect(only(tier, 'tier', ctx.restore.code)).toMatchObject(metrics(sales.filter((s) => s.planCode === ctx.restore.code)));
    expect(only(tier, 'tier', ctx.prevent.code)).toMatchObject(metrics(sales.filter((s) => s.planCode === ctx.prevent.code)));
    expect(only(tier, 'tier', 'Non-member')).toMatchObject(metrics(sales.filter((s) => s.planCode === null)));
    const dc = await revenueTable({ range: WHOLE }, 'discountCategory');
    // Three sales were discounted ($15.00, $3.00, $3.00); the other six carry no category.
    expect(dc.rows.find((r) => r.discountCategory === ctx.cat.code)).toMatchObject({ visits: 3, discountCents: 1500 + 300 + 300 });
    expect(dc.rows.find((r) => r.discountCategory === '(no discount category)')).toMatchObject(metrics(sales.filter((x) => x.discount === 0)));
  });

  it('filters by service, payment type and provider, singly and together', async () => {
    const f = (x: object) => revenueTable({ range: WHOLE, ...x }, 'service');
    expect((await f({ serviceId: ctx.s1999.service.id })).totals).toMatchObject(metrics(sales.filter((s) => s.service === ctx.s1999.service.name)));
    expect((await f({ paymentType: 'MEMBER' })).totals).toMatchObject(metrics(sales.filter((s) => s.payment === 'MEMBER')));
    expect((await f({ paymentType: 'CASH' })).totals).toMatchObject(metrics(sales.filter((s) => s.payment === 'CASH')));
    const staffId = sales.find((s) => s.key === 'restore-cash')!.staffId;
    expect((await f({ providerId: staffId })).totals).toMatchObject(metrics(sales.filter((s) => s.staffId === staffId)));
    const both = await f({ serviceId: ctx.s100.service.id, paymentType: 'CASH', providerId: staffId });
    expect(both.totals).toMatchObject(metrics(sales.filter((s) => s.service === ctx.s100.service.name && s.payment === 'CASH' && s.staffId === staffId)));
    expect((await f({ serviceId: 'no-such-service' })).rows).toEqual([]);
  });

  it('by provider names the providers (staff, not patients), and "Unassigned" for a visit with none', async () => {
    const t = await revenueTable({ range: WHOLE }, 'provider');
    expect(t.rows.every((r) => typeof r.provider === 'string' && (r.provider as string).startsWith('Test Provider'))).toBe(true);
    expect(t.totals).toMatchObject(metrics(sales));
  });

  it('a service with no list price paid in credits contributes nothing to list (its worth is unknown), and nothing breaks', async () => {
    const clinic = await creditService({ priceCents: null, creditCost: 2 });
    const p = await makePatient();
    const m = await makeMembership(p.id, 'OPTIMIZE', '2033-08-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2033-08-01', now: at('2033-08-01T12:00:00Z') });
    const { booking } = await checkedInVisit(clinic, p.id);
    await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: ctx.accountId, now: CDT('2033-08-10T10:00:00'), payment: 'CREDITS' }));
    const t = await revenueTable({ range: { from: '2033-08-01', to: '2033-08-31' }, serviceId: clinic.service.id }, 'service');
    expect(t.totals).toMatchObject({ visits: 1, listCents: 0, discountCents: 0, netCents: 0, coveredCents: 0, credits: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('Accounting: membership dues, apart from service revenue', () => {
  const duesIn = (from: string, to: string) => DUES.filter((d) => d.periodStart >= from && d.periodStart <= to);
  const total = (rows: Due[]) => ({ duesCount: rows.length, duesCents: rows.reduce((t, d) => t + d.cents, 0) });
  const row = (t: { rows: Array<Record<string, string | number>> }, key: string, value: string) => t.rows.find((r) => r[key] === value);

  it('is never counted as a visit or added into service revenue, in any grouping', async () => {
    // The sales fixture above is exact to the cent and has five dues events in the same months; every assertion there is
    // the proof. Here, the one blunt check: service totals are the sales alone, whatever the grouping.
    for (const g of ['day', 'month', 'service', 'bucket', 'tier', 'paymentType', 'serviceMonth', 'category', 'provider', 'discountCategory'] as const) {
      const t = await revenueTable({ range: WHOLE }, g);
      expect(t.totals, g).toMatchObject(metrics(sales));
      expect(JSON.stringify(t.rows), g).not.toContain('Membership dues');
    }
    expect((await memberSplit({ range: WHOLE })).totals).toMatchObject(metrics(sales));
  });

  it("is billed at the tier's price, dated the first day of its period in the clinic's calendar", async () => {
    const ev = await basePrisma.revenueEvent.findMany({ where: { paymentType: 'DUES', planCode: { in: [ctx.restore.code, ctx.prevent.code] } }, orderBy: { periodStart: 'asc' } });
    expect(ev).toHaveLength(DUES.length);
    for (const e of ev) {
      expect(e).toMatchObject({ billingStatus: 'BILLED', encounterId: null, bookingId: null, serviceId: null, serviceName: 'Membership dues', serviceCategory: 'Membership', discountCents: 0, creditsRedeemed: 0, memberBenefit: null });
      expect(e.netPriceCents).toBe(e.listPriceCents);
    }
    const may31 = ev.find((e) => e.periodStart!.toISOString().startsWith('2033-05-31'))!;
    expect(may31.occurredAt.toISOString()).toBe('2033-05-31T05:00:00.000Z');        // local midnight (CDT): May at the clinic, not June
    expect(may31.listPriceCents).toBe(ctx.restore.priceCents);
  });

  it('shows by month, beside the monthly-by-service view, with its own totals row', async () => {
    const t = await duesTable({ range: WHOLE }, 'serviceMonth');
    expect(t.columns.map((c) => c.label)).toEqual(['Month', 'Months billed', 'Dues billed']);
    expect(t.rows).toEqual([{ month: '2033-05', ...total(duesIn('2033-05-01', '2033-05-31')) }, { month: '2033-06', ...total(duesIn('2033-06-01', '2033-06-30')) }]);
    expect(t.rows).toEqual([{ month: '2033-05', duesCount: 3, duesCents: 39600 }, { month: '2033-06', duesCount: 2, duesCents: 24600 }]);
    expect(t.totals).toEqual({ month: 'Total', duesCount: 5, duesCents: 64200 });
    expect(t.note).toBeNull();
  });

  it('shows by day, and by tier for the member split', async () => {
    const day = await duesTable({ range: WHOLE }, 'day');
    expect(day.rows).toEqual([
      { day: '2033-05-01', duesCount: 1, duesCents: 12300 }, { day: '2033-05-03', duesCount: 1, duesCents: 15000 },
      { day: '2033-05-31', duesCount: 1, duesCents: 12300 }, { day: '2033-06-01', duesCount: 2, duesCents: 24600 },
    ]);
    for (const g of ['tier', 'bucket'] as const) {
      const t = await duesTable({ range: WHOLE }, g);
      expect(row(t, 'tier', ctx.restore.code)).toMatchObject({ duesCount: 4, duesCents: 49200 });
      expect(row(t, 'tier', ctx.prevent.code)).toMatchObject({ duesCount: 1, duesCents: 15000 });
    }
  });

  it('is one line when the view totals by something dues do not have (service, provider, payment type …)', async () => {
    for (const g of ['service', 'provider', 'paymentType', 'category', 'discountCategory'] as const) {
      const t = await duesTable({ range: WHOLE }, g);
      expect(t.columns.map((c) => c.key), g).toEqual(['line', 'duesCount', 'duesCents']);
      expect(t.rows, g).toEqual([{ line: 'Membership dues (billed)', duesCount: 5, duesCents: 64200 }]);
    }
  });

  it('respects the range: both ends inclusive, nothing outside, and a month with none is an empty table', async () => {
    expect((await duesTable({ range: { from: '2033-05-31', to: '2033-05-31' } }, 'day')).rows).toEqual([{ day: '2033-05-31', duesCount: 1, duesCents: 12300 }]);
    const none = await duesTable({ range: { from: '2033-07-01', to: '2033-07-31' } }, 'day');
    expect(none.rows).toEqual([]);
    expect(none.totals).toEqual({ day: 'Total', duesCount: 0, duesCents: 0 });
  });

  it('is left out when you filter by a service, a provider, or cash/credits — and is all that remains for the DUES payment type', async () => {
    for (const f of [{ serviceId: ctx.s100.service.id }, { providerId: sales[0]!.staffId }, { paymentType: 'CASH' as const }, { paymentType: 'MEMBER' as const }]) {
      const t = await duesTable({ range: WHOLE, ...f }, 'month');
      expect(t.rows, JSON.stringify(f)).toEqual([]);
      expect(t.note).toMatch(/left out when you filter/);
    }
    const onlyDues = { range: WHOLE, paymentType: 'DUES' as const };
    expect((await revenueTable(onlyDues, 'service')).rows).toEqual([]);
    expect((await revenueTable(onlyDues, 'service')).totals).toMatchObject({ visits: 0, listCents: 0, netCents: 0 });
    expect((await duesTable(onlyDues, 'month')).totals).toEqual({ month: 'Total', duesCount: 5, duesCents: 64200 });
  });

  it('is in every Accounting view as its own section — JSON and CSV — and in no Report', async () => {
    for (const v of ['monthly', 'daily', 'members', 'custom']) {
      const r = await get(ctx.admin, `/api/accounting/${v}?from=${WHOLE.from}&to=${WHOLE.to}`);
      expect(r.body.dues, v).toMatchObject({ totals: { duesCount: 5, duesCents: 64200 }, note: null });
      expect(r.body.totals, v).toMatchObject(metrics(sales));                          // the service totals are untouched
      const csv = await get(ctx.admin, `/api/accounting/${v}?from=${WHOLE.from}&to=${WHOLE.to}&format=csv`);
      expect(csv.text, v).toContain('Service revenue\r\n');
      expect(csv.text, v).toContain('Membership dues (billed)\r\n');
    }
    for (const v of ['signups', 'walkins-day', 'walkins-hour', 'weekend', 'demand']) {
      expect((await get(ctx.admin, `/api/reports/${v}?from=${WHOLE.from}&to=${WHOLE.to}`)).body.dues, v).toBeNull();
    }
  });

  it('the custom view can total by any grouping with the dues beside it, and a DUES payment filter shows only dues', async () => {
    const byMonth = await get(ctx.admin, `/api/accounting/custom?from=${WHOLE.from}&to=${WHOLE.to}&group=month`);
    expect(byMonth.body.dues.rows).toEqual([{ month: '2033-05', duesCount: 3, duesCents: 39600 }, { month: '2033-06', duesCount: 2, duesCents: 24600 }]);
    const only = await get(ctx.admin, `/api/accounting/custom?from=${WHOLE.from}&to=${WHOLE.to}&paymentType=DUES&group=tier`);
    expect(only.status).toBe(200);
    expect(only.body.rows).toEqual([]);
    expect(only.body.dues.totals).toMatchObject({ duesCount: 5, duesCents: 64200 });
    const filtered = await get(ctx.admin, `/api/accounting/custom?from=${WHOLE.from}&to=${WHOLE.to}&serviceId=${ctx.s100.service.id}`);
    expect(filtered.body.dues.rows).toEqual([]);
    expect(filtered.body.dues.note).toMatch(/left out when you filter/);
  });
});

// ---------------------------------------------------------------------------------------------------
/** The three seeded tiers' columns only: a test's own plans add columns of their own. */
const tiers = (rows: Array<Record<string, string | number>>) => rows.map(({ month, PREVENT, RESTORE, OPTIMIZE, total }) => ({ month, PREVENT, RESTORE, OPTIMIZE, total }));

describe('Reports: sign-ups', () => {
  it('counts memberships by the month and tier they started, inclusive of both range ends', async () => {
    const mk = async (code: string, day: string) => makeMembership((await makePatient()).id, code, day);
    // Only this test uses 2034-02 … 2034-04.
    await mk('PREVENT', '2034-02-01');      // first day of the range
    await mk('PREVENT', '2034-02-28');
    await mk('RESTORE', '2034-02-14');
    await mk('OPTIMIZE', '2034-03-31');
    await mk('PREVENT', '2034-04-01');      // outside the range (after)
    await mk('PREVENT', '2034-01-31');      // outside the range (before)
    const t = await signupsByMonth({ from: '2034-02-01', to: '2034-03-31' });
    expect(tiers(t.rows)).toEqual([
      { month: '2034-02', PREVENT: 2, RESTORE: 1, OPTIMIZE: 0, total: 3 },
      { month: '2034-03', PREVENT: 0, RESTORE: 0, OPTIMIZE: 1, total: 1 },
    ]);
    expect(tiers([t.totals])).toEqual([{ month: 'Total', PREVENT: 2, RESTORE: 1, OPTIMIZE: 1, total: 4 }]);
    const labels = t.columns.map((c) => c.label);
    expect([labels.slice(0, 4), labels.at(-1)]).toEqual([['Month', 'Prevent', 'Restore', 'Optimize'], 'Total']);   // other plans (a test's own) sit between
  });

  it('shows a month with no sign-ups as zeros, not as a missing row', async () => {
    const t = await signupsByMonth({ from: '2034-09-01', to: '2034-10-31' });
    expect(tiers(t.rows)).toEqual([{ month: '2034-09', PREVENT: 0, RESTORE: 0, OPTIMIZE: 0, total: 0 }, { month: '2034-10', PREVENT: 0, RESTORE: 0, OPTIMIZE: 0, total: 0 }]);
  });
});

// Bookings for the visit reports: inserted directly (the rules about who may book are not what is under test), against
// seeded services so the category mapping is exercised for real. 2034 is used by these tests only.
let seatN = 0;
async function visit(a: { slug?: string; service?: { id: string }; when: Date; source?: 'WALK_IN' | 'ONLINE' | 'FRONT_DESK'; status?: 'CONFIRMED' | 'CANCELLED'; encounter?: 'CHECKED_IN' | 'CHECKED_OUT' | 'NO_SHOW' | 'SCHEDULED' | null; deleted?: boolean }) {
  const service = a.service ?? await basePrisma.service.findFirstOrThrow({ where: { slug: a.slug! }, select: { id: true } });
  const room = await prisma.resource.create({ data: { name: `Report Room ${Date.now()}-${++seatN}`, type: 'TEST_ROOM', maxCapacity: 1 } });
  const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: '6125550000' } });
  const booking = await prisma.booking.create({
    data: { userId: user.id, serviceId: service.id, resourceId: room.id, startTime: a.when, endTime: new Date(a.when.getTime() + 30 * 60_000), status: a.status ?? 'CONFIRMED', source: a.source ?? 'ONLINE' },
  });
  if (a.encounter !== null) {
    await prisma.encounter.create({ data: { bookingId: booking.id, status: a.encounter ?? 'CHECKED_OUT', checkedInAt: a.when, ...(a.deleted ? { deletedAt: new Date() } : {}) } });
  }
  return booking;
}

describe('Reports: walk-ins', () => {
  it('counts confirmed walk-ins by clinic day and hour, ignoring other sources and cancelled bookings', async () => {
    // Week of 6 Mar 2034 (CST, UTC-6). Walk-ins: Mon 09:10, Mon 09:50, Mon 23:30, Tue 14:00; plus noise.
    const W = (local: string) => CST(`2034-03-${local}`);
    await visit({ when: W('06T09:10:00'), source: 'WALK_IN' });
    await visit({ when: W('06T09:50:00'), source: 'WALK_IN' });
    await visit({ when: W('06T23:30:00'), source: 'WALK_IN' });                    // 05:30Z the next day: still Monday at the clinic
    await visit({ when: W('07T14:00:00'), source: 'WALK_IN' });
    await visit({ when: W('07T14:30:00'), source: 'WALK_IN', status: 'CANCELLED' });   // not a visit
    await visit({ when: W('07T15:00:00'), source: 'ONLINE' });                      // an ordinary booking
    await visit({ when: W('07T16:00:00'), source: 'FRONT_DESK', encounter: 'NO_SHOW' });
    await visit({ when: CDT('2034-03-20T09:00:00'), source: 'WALK_IN' });           // outside the range below
    const w = await walkIns({ from: '2034-03-06', to: '2034-03-12' });

    expect(w.byDay.rows).toEqual([
      { day: '2034-03-06', walkIns: 3 }, { day: '2034-03-07', walkIns: 1 }, { day: '2034-03-08', walkIns: 0 }, { day: '2034-03-09', walkIns: 0 },
      { day: '2034-03-10', walkIns: 0 }, { day: '2034-03-11', walkIns: 0 }, { day: '2034-03-12', walkIns: 0 },
    ]);
    expect(w.byDay.totals).toEqual({ day: 'Total', walkIns: 4 });
    expect(w.byHour.rows).toHaveLength(24);
    expect(w.byHour.rows.filter((r) => r.walkIns !== 0)).toEqual([
      { hour: 9, label: '09:00', walkIns: 2 }, { hour: 14, label: '14:00', walkIns: 1 }, { hour: 23, label: '23:00', walkIns: 1 },
    ]);
    expect(w.byHour.totals).toEqual({ label: 'Total', walkIns: 4 });
    // 4 walk-ins out of the 5 visits checked in that week (4 walk-ins + the online one); the no-show is not a visit.
    expect(w.summary).toEqual({ walkIns: 4, allVisits: 5, sharePercent: 80 });
  });

  it('keeps the clinic\'s hours straight across the daylight-saving change', async () => {
    // 12 Mar 2034 is the spring-forward day: 02:00 CST becomes 03:00 CDT, so the day has 23 hours.
    await visit({ when: CST('2034-03-12T01:30:00'), source: 'WALK_IN' });   // 07:30Z — before the change
    await visit({ when: CDT('2034-03-12T03:30:00'), source: 'WALK_IN' });   // 08:30Z — an hour of real time later, two on the clock
    await visit({ when: CDT('2034-03-13T08:30:00'), source: 'WALK_IN' });   // the Monday after, on CDT
    const w = await walkIns({ from: '2034-03-12', to: '2034-03-13' });
    expect(w.byDay.rows).toEqual([{ day: '2034-03-12', walkIns: 2 }, { day: '2034-03-13', walkIns: 1 }]);
    expect(w.byHour.rows.filter((r) => r.walkIns !== 0).map((r) => r.hour)).toEqual([1, 3, 8]);   // 01:30, 03:30 and 08:30 on the clinic clock
  });

  it('reports zero cleanly when nothing happened, and a share of zero when there were no visits', async () => {
    const w = await walkIns({ from: '2034-12-01', to: '2034-12-03' });
    expect(w.byDay.totals).toEqual({ day: 'Total', walkIns: 0 });
    expect(w.summary).toEqual({ walkIns: 0, allVisits: 0, sharePercent: 0 });
  });
});

describe('Reports: weekend visits', () => {
  it('splits visits and no-shows by clinic weekday, and the weekend\'s share', async () => {
    // Week of 17 Jul 2034 (CDT). Mon 17 … Sun 23.
    const D = (local: string) => CDT(`2034-07-${local}`);
    await visit({ when: D('17T10:00:00') });                                                  // Mon
    await visit({ when: D('18T10:00:00') });                                                  // Tue
    await visit({ when: D('18T11:00:00'), encounter: 'NO_SHOW' });                            // Tue no-show
    await visit({ when: D('21T10:00:00') });                                                  // Fri
    await visit({ when: D('22T10:00:00') });                                                  // Sat
    await visit({ when: D('22T23:30:00') });                                                  // Sat 23:30 local = Sun 04:30Z: still Saturday
    await visit({ when: D('22T12:00:00'), encounter: 'NO_SHOW' });                            // Sat no-show
    await visit({ when: D('23T10:00:00'), encounter: 'CHECKED_IN' });                         // Sun, still in the building
    await visit({ when: D('23T13:00:00'), status: 'CANCELLED' });                             // cancelled: neither
    await visit({ when: D('23T14:00:00'), encounter: null });                                 // booked but never checked in and never marked: neither
    await visit({ when: D('24T10:00:00') });                                                  // next week — outside
    const t = await weekendVisits({ from: '2034-07-17', to: '2034-07-23' });

    const byDay = Object.fromEntries(t.rows.map((r) => [r.weekday, r]));
    expect(byDay.Monday).toMatchObject({ kind: 'Weekday', visits: 1, noShows: 0 });
    expect(byDay.Tuesday).toMatchObject({ visits: 1, noShows: 1 });
    expect(byDay.Friday).toMatchObject({ visits: 1 });
    expect(byDay.Saturday).toMatchObject({ kind: 'Weekend', visits: 2, noShows: 1 });
    expect(byDay.Sunday).toMatchObject({ kind: 'Weekend', visits: 1, noShows: 0 });
    expect(t.rows.map((r) => r.weekday)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
    expect(t.totals).toMatchObject({ weekday: 'Total', visits: 6, noShows: 2 });
    expect(t.summary).toEqual({ weekendVisits: 3, weekdayVisits: 3, weekendNoShows: 1, weekendSharePercent: 50, saturdayVisits: 2, sundayVisits: 1 });
  });

  it('does not count an encounter that was soft-deleted', async () => {
    await visit({ when: CDT('2034-08-05T10:00:00') });                       // Saturday
    await visit({ when: CDT('2034-08-05T11:00:00'), deleted: true });
    const t = await weekendVisits({ from: '2034-08-05', to: '2034-08-05' });
    expect(t.summary.saturdayVisits).toBe(1);
  });
});

describe('Reports: service demand', () => {
  it('counts booked, attended and no-shows in each category, with Other for the rest', async () => {
    const day = (h: string) => CDT(`2034-09-12T${h}:00`);
    const other = (await creditService()).service;                                       // slug "t-…": not in any category
    await visit({ slug: 'manual-adjustment', when: day('08:00') });                      // attended
    await visit({ slug: 'manual-adjustment', when: day('09:00'), encounter: 'NO_SHOW' });
    await visit({ slug: 'spinal-xrays', when: day('10:00'), encounter: 'CHECKED_IN' });
    await visit({ slug: 'hyperbaric-oxygen-therapy', when: day('11:00') });
    await visit({ slug: 'red-light-therapy', when: day('12:00') });
    await visit({ slug: 'iv-therapy', when: day('13:00'), encounter: 'SCHEDULED' });     // booked, not yet arrived
    await visit({ slug: 'vitamin-shots', when: day('13:30') });
    await visit({ slug: 'vitamin-shots', when: day('13:45'), encounter: 'NO_SHOW' });
    await visit({ slug: 'functional-medicine-consult', when: day('14:00') });
    await visit({ slug: 'biomarker-testing', when: day('15:00') });
    await visit({ slug: 'biomarker-testing', when: day('15:30'), status: 'CANCELLED' }); // cancelled: not booked
    await visit({ service: other, when: day('16:00') });
    await visit({ slug: 'manual-adjustment', when: CDT('2034-09-13T08:00:00') });       // next day: outside
    const t = await serviceDemand({ from: '2034-09-12', to: '2034-09-12' });
    const row = (c: string) => t.rows.find((r) => r.category === c)!;
    expect(row('Chiropractic')).toMatchObject({ booked: 3, attended: 2, noShows: 1 });
    expect(row('Hyperbaric oxygen (HBOT)')).toMatchObject({ booked: 1, attended: 1, noShows: 0 });
    expect(row('Red light')).toMatchObject({ booked: 1, attended: 1 });
    expect(row('IV therapy')).toMatchObject({ booked: 1, attended: 0, noShows: 0 });
    expect(row('Vitamin shots & injections')).toMatchObject({ booked: 2, attended: 1, noShows: 1 });
    expect(row('Consults')).toMatchObject({ booked: 1, attended: 1 });
    expect(row('Bloodwork')).toMatchObject({ booked: 1, attended: 1 });
    expect(row('Other')).toMatchObject({ booked: 1, attended: 1 });
    expect(t.rows.map((r) => r.category)).toEqual(['Chiropractic', 'Hyperbaric oxygen (HBOT)', 'Red light', 'IV therapy', 'Vitamin shots & injections', 'Consults', 'Bloodwork', 'Other']);
    expect(t.totals).toEqual({ category: 'Total', booked: 11, attended: 8, noShows: 2 });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('access', () => {
  const ACCOUNTING = ['monthly', 'daily', 'members', 'custom'];
  const REPORTS = ['signups', 'walkins-day', 'walkins-hour', 'weekend', 'demand'];

  it('is closed to anonymous callers', async () => {
    for (const v of ACCOUNTING) expect((await get(null, `/api/accounting/${v}`)).status).toBe(401);
    for (const v of REPORTS) expect((await get(null, `/api/reports/${v}`)).status).toBe(401);
    expect((await get(null, '/api/accounting/options')).status).toBe(401);
  });

  it('keeps Accounting to administrators: the front desk and providers are refused, and the refusal is audited', async () => {
    for (const s of [ctx.fd, await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'] })).email)]) {
      for (const v of ACCOUNTING) expect((await get(s, `/api/accounting/${v}?format=csv`)).status, v).toBe(403);
      expect((await get(s, '/api/accounting/options')).status).toBe(403);
    }
    const denied = await auditRows({ action: 'ACCESS_DENIED', resourceType: 'route', meta: { path: ['path'], equals: '/api/accounting/members' } }, 2);
    expect(denied.every((r) => r.success === false)).toBe(true);
    expect(denied.map((r) => r.actorRoles).sort()).toEqual(['FRONT_DESK', 'PROVIDER_CHIRO']);
  });

  it('lets the front desk and administrators read Reports, and refuses providers', async () => {
    for (const v of REPORTS) {
      expect((await get(ctx.fd, `/api/reports/${v}`)).status, `fd ${v}`).toBe(200);
      expect((await get(ctx.admin, `/api/reports/${v}`)).status, `admin ${v}`).toBe(200);
    }
    const provider = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'] })).email);
    for (const v of REPORTS) expect((await get(provider, `/api/reports/${v}`)).status, `provider ${v}`).toBe(403);
  });

  it('lets an administrator read every Accounting view', async () => {
    for (const v of ACCOUNTING) expect((await get(ctx.admin, `/api/accounting/${v}`)).status, v).toBe(200);
    const o = await get(ctx.admin, '/api/accounting/options');
    expect(o.status).toBe(200);
    expect(o.body.paymentTypes.map((p: { value: string }) => p.value)).toEqual(['CASH', 'MEMBER', 'DUES']);
    expect(o.body.services.length).toBeGreaterThan(0);
    expect(o.body.providers.every((p: object) => Object.keys(p).sort().join() === 'id,name')).toBe(true);   // an id and a name: staff, never patients
    expect(o.body.groups).toContain('provider');
  });
});

describe('the endpoints', () => {
  it('default to the current month in clinic time and say which range they used', async () => {
    setClockForTests(CDT('2033-05-15T12:00:00'));
    try {
      const r = await get(ctx.admin, '/api/accounting/daily');
      expect(r.body.range).toEqual(MAY);
      expect(r.body.totals).toMatchObject(metrics(sales.filter((s) => s.month === '2033-05')));
      expect(r.body.title).toBe('Daily revenue');
    } finally { setClockForTests(null); }
  });

  it('return the totals row in cents with the column kinds the screen formats by', async () => {
    const r = await get(ctx.admin, `/api/accounting/monthly?from=${WHOLE.from}&to=${WHOLE.to}`);
    expect(r.status).toBe(200);
    expect(r.body.columns.map((c: { key: string }) => c.key)).toEqual(['month', 'service', 'visits', 'listCents', 'discountCents', 'netCents', 'coveredCents', 'credits']);
    expect(r.body.columns.find((c: { key: string }) => c.key === 'netCents').kind).toBe('money');
    expect(r.body.totals).toMatchObject({ month: 'Total', ...metrics(sales) });
    expect(r.body.notes.join(' ')).toMatch(/Membership dues are billed when each month's credits are granted and are shown below, separately/);
  });

  it('apply the custom view\'s filters and grouping, and refuse an unknown service or provider', async () => {
    const q = `from=${WHOLE.from}&to=${WHOLE.to}&serviceId=${ctx.s1999.service.id}&paymentType=CASH&group=tier`;
    const r = await get(ctx.admin, `/api/accounting/custom?${q}`);
    expect(r.status).toBe(200);
    expect(r.body.filters).toEqual({ serviceId: ctx.s1999.service.id, paymentType: 'CASH', group: 'tier' });
    expect(r.body.totals).toMatchObject(metrics(sales.filter((s) => s.service === ctx.s1999.service.name && s.payment === 'CASH')));
    expect((await get(ctx.admin, `/api/accounting/custom?serviceId=nope`)).body.code).toBe('unknown_service');
    expect((await get(ctx.admin, `/api/accounting/custom?providerId=nope`)).body.code).toBe('unknown_provider');
    expect((await get(ctx.admin, '/api/accounting/custom?group=patient')).status).toBe(400);
  });

  it('refuse a parameter they do not understand rather than ignore it', async () => {
    expect((await get(ctx.admin, '/api/accounting/daily?serviceId=x')).status).toBe(400);          // filters belong to the custom view only
    expect((await get(ctx.admin, '/api/accounting/daily?patientId=x')).status).toBe(400);
    expect((await get(ctx.admin, '/api/reports/signups?foo=1')).status).toBe(400);
    expect((await get(ctx.admin, '/api/accounting/daily?from=2033-05-01')).body.code).toBe('bad_range');
    expect((await get(ctx.admin, '/api/accounting/daily?from=2033-05-02&to=2033-05-01')).body.code).toBe('bad_range');
    expect((await get(ctx.admin, '/api/accounting/daily?from=2033-02-31&to=2033-03-01')).body.code).toBe('bad_date');
    expect((await get(ctx.admin, '/api/accounting/daily?format=xml')).status).toBe(400);
    expect((await get(ctx.admin, '/api/accounting/nope')).status).toBe(404);
    expect((await get(ctx.admin, '/api/accounting/constructor')).status).toBe(404);               // not a prototype property
    expect((await get(ctx.admin, '/api/reports/__proto__')).status).toBe(404);
  });

  it('export a CSV with the totals row, a download name, and no caching', async () => {
    const r = await get(ctx.admin, `/api/accounting/members?from=${WHOLE.from}&to=${WHOLE.to}&format=csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="nextwave-members-${WHOLE.from}_to_${WHOLE.to}.csv"`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.text.charCodeAt(0)).toBe(0xfeff);          // a byte-order mark, so a spreadsheet reads the dashes in the labels as UTF-8
    const text = r.text.slice(1);
    // Two tables, a blank line apart: service revenue, then the dues billed, each with its own header and totals.
    const [serviceTable, duesTable_] = text.trim().split('\r\n\r\n').map((t) => t.split('\r\n'));
    expect(serviceTable![0]).toBe('Service revenue');
    expect(serviceTable![1]).toBe('"Who paid, and how",Visits,List price,Discount,Net,Covered by membership,Credits redeemed');
    expect(serviceTable).toContain(`Member — credits,1,100.00,0.00,0.00,100.00,2`);
    expect(serviceTable!.at(-1)).toBe(`Total,${sales.length},${dollars(sum(sales, 'list'))},${dollars(sum(sales, 'discount'))},${dollars(sum(sales, 'net'))},${dollars(sum(sales, 'covered'))},${sum(sales, 'credits')}`);
    expect(serviceTable!.some((l) => l.startsWith('All members,'))).toBe(true);
    expect(serviceTable!.some((l) => l.startsWith('Non-members,'))).toBe(true);
    expect(duesTable_![0]).toBe('Membership dues (billed)');
    expect(duesTable_![1]).toBe('Tier,Months billed,Dues billed');
    expect(duesTable_).toContain(`${ctx.restore.code},4,492.00`);
    expect(duesTable_).toContain(`${ctx.prevent.code},1,150.00`);
    expect(duesTable_!.at(-1)).toBe('Total,5,642.00');
  });

  it('defuse a service name that starts like a formula in the exported file', async () => {
    const hostile = await creditService({ priceCents: 5000, creditCost: 1 });
    await prisma.service.update({ where: { id: hostile.service.id }, data: { name: '=HYPERLINK("http://x.test","hi")' } });
    const { booking } = await checkedInVisit(hostile, null);
    await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: ctx.accountId, now: CDT('2033-09-05T10:00:00'), payment: 'CASH' }));
    const r = await get(ctx.admin, '/api/accounting/monthly?from=2033-09-01&to=2033-09-30&format=csv');
    expect(r.text).toContain(`2033-09,"'=HYPERLINK(""http://x.test"",""hi"")",1,50.00,0.00,50.00,0.00,0`);
  });
});

describe('no patient is named or identified', () => {
  it('in any view, as JSON or CSV, even for a patient whose every field is distinctive', async () => {
    const marker = `Zyxwv${Date.now().toString(36)}`;
    const p = await makePatient({ firstName: marker, lastName: `${marker}son`, phone: '6125559999', email: `${marker}@example.test` });
    const m = await makeMembership(p.id, 'RESTORE', '2035-02-10');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2035-02-10', now: at('2035-02-10T12:00:00Z') });
    const clinic = await creditService({ priceCents: 7000, creditCost: 2 });
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    await prisma.booking.update({ where: { id: booking.id }, data: { startTime: CST('2035-02-10T10:00:00'), endTime: CST('2035-02-10T10:30:00'), source: 'WALK_IN' } });
    await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: ctx.accountId, now: CST('2035-02-10T10:30:00'), payment: 'CREDITS' }));

    const range = 'from=2035-02-01&to=2035-02-28';
    const ids = [p.id, booking.id, encounter.id, booking.userId, marker, '6125559999'];
    const urls = [
      ...['monthly', 'daily', 'members'].map((v) => `/api/accounting/${v}?${range}`),
      ...['service', 'month', 'day', 'serviceMonth', 'paymentType', 'bucket', 'provider', 'category', 'discountCategory', 'tier'].map((g) => `/api/accounting/custom?${range}&group=${g}`),
      ...['signups', 'walkins-day', 'walkins-hour', 'weekend', 'demand'].map((v) => `/api/reports/${v}?${range}`),
    ];
    for (const u of urls) {
      for (const [client, withCsv] of [[ctx.admin, ''], [ctx.admin, '&format=csv']] as const) {
        const r = await get(client, u + withCsv);
        expect(r.status, u).toBe(200);
        const body = withCsv ? r.text : blob(r.body);
        for (const id of ids) expect(body, `${u}${withCsv} leaked ${id.slice(0, 6)}`).not.toContain(id);
      }
    }
    // The visit itself is in the numbers — it is just not named.
    const r = await get(ctx.admin, `/api/accounting/daily?${range}`);
    expect(r.body.totals).toMatchObject({ visits: 1, listCents: 7000, netCents: 0, coveredCents: 7000, credits: 2 });
    // Front desk sees the same aggregates and nothing more.
    for (const v of ['signups', 'walkins-day', 'walkins-hour', 'weekend', 'demand']) {
      const fd = await get(ctx.fd, `/api/reports/${v}?${range}`);
      for (const id of ids) expect(blob(fd.body)).not.toContain(id);
    }
  });
});

describe('audit', () => {
  it('records every view as a READ and every export as an EXPORT, with the filters it was asked with', async () => {
    const admin = await adminLogin();
    const q = `from=${WHOLE.from}&to=${WHOLE.to}&serviceId=${ctx.s100.service.id}&paymentType=MEMBER&group=month`;
    expect((await get(admin, `/api/accounting/custom?${q}`)).status).toBe(200);
    expect((await get(admin, `/api/accounting/custom?${q}&format=csv`)).status).toBe(200);

    // Specific to this request (other tests also ask the custom view about this service), so match on two of its parameters.
    const where = { resourceType: 'accounting_report', resourceId: 'custom', AND: [{ meta: { path: ['serviceId'], equals: ctx.s100.service.id } }, { meta: { path: ['paymentType'], equals: 'MEMBER' } }] };
    const [view] = await auditRows({ ...where, action: 'READ' });
    const [exp] = await auditRows({ ...where, action: 'EXPORT' });
    const asked = { view: 'custom', from: WHOLE.from, to: WHOLE.to, serviceId: ctx.s100.service.id, paymentType: 'MEMBER', group: 'month' };
    expect(view).toMatchObject({ success: true });
    expect(view!.meta).toMatchObject({ ...asked, format: 'json' });
    expect(exp!.meta).toMatchObject({ ...asked, format: 'csv' });
    expect(view!.actorAccountId).toBeTruthy();
    expect(view!.actorAccountId).toBe(exp!.actorAccountId);
  });

  it('writes a row for every look at the same report — views are not de-duplicated', async () => {
    const admin = await adminLogin();
    for (let i = 0; i < 3; i++) expect((await get(admin, '/api/reports/demand?from=2034-11-01&to=2034-11-02')).status).toBe(200);
    const rows = await auditRows({ action: 'READ', resourceType: 'clinic_report', resourceId: 'demand', meta: { path: ['from'], equals: '2034-11-01' } }, 3);
    expect(rows).toHaveLength(3);
  });

  it('audits a front-desk view with that account\'s role, and the row holds only the parameters and a row count', async () => {
    const fd = await fdLogin();
    await get(fd, '/api/reports/weekend?from=2034-12-04&to=2034-12-10');
    const [row] = await auditRows({ action: 'READ', resourceType: 'clinic_report', resourceId: 'weekend', meta: { path: ['from'], equals: '2034-12-04' } });
    expect(row!.actorRoles).toContain('FRONT_DESK');
    expect(Object.keys(row!.meta as object).sort()).toEqual(['format', 'from', 'rows', 'to', 'view']);
  });

  it('does not audit a request that was refused for its parameters as if it had returned data', async () => {
    const admin = await adminLogin();
    expect((await get(admin, '/api/reports/signups?from=2034-12-11&to=2034-12-10')).status).toBe(400);
    await new Promise((r) => setTimeout(r, 150));
    expect(await basePrisma.auditLog.count({ where: { resourceType: 'clinic_report', meta: { path: ['from'], equals: '2034-12-11' } } })).toBe(0);
  });
});

describe('indexes', () => {
  it('the columns every report filters on are indexed', async () => {
    const rows = await basePrisma.$queryRaw<Array<{ tablename: string; indexdef: string }>>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('RevenueEvent', 'Booking', 'Membership')`;
    const plain = (x: string) => x.replace(/"/g, '');   // pg prints simple names bare: (source, "startTime")
    const has = (table: string, cols: string) => rows.some((r) => r.tablename === table && plain(r.indexdef).includes(`(${plain(cols)})`));
    expect(has('RevenueEvent', '"occurredAt"')).toBe(true);
    expect(has('RevenueEvent', '"serviceId", "occurredAt"')).toBe(true);
    expect(has('RevenueEvent', '"staffId", "occurredAt"')).toBe(true);
    expect(has('Booking', '"source", "startTime"')).toBe(true);
    expect(has('Membership', '"startedOn"')).toBe(true);
  });
});

describe('the staffId backfill', () => {
  it('fills a revenue event written before the column existed from its booking, and leaves the table append-only', async () => {
    const ev = await basePrisma.revenueEvent.findFirstOrThrow({ where: { serviceId: ctx.s100.service.id, staffId: { not: null } } });
    const migration = readFileSync(new URL('../prisma/migrations/20261018100000_phase5_reporting/migration.sql', import.meta.url), 'utf8');
    const backfill = migration.match(/UPDATE "RevenueEvent"[\s\S]*?;/)![0];
    expect(migration).toMatch(/DISABLE TRIGGER "RevenueEvent_no_update_delete"[\s\S]*UPDATE "RevenueEvent"[\s\S]*ENABLE TRIGGER "RevenueEvent_no_update_delete"/);

    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "RevenueEvent" DISABLE TRIGGER "RevenueEvent_no_update_delete"');
      await tx.$executeRawUnsafe(`UPDATE "RevenueEvent" SET "staffId" = NULL WHERE "id" = '${ev.id}'`);   // as if written before the column
      await tx.$executeRawUnsafe(backfill);
      await tx.$executeRawUnsafe('ALTER TABLE "RevenueEvent" ENABLE TRIGGER "RevenueEvent_no_update_delete"');
    });

    expect((await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: ev.id } })).staffId).toBe(ev.staffId);
    await expect(basePrisma.$executeRawUnsafe(`UPDATE "RevenueEvent" SET "staffId" = NULL WHERE "id" = '${ev.id}'`)).rejects.toThrow(/append-only/);
  });
});
