import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { basePrisma } from '../src/lib/prismaBase.js';
import { prisma } from '../src/lib/prisma.js';
import { setClockForTests } from '../src/lib/clock.js';
import { balanceOf, chargesOf } from '../src/lib/money.js';
import { auditRows } from './helpers.js';
import { makePatient, post, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, providerLogin, visit, type VisitOpts } from './phase4.js';
import { grantLot, ledgerSum, makeMembership, makePlan } from './phase3.js';

/**
 * Phase 2c-A (SPEC rev 2.3): the Charges window — add-on services and retail products, open until check-out — and sales tax, through
 * the HTTP surface. docs/CHARGES_DESIGN.md §12 lists the owner's decisions these tests hold the code to. The clock is Tuesday
 * 2026-10-13, 10:07 in Chicago, unless a test moves it. The clinic's sales-tax rate is the seeded 5.5% (5500).
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));
afterEach(() => setClockForTests(TUESDAY_1007));

const key = () => `t${randomUUID().replace(/-/g, '')}`;
type S = Awaited<ReturnType<typeof frontDeskLogin>>;
const at = (hhmm: string, date = '2026-10-13') => slotAt(hhmm, date);
const RATE = 5500;
/** 5.5% of `net`, halves up — written out by hand, not with the code under test. */
const tax55 = (net: number) => Math.floor((net * 55 + 500) / 1000);

let n = 0;
async function product(o: { price?: number; taxable?: boolean; tierDiscount?: boolean; name?: string; category?: string; active?: boolean } = {}) {
  return basePrisma.product.create({
    data: { name: o.name ?? `Test product ${Date.now().toString(36)}${++n}`, category: o.category ?? 'Supplements', priceCents: o.price ?? 3500,
      taxable: o.taxable ?? true, tierDiscount: o.tierDiscount ?? true, active: o.active ?? true },
  });
}
const bodyComp = () => basePrisma.service.findFirstOrThrow({ where: { slug: 'body-composition' } });

async function ledger(s: S, patientId: string) {
  const r = await s.agent.get(`/api/fd/patients/${patientId}/ledger`);
  expect(r.status).toBe(200);
  return r.body;
}
const add = (s: S, patientId: string, item: { serviceId?: string; productId?: string; performedByStaffId?: string }, extra: Record<string, unknown> = {}) =>
  post(s, `/api/fd/patients/${patientId}/charges`, { idempotencyKey: key(), ...item, ...extra });
const remove = (s: S, patientId: string, chargeId: string) => post(s, `/api/fd/patients/${patientId}/charges/${chargeId}/remove`, { idempotencyKey: key() });
async function openLines(s: S, patientId: string) {
  const r = await s.agent.get(`/api/fd/patients/${patientId}/charges`);
  expect(r.status).toBe(200);
  return r.body as { lines: any[]; totals: any; catalog: any };
}
async function checkout(s: S, patientId: string, body: Record<string, unknown>, version?: string) {
  const v = version ?? (await ledger(s, patientId)).money.version;
  return post(s, `/api/fd/patients/${patientId}/checkout`, { idempotencyKey: key(), expectedVersion: v, ...body });
}
/** Every open line paid in money, at the net the screen shows. */
async function allMoney(s: S, patientId: string) {
  return (await openLines(s, patientId)).lines.map((l: any) => ({ openChargeId: l.id, pay: 'MONEY', expectedNetCents: l.netCents }));
}
async function priced(o: VisitOpts & { patientId: string }, price = 5500) {
  const v = await visit({ encounter: 'CHECKED_IN', ...o });
  await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: price, creditCost: 2 } });
  return v;
}
function checkRunning(l: any) {
  const posted = l.money.posted as Array<{ amountCents: number; balanceAfterCents: number }>;
  expect(posted.reduce((t, e) => t + e.amountCents, 0)).toBe(l.money.balanceCents);
  expect(posted.length ? posted[posted.length - 1]!.balanceAfterCents : 0).toBe(l.money.balanceCents);
}

// =====================================================================================================================================

describe('the catalog and the Charges window', () => {
  it('offers InBody (the body-composition service) as a service add-on and the active products by group; never an inactive one', async () => {
    const fd = await frontDeskLogin();
    const live = await product({ name: `Visible ${n}` });
    const off = await product({ name: `Hidden ${n}`, active: false });
    const r = await fd.agent.get('/api/charges/catalog');
    expect(r.status).toBe(200);
    const bc = await bodyComp();
    const addOns = r.body.groups.find((g: any) => g.name === 'Service add-ons');
    expect(addOns.items).toContainEqual({ kind: 'SERVICE', id: bc.id, name: bc.name, group: 'Service add-ons', priceCents: 5500, taxable: false });
    const supplements = r.body.groups.find((g: any) => g.name === 'Supplements');
    expect(supplements.items.map((i: any) => i.id)).toContain(live.id);
    expect(JSON.stringify(r.body)).not.toContain(off.id);
    expect(r.body.taxRateMilli).toBe(RATE);
    // the seeded placeholders are there, clearly marked
    expect(supplements.items.filter((i: any) => /\(placeholder\)$/.test(i.name)).length).toBeGreaterThanOrEqual(3);
  });

  it('adds a line once per click (a double submit adds one), removes it before check-out with a removal row, and never twice', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const pr = await product();
    const k = key();
    const first = await post(fd, `/api/fd/patients/${p.id}/charges`, { idempotencyKey: k, productId: pr.id });
    const again = await post(fd, `/api/fd/patients/${p.id}/charges`, { idempotencyKey: k, productId: pr.id });
    expect(first.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect((await post(fd, `/api/fd/patients/${p.id}/charges`, { idempotencyKey: k, productId: (await product()).id })).body.code).toBe('idempotency_key_reused');
    expect((await openLines(fd, p.id)).lines.map((l) => l.id)).toEqual([first.body.id]);

    expect((await remove(fd, p.id, first.body.id)).status).toBe(200);
    expect(await basePrisma.openChargeRemoval.count({ where: { openChargeId: first.body.id } })).toBe(1);
    expect(await basePrisma.openCharge.count({ where: { id: first.body.id } })).toBe(1);              // still there: append-only
    expect((await openLines(fd, p.id)).lines).toEqual([]);
    expect((await remove(fd, p.id, first.body.id)).body.code).toBe('already_removed');
  });

  it('scopes every line to its patient, refuses what is not on the menu, and audits by ids only', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient({ firstName: 'Quillon', lastName: 'Arbatt' });
    const other = await makePatient();
    const pr = await product({ name: 'Distinctive Tonic', price: 4321 });
    const added = await add(fd, p.id, { productId: pr.id });
    expect((await remove(fd, other.id, added.body.id)).body.code).toBe('unknown_charge');
    expect((await add(fd, p.id, { productId: (await product({ active: false })).id })).body.code).toBe('unknown_item');
    const notAddOn = await visit({ encounter: null, requiresNote: false });
    expect((await add(fd, p.id, { serviceId: notAddOn.service.id })).body.code).toBe('unknown_item');
    const needsNote = await visit({ encounter: null, requiresNote: true });
    await basePrisma.service.update({ where: { id: needsNote.service.id }, data: { offerAsAddOn: true, priceCents: 5000 } });
    expect((await add(fd, p.id, { serviceId: needsNote.service.id })).body.code).toBe('needs_a_visit');
    expect((await add(fd, p.id, { productId: pr.id, performedByStaffId: (await prisma.staff.findFirstOrThrow()).id })).body.code).toBe('performer_only_for_services');
    expect((await add(fd, p.id, { productId: pr.id, serviceId: (await bodyComp()).id })).status).toBe(400);
    const rows = await auditRows({ resourceType: 'open_charge', resourceId: added.body.id });
    const text = JSON.stringify(rows.map((r: any) => r.meta));
    expect(text).not.toMatch(/Distinctive|4321|Quillon|Arbatt/);
    expect(rows[0]!.meta).toMatchObject({ kind: 'PRODUCT', itemId: pr.id });
  });
});

describe('who adds charges (decision 4)', () => {
  it('a provider adds from their visit workspace; the desk sees it at once, and a check-out on the old screen is refused with the fresh state', async () => {
    const fd = await frontDeskLogin();
    const prov = await providerLogin('PROVIDER_CHIRO');
    const p = await makePatient();
    const v = await priced({ patientId: p.id, staffId: prov.staff.id, start: at('09:00') });
    const pr = await product();
    const before = (await ledger(fd, p.id)).money.version;

    const r = await post(prov, `/api/provider/visits/${v.booking.id}/charges`, { idempotencyKey: key(), productId: pr.id });
    expect(r.status).toBe(200);
    const desk = await openLines(fd, p.id);
    expect(desk.lines.map((l) => [l.id, l.name, l.bookingId])).toEqual([[r.body.id, pr.name, v.booking.id]]);
    expect((await ledger(fd, p.id)).openCharges.lines.map((l: any) => l.id)).toEqual([r.body.id]);
    // the desk's screen was loaded before the provider added it: confirming is refused, with the ledger as it is now
    const stale = await checkout(fd, p.id, { visits: [{ bookingId: v.booking.id, pay: 'MONEY' }] }, before);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('ledger_changed');
    expect(stale.body.ledger.openCharges.lines.map((l: any) => l.id)).toEqual([r.body.id]);

    // the provider sees the lines, not the patient's credits or perks; and can remove one before check-out
    const seen = await prov.agent.get(`/api/provider/visits/${v.booking.id}/charges`);
    expect(seen.status).toBe(200);
    expect(seen.body.lines[0]).not.toHaveProperty('credits');
    expect((await post(prov, `/api/provider/visits/${v.booking.id}/charges/${r.body.id}/remove`, { idempotencyKey: key() })).status).toBe(200);
    expect((await openLines(fd, p.id)).lines).toEqual([]);
    const audit = await auditRows({ resourceType: 'open_charge', resourceId: r.body.id, action: 'DELETE' });
    expect(audit[0]).toMatchObject({ actorAccountId: prov.accountId });
  });

  it('only the visit\'s provider, only before check-out; the desk and admins use the desk\'s own route', async () => {
    const owner = await providerLogin('PROVIDER_CHIRO');
    const colleague = await providerLogin('PROVIDER_CHIRO');
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const v = await priced({ patientId: p.id, staffId: owner.staff.id, start: at('09:30') });
    const pr = await product();
    const url = `/api/provider/visits/${v.booking.id}/charges`;
    expect((await post(colleague, url, { idempotencyKey: key(), productId: pr.id })).body.code).toBe('not_visit_provider');
    expect((await post(fd, url, { idempotencyKey: key(), productId: pr.id })).status).toBe(403);
    const admin = await adminLogin();
    expect((await post(admin, url, { idempotencyKey: key(), productId: pr.id })).status).toBe(403);
    expect((await add(admin, p.id, { productId: pr.id })).status).toBe(200);                       // the admin, at the desk
    await basePrisma.encounter.update({ where: { bookingId: v.booking.id }, data: { status: 'CHECKED_OUT' } });
    expect((await post(owner, url, { idempotencyKey: key(), productId: pr.id })).body.code).toBe('not_open');
    const unlinked = await priced({ patientId: null as unknown as string, staffId: owner.staff.id, start: at('10:30') });
    expect((await post(owner, `/api/provider/visits/${unlinked.booking.id}/charges`, { idempotencyKey: key(), productId: pr.id })).body.code).toBe('no_patient');
  });
});

describe('sales tax (decision 2)', () => {
  it('a product: 5.5% of its net, per line, halves up — and the database holds the same formula', async () => {
    const fd = await frontDeskLogin();
    for (const [price, expected] of [[3500, 193], [3499, 192], [1, 0], [9, 0], [10, 1], [2000, 110], [1818, 100]] as const) {
      const p = await makePatient();
      const pr = await product({ price });
      await add(fd, p.id, { productId: pr.id });
      const [line] = (await openLines(fd, p.id)).lines;
      expect([line.taxRateMilli, line.netCents, line.taxCents], `${price}`).toEqual([RATE, price, expected]);
      expect(expected).toBe(tax55(price));
      const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'CASH', amountCents: price + expected } });
      expect(r.status, `${price}`).toBe(200);
      expect(r.body.charges[0]).toMatchObject({ netPriceCents: price, taxRateMilli: RATE, taxCents: expected });
      expect(r.body.balanceCents).toBe(0);
    }
  });

  it('a service is never taxed — InBody included — and a non-taxable product is not either', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    await add(fd, p.id, { serviceId: (await bodyComp()).id });
    await add(fd, p.id, { productId: (await product({ taxable: false })).id });
    const view = await openLines(fd, p.id);
    expect(view.lines.map((l) => [l.kind, l.taxRateMilli, l.taxCents])).toEqual([['SERVICE', 0, 0], ['PRODUCT', 0, 0]]);
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'CARD', amountCents: 5500 + 3500 } });
    expect(r.body.charges.map((c: any) => c.taxCents)).toEqual([0, 0]);
    // and the database refuses a taxed service, whatever the application does
    const bc = await bodyComp();
    await expect(basePrisma.openCharge.create({ data: { patientId: p.id, serviceId: bc.id, name: 'x', category: 'x', unitPriceCents: 100, taxRateMilli: 5500, addedOn: new Date('2026-10-13'), addedAt: new Date(), addedById: 'test' } }))
      .rejects.toThrow(/OpenCharge_shape/);
  });

  it('is shown on its own line under the product, by name, on the Ledger and the receipt; the balance includes it', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const pr = await product({ price: 3500, name: `Magnesium glycinate ${n}` });
    await add(fd, p.id, { productId: pr.id });
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id) });                       // nothing paid yet
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ kind: 'PRODUCT', name: pr.name, listPriceCents: 3500, netPriceCents: 3500, taxCents: 193 });
    const l = await ledger(fd, p.id);
    const lines = l.money.posted.map((e: any) => [e.kind, e.serviceName, e.amountCents]);
    expect(lines).toEqual([['charge', pr.name, 3500], ['tax', pr.name, 193]]);
    expect(l.money.posted[0].lineKind).toBe('PRODUCT');
    expect(l.money.balanceCents).toBe(3693);
    expect(await balanceOf(basePrisma, p.id)).toBe(3693);
    checkRunning(l);
  });
});

describe('member discounts, promotions and credits on products (decision 3)', () => {
  it('the tier discount on an eligible product, per tier — 10 / 15 / 20 — only for an ACTIVE member; tax on what is left', async () => {
    const fd = await frontDeskLogin();
    const pr = await product({ price: 3500 });
    const cases = [['PREVENT', 'ACTIVE', 10, 350], ['RESTORE', 'ACTIVE', 15, 525], ['OPTIMIZE', 'ACTIVE', 20, 700], ['OPTIMIZE', 'PAUSED', 0, 0], [null, null, 0, 0]] as const;
    for (const [plan, status, percent, off] of cases) {
      const p = await makePatient();
      if (plan) await makeMembership(p.id, plan, '2026-10-01', { status: status! });
      await add(fd, p.id, { productId: pr.id });
      const [line] = (await openLines(fd, p.id)).lines;
      const net = 3500 - off;
      expect([line.tierPercent, line.discountCents, line.netCents, line.taxCents], `${plan} ${status}`).toEqual([percent, off, net, tax55(net)]);
      const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'HSA_FSA', amountCents: net + tax55(net) } });
      expect(r.status).toBe(200);
      const ev = await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: r.body.charges[0].revenueEventId } });
      expect([ev.discountPercent, ev.discountCents, ev.netPriceCents, ev.taxCents, ev.discountCategory]).toEqual([percent, off, net, tax55(net), off ? 'PRODUCTS' : null]);
    }
  });

  it('a product not marked eligible gets no tier discount; the percentages are the admin\'s settings', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const { plan } = await makePlan();
    const p = await makePatient();
    await basePrisma.membership.create({ data: { patientId: p.id, planId: plan.id, status: 'ACTIVE', startedOn: new Date('2026-10-01'), nextGrantOn: new Date('2026-11-01'), createdById: 'test' } });
    const eligible = await product({ price: 2000 });
    const not = await product({ price: 2000, tierDiscount: false });
    expect((await admin.agent.put('/api/admin/catalog/product-discounts').set('x-csrf-token', admin.csrf).send({ discounts: [{ planId: plan.id, percent: 30 }] })).status).toBe(200);
    await add(fd, p.id, { productId: eligible.id });
    await add(fd, p.id, { productId: not.id });
    expect((await openLines(fd, p.id)).lines.map((l) => [l.tierPercent, l.discountCents])).toEqual([[30, 600], [0, 0]]);
  });

  it('a promotion on a product: the better of it and the tier discount, never both; a tie keeps the tier; by the day the line was added', async () => {
    const fd = await frontDeskLogin();
    const pr = await product({ price: 4000 });
    const promo = (value: number, startsOn = '2026-10-01', endsOn = '2026-10-31') => basePrisma.promotion.create({
      data: { name: `Product promo ${value}`, kind: 'PERCENT', value, startsOn: new Date(`${startsOn}T00:00:00Z`), endsOn: new Date(`${endsOn}T00:00:00Z`), createdById: 'test', products: { create: [{ productId: pr.id }] } },
    });
    const p = await makePatient();
    await makeMembership(p.id, 'OPTIMIZE', '2026-10-01');                                              // 20% on products
    const p15 = await promo(15);
    await add(fd, p.id, { productId: pr.id });
    let [line] = (await openLines(fd, p.id)).lines;
    expect([line.discountCents, line.promotion]).toEqual([800, null]);                                // the tier is better
    await basePrisma.promotion.update({ where: { id: p15.id }, data: { active: false } });
    await promo(20);                                                                                  // a tie: the tier
    [line] = (await openLines(fd, p.id)).lines;
    expect([line.discountCents, line.promotion]).toEqual([800, null]);
    const p25 = await promo(25);
    [line] = (await openLines(fd, p.id)).lines;
    expect([line.discountCents, line.promotion?.id, line.promotion?.cents, line.netCents, line.taxCents]).toEqual([0, p25.id, 1000, 3000, tax55(3000)]);
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'CASH', amountCents: 3000 + tax55(3000) } });
    const ev = await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: r.body.charges[0].revenueEventId } });
    expect([ev.promotionId, ev.promotionCents, ev.discountCents]).toEqual([p25.id, 1000, 0]);

    // by the ADDED day: a line added on the promotion's last day keeps it at a check-out the next morning; one added the day after does not
    const late = await makePatient();
    const lastDay = await product({ price: 1000 });
    await basePrisma.promotion.create({ data: { name: 'Ends today', kind: 'PERCENT', value: 50, startsOn: new Date('2026-10-01T00:00:00Z'), endsOn: new Date('2026-10-13T00:00:00Z'), createdById: 'test', products: { create: [{ productId: lastDay.id }] } } });
    setClockForTests(new Date('2026-10-14T04:59:00Z'));                                               // 23:59 on the 13th in Chicago
    await add(fd, late.id, { productId: lastDay.id });
    setClockForTests(new Date('2026-10-14T05:00:00Z'));                                               // 00:00 on the 14th
    await add(fd, late.id, { productId: lastDay.id });
    expect((await openLines(fd, late.id)).lines.map((l) => [l.addedOn, l.promotion?.cents ?? 0])).toEqual([['2026-10-13', 500], ['2026-10-14', 0]]);
  });

  it('membership credits and perks never pay for a product — refused by the server and by the database', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    await makeMembership(p.id, 'OPTIMIZE', '2026-10-01');
    const pr = await product();
    const { body } = await add(fd, p.id, { productId: pr.id });
    for (const pay of ['CREDITS', 'PERK']) {
      const r = await checkout(fd, p.id, { charges: [{ openChargeId: body.id, pay, perkId: 'x' }] });
      expect(r.status, pay).toBe(400);
      expect(r.body.code).toBe('credits_not_for_products');
    }
    expect(await basePrisma.creditLedger.count({ where: { patientId: p.id } })).toBe(0);
    await expect(basePrisma.$executeRawUnsafe(`INSERT INTO "RevenueEvent" ("id","patientId","productId","openChargeId","serviceName","serviceCategory","listPriceCents","paymentType","memberBenefit","creditsRedeemed","netPriceCents","occurredAt","recordedById")
      VALUES ('${randomUUID()}','${p.id}','${pr.id}','${body.id}','x','x',3500,'MEMBER','CREDITS',2,0,now(),'test')`)).rejects.toThrow(/RevenueEvent_kind/);
  });
});

describe('InBody is body composition (decision 3d)', () => {
  it('prices exactly as a booked body-composition visit: the same list price, credit rule and perks; never taxed', async () => {
    const fd = await frontDeskLogin();
    const bc = await bodyComp();
    const { plan } = await makePlan({ perks: [{ key: 'quarterly_body_composition', period: 'QUARTERLY', quantity: 1, serviceIds: [bc.id] }] });
    const p = await makePatient();
    const m = await basePrisma.membership.create({ data: { patientId: p.id, planId: plan.id, status: 'ACTIVE', startedOn: new Date('2026-10-01'), nextGrantOn: new Date('2026-11-01'), createdById: 'test' } });
    // a booked body-composition visit for the same patient: the check-out screen's own figures
    const room = await basePrisma.resource.create({ data: { name: `BC room ${n++}`, type: 'TEST_ROOM', maxCapacity: 1 } });
    const user = await basePrisma.user.create({ data: { name: 'BC', email: '', phone: '6125550000' } });
    const booking = await basePrisma.booking.create({ data: { userId: user.id, serviceId: bc.id, resourceId: room.id, startTime: at('11:00'), endTime: at('11:15'), status: 'CONFIRMED', source: 'FRONT_DESK', patientId: p.id } });
    await basePrisma.encounter.create({ data: { bookingId: booking.id, status: 'CHECKED_IN', checkedInAt: at('10:55') } });
    const booked = (await fd.agent.get(`/api/fd/appointments/${booking.id}/checkout-preview`)).body.preview;

    await add(fd, p.id, { serviceId: bc.id, performedByStaffId: (await prisma.staff.findFirstOrThrow({ where: { role: 'REGISTERED_NURSE' } })).id });
    const [line] = (await openLines(fd, p.id)).lines;
    expect(line.kind).toBe('SERVICE');
    expect(line.unitPriceCents).toBe(booked.listPriceCents);
    expect(line.credits).toEqual({ cost: booked.credits.cost, available: booked.credits.available, reason: booked.credits.reason });
    expect(line.perks.map((x: any) => x.perkId)).toEqual(booked.perks.map((x: any) => x.perkId));
    expect([line.tierPercent, line.taxRateMilli, line.taxCents]).toEqual([booked.cash.tierPercent, 0, 0]);

    // the membership's inclusion pays for it, as it would for the booked visit
    const r = await checkout(fd, p.id, { charges: [{ openChargeId: line.id, pay: 'PERK', perkId: line.perks[0].perkId }] });
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ kind: 'SERVICE', paymentType: 'MEMBER', memberBenefit: 'PERK', netPriceCents: 0, taxCents: 0 });
    expect(await basePrisma.perkUsage.count({ where: { membershipId: m.id } })).toBe(1);
    const ev = await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: r.body.charges[0].revenueEventId } });
    expect([ev.serviceId, ev.bookingId, ev.encounterId, ev.staffId != null]).toEqual([bc.id, null, null, true]);
    // nothing on the schedule: the add-on made no booking
    expect(await basePrisma.booking.count({ where: { patientId: p.id } })).toBe(1);
    // credits: the same rule as the booked visit (body composition has no credit cost, so not credit-eligible)
    await add(fd, p.id, { serviceId: bc.id });
    const second = (await openLines(fd, p.id)).lines[0];
    expect((await checkout(fd, p.id, { charges: [{ openChargeId: second.id, pay: 'CREDITS' }] })).body.code).toBe('not_credit_eligible');
  });

  it('an add-on service with a credit cost can be paid with credits, like the booked visit', async () => {
    const fd = await frontDeskLogin();
    const s = await visit({ encounter: null, requiresNote: false });
    await basePrisma.service.update({ where: { id: s.service.id }, data: { offerAsAddOn: true, priceCents: 4000, creditCost: 2 } });
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-10-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-01', now: TUESDAY_1007 });
    await add(fd, p.id, { serviceId: s.service.id });
    const [line] = (await openLines(fd, p.id)).lines;
    const r = await checkout(fd, p.id, { charges: [{ openChargeId: line.id, pay: 'CREDITS' }] });
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, taxCents: 0 });
    expect(await ledgerSum(p.id)).toBe(2);
  });
});

describe('snapshots (decision 1)', () => {
  it('a rename, a new price or a new tax rate never changes a line already added, its charge, or the Ledger — only lines added after', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient();
    const pr = await product({ name: `Vitamin D3 ${n}`, price: 2500 });
    const first = await add(fd, p.id, { productId: pr.id });
    const patch = await admin.agent.patch(`/api/admin/catalog/products/${pr.id}`).set('x-csrf-token', admin.csrf).send({ name: `Vitamin D3 (5000 IU) ${n}`, priceCents: 2900 });
    expect(patch.status).toBe(200);
    expect(patch.body.product).toMatchObject({ name: `Vitamin D3 (5000 IU) ${n}`, priceCents: 2900 });
    const audit = await auditRows({ resourceType: 'product', resourceId: pr.id, action: 'UPDATE' });
    expect(audit[0]!.meta).toEqual({ fields: ['name', 'priceCents'] });                                 // field names, never values
    const setRate = (rateMilli: number) => admin.agent.put('/api/admin/catalog/tax-rate').set('x-csrf-token', admin.csrf).send({ rateMilli });
    try {
      expect((await setRate(7000)).status).toBe(200);
      const second = await add(fd, p.id, { productId: pr.id });
      const lines = (await openLines(fd, p.id)).lines;
      expect(lines.map((l) => [l.id, l.name, l.unitPriceCents, l.taxRateMilli])).toEqual([
        [first.body.id, `Vitamin D3 ${n}`, 2500, RATE],
        [second.body.id, `Vitamin D3 (5000 IU) ${n}`, 2900, 7000],
      ]);
      const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id) });
      expect(r.status).toBe(200);
      const evs = await basePrisma.revenueEvent.findMany({ where: { patientId: p.id }, orderBy: { listPriceCents: 'asc' } });
      expect(evs.map((e) => [e.serviceName, e.listPriceCents, e.taxRateMilli, e.taxCents])).toEqual([
        [`Vitamin D3 ${n}`, 2500, RATE, tax55(2500)], [`Vitamin D3 (5000 IU) ${n}`, 2900, 7000, Math.floor((2900 * 7000 + 50_000) / 100_000)],
      ]);
      // rename again: the posted Ledger keeps what was sold
      await admin.agent.patch(`/api/admin/catalog/products/${pr.id}`).set('x-csrf-token', admin.csrf).send({ name: 'Renamed later' });
      expect((await ledger(fd, p.id)).money.posted.filter((e: any) => e.kind === 'charge').map((e: any) => e.serviceName)).not.toContain('Renamed later');
    } finally {
      await setRate(RATE);
    }
  });

  it('the database refuses a charge that does not carry its line\'s snapshots, and a line both removed and checked out', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const pr = await product({ price: 3500 });
    const { body } = await add(fd, p.id, { productId: pr.id });
    const insert = (list: number, name = (body.name as string | undefined) ?? '') => basePrisma.$transaction(async (tx) => {
      const oc = await tx.openCharge.findUniqueOrThrow({ where: { id: body.id } });
      await tx.revenueEvent.create({ data: { patientId: p.id, productId: pr.id, openChargeId: oc.id, serviceName: name || oc.name, serviceCategory: oc.category, listPriceCents: list, netPriceCents: list, taxRateMilli: oc.taxRateMilli, taxCents: Math.floor((list * oc.taxRateMilli + 50_000) / 100_000), paymentType: 'CASH', occurredAt: new Date(), recordedById: 'test' } });
    });
    await expect(insert(3000)).rejects.toThrow(/does not match the open line/);
    await expect(insert(3500, 'Some other name')).rejects.toThrow(/does not match the open line/);
    await remove(fd, p.id, body.id);
    await expect(insert(3500)).rejects.toThrow(/both removed and checked out/);
    await expect(basePrisma.$executeRawUnsafe(`UPDATE "OpenCharge" SET "unitPriceCents" = 1 WHERE "id" = '${body.id}'`)).rejects.toThrow(/append-only/);
    await expect(basePrisma.$executeRawUnsafe(`DELETE FROM "OpenChargeRemoval" WHERE "openChargeId" = '${body.id}'`)).rejects.toThrow(/append-only/);
  });
});

describe('combined check-out with services and products', () => {
  it('Ben: an adjustment and a red light, then InBody and two supplements — itemized, taxed, paid in one go; the Ledger zeroes out', async () => {
    const fd = await frontDeskLogin();
    const ben = await makePatient({ firstName: 'Ben' });
    const adjust = await priced({ patientId: ben.id, start: at('09:00') });
    const red = await priced({ patientId: ben.id, start: at('09:30') });
    const a = await product({ name: `Magnesium glycinate ${n}`, price: 3500 });
    const b = await product({ name: `Vitamin D3 ${n}`, price: 3500 });
    await add(fd, ben.id, { serviceId: (await bodyComp()).id });
    await add(fd, ben.id, { productId: a.id });
    await add(fd, ben.id, { productId: b.id });
    const view = await openLines(fd, ben.id);
    expect(view.totals).toEqual({ listCents: 12500, discountCents: 0, promotionCents: 0, netCents: 12500, taxCents: 386, totalCents: 12886 });
    // $235 before tax at these placeholder prices; $238.86 with 5.5% on the two supplements
    const due = 5500 + 5500 + 12886;
    expect(due).toBe(23886);
    const r = await checkout(fd, ben.id, {
      visits: [{ bookingId: adjust.booking.id, pay: 'MONEY', expectedNetCents: 5500 }, { bookingId: red.booking.id, pay: 'MONEY', expectedNetCents: 5500 }],
      charges: await allMoney(fd, ben.id), payment: { tender: 'HSA_FSA', amountCents: due },
    });
    expect(r.status).toBe(200);
    expect(r.body.visits).toHaveLength(2);
    expect(r.body.charges.map((c: any) => [c.kind, c.name, c.netPriceCents, c.taxCents])).toEqual([
      ['SERVICE', 'Body Composition', 5500, 0], ['PRODUCT', a.name, 3500, 193], ['PRODUCT', b.name, 3500, 193],
    ]);
    expect(r.body.payment.allocations.reduce((t: number, x: any) => t + x.cents, 0)).toBe(due);
    expect(r.body.balanceCents).toBe(0);
    const evs = await basePrisma.revenueEvent.findMany({ where: { patientId: ben.id } });
    expect(new Set(evs.map((e) => e.batchId)).size).toBe(1);
    const l = await ledger(fd, ben.id);
    expect(l.money.balanceCents).toBe(0);
    expect(l.openCharges.lines).toEqual([]);
    expect(l.money.posted.filter((e: any) => e.kind === 'tax').map((e: any) => e.serviceName)).toEqual([a.name, b.name]);
    checkRunning(l);
    // the same from every entry point: the Ledger is one read keyed by the patient
    const again = await ledger(await frontDeskLogin(), ben.id);
    expect(again.money).toEqual(l.money);
  });

  it('a partial payment carries the rest, tax included, oldest first; the next payment clears it; no line is ever paid past its net + tax', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const v = await priced({ patientId: p.id, start: at('09:00') });
    const pr = await product({ price: 3500 });
    await add(fd, p.id, { productId: pr.id });
    const due = 5500 + 3500 + 193;
    const first = await checkout(fd, p.id, { visits: [{ bookingId: v.booking.id, pay: 'MONEY' }], charges: await allMoney(fd, p.id), payment: { tender: 'CASH', amountCents: 6000 }, confirmPartial: true });
    expect(first.status).toBe(200);
    expect(first.body.balanceCents).toBe(due - 6000);
    // oldest first: the visit (checked out with the line, ordered before it) is paid in full, the product's 500 + its tax remain
    const rows = await chargesOf(basePrisma, p.id);
    expect(rows.map((c) => [c.serviceName, c.owedCents, c.outstandingCents])).toEqual([[v.service.name, 5500, 0], [pr.name, 3693, 3693 - 500]]);
    setClockForTests(new Date('2026-10-14T15:00:00Z'));
    const v2 = (await ledger(fd, p.id)).money.version;
    const second = await post(fd, `/api/fd/patients/${p.id}/payments`, { idempotencyKey: key(), expectedVersion: v2, payment: { tender: 'CHECK', amountCents: due - 6000 } });
    expect(second.status).toBe(200);
    expect(second.body.balanceCents).toBe(0);
    checkRunning(await ledger(fd, p.id));
    // the guard: a product line takes no more than net + tax
    await expect(basePrisma.$transaction(async (tx) => {
      const pid = randomUUID();
      const ev = rows[1]!;
      await tx.payment.create({ data: { id: pid, patientId: p.id, collectedOn: new Date('2026-10-14'), receivedAt: new Date(), recordedById: 'test', tender: 'CASH', amountCents: 1 } });
      await tx.paymentAllocation.create({ data: { paymentId: pid, revenueEventId: ev.id, amountCents: 1 } });
    })).rejects.toThrow(/paid more than it costs/);
  });

  it('refuses a line that is removed, already checked out, or another patient\'s; and a check-out of items alone needs no visit', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const other = await makePatient();
    const pr = await product();
    const mine = (await add(fd, p.id, { productId: pr.id })).body.id;
    const theirs = (await add(fd, other.id, { productId: pr.id })).body.id;
    expect((await checkout(fd, p.id, { charges: [{ openChargeId: theirs, pay: 'MONEY' }] })).body.code).toBe('unknown_charge');
    const ok = await checkout(fd, p.id, { charges: [{ openChargeId: mine, pay: 'MONEY' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.visits).toEqual([]);
    expect((await checkout(fd, p.id, { charges: [{ openChargeId: mine, pay: 'MONEY' }] })).body.code).toBe('already_checked_out');
    expect((await remove(fd, p.id, mine)).body.code).toBe('already_checked_out');
    const gone = (await add(fd, p.id, { productId: pr.id })).body.id;
    await remove(fd, p.id, gone);
    expect((await checkout(fd, p.id, { charges: [{ openChargeId: gone, pay: 'MONEY' }] })).body.code).toBe('charge_removed');
    expect((await checkout(fd, p.id, {})).body.code).toBe('no_visits');
  });
});

describe('price above list (decision 5)', () => {
  it('an admin may raise a line\'s price with a reason — tax follows the new net; the desk may not, by a cent; a reduction reason is refused', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient();
    const pr = await product({ price: 3500 });
    const id = (await add(fd, p.id, { productId: pr.id })).body.id;
    const raise = (s: S, adjustment: Record<string, unknown>) => checkout(s, p.id, { charges: [{ openChargeId: id, pay: 'MONEY', adjustment }] });
    expect((await raise(fd, { cents: -1, reason: 'EXTENDED_SERVICE' })).body.code).toBe('increase_needs_admin');
    expect((await raise(admin, { cents: -500, reason: 'COURTESY' })).body.code).toBe('bad_adjustment_reason');
    expect((await raise(admin, { cents: -500, reason: 'OTHER' })).body.code).toBe('adjustment_note_required');
    expect((await raise(admin, { cents: 500, reason: 'EXTENDED_SERVICE' })).body.code).toBe('bad_adjustment_reason');
    const r = await raise(admin, { cents: -500, reason: 'EXTENDED_SERVICE' });
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ listPriceCents: 3500, adjustmentCents: -500, netPriceCents: 4000, taxCents: tax55(4000) });
    const ev = await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: r.body.charges[0].revenueEventId } });
    expect([ev.listPriceCents, ev.adjustmentReason]).toEqual([3500, 'EXTENDED_SERVICE']);
    // the desk's down-only cap is unchanged on a product: 20% of $35.00
    const q = await makePatient();
    const id2 = (await add(fd, q.id, { productId: pr.id })).body.id;
    expect((await checkout(fd, q.id, { charges: [{ openChargeId: id2, pay: 'MONEY', adjustment: { cents: 701, reason: 'COURTESY' } }] })).body.code).toBe('adjustment_needs_admin');
    expect((await checkout(fd, q.id, { charges: [{ openChargeId: id2, pay: 'MONEY', adjustment: { cents: 700, reason: 'COURTESY' } }] })).status).toBe(200);
  });
});

describe('the catalog screen (admin)', () => {
  it('admin only, on an MFA-verified session; products created and edited; tax rate and add-ons; every change audited by field names', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    expect((await fd.agent.get('/api/admin/catalog')).status).toBe(403);
    const created = await admin.agent.post('/api/admin/catalog/products').set('x-csrf-token', admin.csrf).send({ name: 'Omega-3 (placeholder)', category: 'Supplements', priceCents: 3000, taxable: true, tierDiscount: false });
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ name: 'Omega-3 (placeholder)', priceCents: 3000, taxable: true, tierDiscount: false, active: true, used: false });
    expect((await admin.agent.patch(`/api/admin/catalog/products/${created.body.product.id}`).set('x-csrf-token', admin.csrf).send({ active: false, taxable: false })).body.product).toMatchObject({ active: false, taxable: false });
    expect((await admin.agent.patch(`/api/admin/catalog/products/${created.body.product.id}`).set('x-csrf-token', admin.csrf).send({ priceCents: -1 })).status).toBe(400);
    const view = (await admin.agent.get('/api/admin/catalog')).body;
    expect(view.taxRate.rateMilli).toBe(RATE);
    expect(view.productDiscounts.filter((d: any) => ['PREVENT', 'RESTORE', 'OPTIMIZE'].includes(d.code)).map((d: any) => [d.code, d.percent])).toEqual([['PREVENT', 10], ['RESTORE', 15], ['OPTIMIZE', 20]]);
    const needsNote = await visit({ encounter: null, requiresNote: true });
    expect((await admin.agent.patch(`/api/admin/catalog/add-ons/${needsNote.service.id}`).set('x-csrf-token', admin.csrf).send({ offerAsAddOn: true })).body.code).toBe('not_add_on_eligible');
    const rows = await auditRows({ resourceType: 'product', resourceId: created.body.product.id }, 2);
    expect(JSON.stringify(rows.map((r: any) => r.meta))).not.toMatch(/3000|Omega/);
  });

  it('promotions may name products; once used, their products are frozen (API and database)', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const pr = await product({ price: 2000 });
    const created = await admin.agent.post('/api/admin/promotions').set('x-csrf-token', admin.csrf).send({ name: 'Supplement week', kind: 'PERCENT', value: 10, startsOn: '2026-10-01', endsOn: '2026-10-31', productIds: [pr.id] });
    expect(created.status).toBe(201);
    expect(created.body.promotion.products.map((x: any) => x.id)).toEqual([pr.id]);
    expect((await admin.agent.post('/api/admin/promotions').set('x-csrf-token', admin.csrf).send({ name: 'Empty', kind: 'PERCENT', value: 10, startsOn: '2026-10-01', endsOn: '2026-10-31' })).status).toBe(400);
    const p = await makePatient();
    await add(fd, p.id, { productId: pr.id });
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id) });
    expect(r.body.charges[0].promotion.id).toBe(created.body.promotion.id);
    const other = await product();
    const patch = await admin.agent.patch(`/api/admin/promotions/${created.body.promotion.id}`).set('x-csrf-token', admin.csrf).send({ productIds: [pr.id, other.id] });
    expect(patch.body.code).toBe('promotion_in_use');
    await expect(basePrisma.promotionProduct.delete({ where: { promotionId_productId: { promotionId: created.body.promotion.id, productId: pr.id } } })).rejects.toThrow(/frozen/);
  });
});

describe('Accounting: tax apart from revenue', () => {
  it('revenue views show products and add-ons as rows, tax in its own column outside the identity; billed vs collected shows tax billed', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    setClockForTests(new Date('2034-06-07T15:00:00Z'));
    const p = await makePatient();
    const pr = await product({ price: 3500, name: `Accounting product ${n}` });
    await add(fd, p.id, { productId: pr.id });
    await add(fd, p.id, { serviceId: (await bodyComp()).id });
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'CARD', amountCents: 3500 + 193 + 5500 } });
    expect(r.status).toBe(200);
    const range = 'from=2034-06-07&to=2034-06-07';
    const byKind = await admin.agent.get(`/api/accounting/custom?${range}&group=lineKind`);
    expect(byKind.status).toBe(200);
    const row = (k: string) => byKind.body.rows.find((x: any) => x.lineKind === k);
    expect(row('Products')).toMatchObject({ visits: 1, listCents: 3500, netCents: 3500, taxCents: 193 });
    expect(row('Add-on services')).toMatchObject({ visits: 1, listCents: 5500, netCents: 5500, taxCents: 0 });
    for (const x of [...byKind.body.rows, byKind.body.totals]) {
      expect(x.listCents).toBe(x.discountCents + x.promotionCents + x.adjustmentCents + x.coveredCents + x.netCents);   // tax is not in it
    }
    const byItem = await admin.agent.get(`/api/accounting/monthly?${range}`);
    expect(byItem.body.rows.find((x: any) => x.service === pr.name)).toMatchObject({ netCents: 3500, taxCents: 193 });
    const coll = await admin.agent.get(`/api/accounting/collections?${range}&group=day`);
    expect(coll.body.rows[0]).toMatchObject({ day: '2034-06-07', billedCents: 9000, taxCents: 193, collectedCents: 9193 });
  });
});

describe('the database', () => {
  it('Row Level Security is on for every new table; open lines and their removals are append-only, truncate included', async () => {
    const tables = ['Product', 'TaxRate', 'PlanProductDiscount', 'PromotionProduct', 'OpenCharge', 'OpenChargeRemoval'];
    const rows = await basePrisma.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean }>>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relname = ANY($1)`, tables);
    expect(rows.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual(tables.map((t) => [t, true]).sort());
    const triggers = await basePrisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND c.relname IN ('OpenCharge', 'OpenChargeRemoval') AND NOT t.tgisinternal`);
    expect(triggers.map((t) => t.tgname).sort()).toEqual(['OpenChargeRemoval_guard', 'OpenChargeRemoval_no_truncate', 'OpenChargeRemoval_no_update_delete', 'OpenCharge_no_truncate', 'OpenCharge_no_update_delete']);
  });
});

describe('quantity (rev 2.3 review)', () => {
  const setQty = (s: S, patientId: string, id: string, quantity: number) => post(s, `/api/fd/patients/${patientId}/charges/${id}/quantity`, { idempotencyKey: key(), quantity });

  it('a click on an item already open adds one to its line, not a second line; price, tier discount and tax on the line total, rounded per line', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    await makeMembership(p.id, 'RESTORE', '2026-10-01');                                              // 15% on products
    const pr = await product({ price: 3333 });
    const first = await add(fd, p.id, { productId: pr.id });
    const again = await add(fd, p.id, { productId: pr.id });
    expect([first.body.quantity, again.body.id, again.body.quantity]).toEqual([1, first.body.id, 2]);
    expect((await setQty(fd, p.id, first.body.id, 3)).body).toEqual({ id: first.body.id, quantity: 3 });
    const [line] = (await openLines(fd, p.id)).lines;
    // 3 × $33.33 = $99.99; 15% of that, halves up = $15.00; net $84.99; 5.5% of the net = $4.67 (4.674…)
    const list = 9999; const off = Math.floor((list * 15 + 50) / 100); const net = list - off;
    expect([line.quantity, line.unitPriceCents, line.listCents, line.discountCents, line.netCents, line.taxCents]).toEqual([3, 3333, list, off, net, tax55(net)]);
    expect([off, net, tax55(net)]).toEqual([1500, 8499, 467]);
    const r = await checkout(fd, p.id, { charges: await allMoney(fd, p.id), payment: { tender: 'CASH', amountCents: net + tax55(net) } });
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ quantity: 3, unitPriceCents: 3333, listPriceCents: list, discountCents: off, netPriceCents: net, taxCents: tax55(net) });
    const ev = await basePrisma.revenueEvent.findUniqueOrThrow({ where: { id: r.body.charges[0].revenueEventId } });
    expect([ev.quantity, ev.listPriceCents, ev.netPriceCents, ev.taxCents]).toEqual([3, list, net, tax55(net)]);
    const l = await ledger(fd, p.id);
    expect(l.money.posted.find((e: any) => e.kind === 'charge')).toMatchObject({ quantity: 3, listPriceCents: list, amountCents: net });
    expect(l.money.balanceCents).toBe(0);
    expect((await auditRows({ resourceType: 'open_charge', resourceId: first.body.id, action: 'UPDATE' }, 2)).map((x: any) => x.meta.quantity).sort()).toEqual([2, 3]);
  });

  it('a new price (a catalog edit), another performer or another day starts a new line; a line holds 1 to 99; it can still be removed', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const pr = await product({ price: 1000 });
    const a = (await add(fd, p.id, { productId: pr.id })).body.id;
    await basePrisma.product.update({ where: { id: pr.id }, data: { priceCents: 1200 } });
    const b = (await add(fd, p.id, { productId: pr.id })).body.id;
    expect(b).not.toBe(a);                                                                           // the snapshot price differs
    const staff = await prisma.staff.findFirstOrThrow({ where: { role: 'REGISTERED_NURSE' } });
    const bc = (await bodyComp()).id;
    const s1 = (await add(fd, p.id, { serviceId: bc })).body.id;
    const s2 = (await add(fd, p.id, { serviceId: bc, performedByStaffId: staff.id })).body.id;
    expect(s2).not.toBe(s1);                                                                         // another performer
    setClockForTests(new Date('2026-10-14T15:00:00Z'));
    expect((await add(fd, p.id, { productId: pr.id })).body.id).not.toBe(b);                        // another day
    setClockForTests(TUESDAY_1007);
    for (const q of [0, 100, 1.5]) expect((await setQty(fd, p.id, a, q)).body.code, `${q}`).toBe('bad_quantity');
    expect((await setQty(fd, p.id, a, 99)).status).toBe(200);
    expect((await add(fd, p.id, { productId: pr.id, }, {})).body.id).not.toBe(a);                  // the 1200 line takes the click, not the 1000 one
    await basePrisma.product.update({ where: { id: pr.id }, data: { priceCents: 1000 } });
    expect((await add(fd, p.id, { productId: pr.id })).body.code).toBe('quantity_max');             // the 1000 line is full at 99
    expect((await remove(fd, p.id, a)).status).toBe(200);
    expect((await setQty(fd, p.id, a, 2)).body.code).toBe('already_removed');
    await expect(basePrisma.openChargeQuantity.create({ data: { openChargeId: a, quantity: 2, changedById: 'test', changedAt: new Date() } })).rejects.toThrow(/no longer open/);
    await expect(basePrisma.$executeRawUnsafe(`UPDATE "OpenChargeQuantity" SET "quantity" = 5 WHERE "openChargeId" = '${a}'`)).rejects.toThrow(/append-only/);
  });

  it('the database: a charge carries its line\'s quantity as it stood, and list = unit price × quantity; a visit is always one', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const pr = await product({ price: 500 });
    const id = (await add(fd, p.id, { productId: pr.id })).body.id;
    await setQty(fd, p.id, id, 4);
    const insert = (quantity: number, list: number) => basePrisma.$transaction(async (tx) => {
      const oc = await tx.openCharge.findUniqueOrThrow({ where: { id } });
      await tx.revenueEvent.create({ data: { patientId: p.id, productId: pr.id, openChargeId: id, serviceName: oc.name, serviceCategory: oc.category, quantity, listPriceCents: list, netPriceCents: list, taxRateMilli: oc.taxRateMilli, taxCents: Math.floor((list * oc.taxRateMilli + 50_000) / 100_000), paymentType: 'CASH', occurredAt: new Date(), recordedById: 'test' } });
    });
    await expect(insert(1, 500)).rejects.toThrow(/does not match the open line/);                  // the quantity as first added, not as it stands
    await expect(insert(4, 500)).rejects.toThrow(/does not match the open line/);                  // list must be 4 × 500
    await expect(insert(100, 50_000)).rejects.toThrow(/RevenueEvent_consistent/);
    const v = await priced({ patientId: p.id, start: at('09:00') });
    await expect(basePrisma.$executeRawUnsafe(`INSERT INTO "RevenueEvent" ("id","encounterId","bookingId","patientId","serviceId","serviceName","serviceCategory","listPriceCents","paymentType","netPriceCents","quantity","occurredAt","recordedById")
      VALUES ('${randomUUID()}','${v.encounter!.id}','${v.booking.id}','${p.id}','${v.service.id}','x','x',5500,'CASH',5500,2,now(),'test')`)).rejects.toThrow(/RevenueEvent_consistent/);
    const ok = await checkout(fd, p.id, { charges: await allMoney(fd, p.id) });
    expect(ok.body.charges[0]).toMatchObject({ quantity: 4, listPriceCents: 2000 });
  });

  it('a service line: credits for each unit; a perk covers one; a fixed-amount promotion on a service comes off the line once', async () => {
    const fd = await frontDeskLogin();
    const s = await visit({ encounter: null, requiresNote: false });
    await basePrisma.service.update({ where: { id: s.service.id }, data: { offerAsAddOn: true, priceCents: 4000, creditCost: 2 } });
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-10-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-01', now: TUESDAY_1007 });
    const id = (await add(fd, p.id, { serviceId: s.service.id })).body.id;
    await setQty(fd, p.id, id, 2);
    const [line] = (await openLines(fd, p.id)).lines;
    expect(line.credits).toMatchObject({ cost: 4, available: true });
    expect((await checkout(fd, p.id, { charges: [{ openChargeId: id, pay: 'PERK', perkId: 'x' }] })).body.code).toBe('perk_one_unit');
    const r = await checkout(fd, p.id, { charges: [{ openChargeId: id, pay: 'CREDITS' }] });
    expect(r.body.charges[0]).toMatchObject({ quantity: 2, creditsRedeemed: 4, paymentType: 'MEMBER' });
    expect(await ledgerSum(p.id)).toBe(2);
    // services keep their behaviour: a fixed $5.00 promotion on a service add-on comes off its line once, whatever the quantity
    await basePrisma.promotion.create({ data: { name: 'Five off the service', kind: 'FIXED_CENTS', value: 500, startsOn: new Date('2026-10-01T00:00:00Z'), endsOn: new Date('2026-10-31T00:00:00Z'), createdById: 'test', services: { create: [{ serviceId: s.service.id }] } } });
    const q = await makePatient();
    const sid = (await add(fd, q.id, { serviceId: s.service.id })).body.id;
    await setQty(fd, q.id, sid, 3);
    expect((await openLines(fd, q.id)).lines[0]).toMatchObject({ listCents: 12000, promotion: { cents: 500 }, netCents: 11500, taxCents: 0 });
  });

  it('a fixed-amount promotion on a PRODUCT comes off per unit, capped at the line total so a line never goes below $0.00; a percentage is unchanged', async () => {
    const fd = await frontDeskLogin();
    const promo = (productId: string, kind: 'FIXED_CENTS' | 'PERCENT', value: number) => basePrisma.promotion.create({
      data: { name: `${kind} ${value}`, kind, value, startsOn: new Date('2026-10-01T00:00:00Z'), endsOn: new Date('2026-10-31T00:00:00Z'), createdById: 'test', products: { create: [{ productId }] } },
    });
    const lineFor = async (unit: number, quantity: number, kind: 'FIXED_CENTS' | 'PERCENT', value: number) => {
      const pr = await product({ price: unit, tierDiscount: false });
      await promo(pr.id, kind, value);
      const p = await makePatient();
      const id = (await add(fd, p.id, { productId: pr.id })).body.id;
      if (quantity > 1) await setQty(fd, p.id, id, quantity);
      return { p, line: (await openLines(fd, p.id)).lines[0] };
    };
    // "$5 off Magnesium" on two: $10 off
    expect((await lineFor(2000, 2, 'FIXED_CENTS', 500)).line).toMatchObject({ listCents: 4000, promotion: { cents: 1000 }, netCents: 3000, taxCents: tax55(3000) });
    // at the cap: $5.00 × 3 on a $5.00 item is exactly the line, net $0.00; a cent more is still capped there; a cent less leaves 3¢
    expect((await lineFor(500, 3, 'FIXED_CENTS', 500)).line).toMatchObject({ listCents: 1500, promotion: { cents: 1500 }, netCents: 0, taxCents: 0 });
    expect((await lineFor(500, 3, 'FIXED_CENTS', 501)).line).toMatchObject({ listCents: 1500, promotion: { cents: 1500 }, netCents: 0, taxCents: 0 });
    expect((await lineFor(500, 3, 'FIXED_CENTS', 499)).line).toMatchObject({ listCents: 1500, promotion: { cents: 1497 }, netCents: 3, taxCents: 0 });
    // a percentage is on the line total, as before
    expect((await lineFor(2000, 2, 'PERCENT', 25)).line).toMatchObject({ listCents: 4000, promotion: { cents: 1000 }, netCents: 3000 });
    // and the charge records what the screen showed — a line at $0.00 checks out, with nothing to pay
    const { p, line } = await lineFor(500, 2, 'FIXED_CENTS', 900);
    expect(line).toMatchObject({ listCents: 1000, promotion: { cents: 1000 }, netCents: 0 });
    const r = await checkout(fd, p.id, { charges: [{ openChargeId: line.id, pay: 'MONEY', expectedNetCents: 0 }] });
    expect(r.status).toBe(200);
    expect(r.body.charges[0]).toMatchObject({ quantity: 2, listPriceCents: 1000, promotion: { cents: 1000 }, netPriceCents: 0, taxCents: 0 });
    expect(r.body.balanceCents).toBe(0);
    // the better of tier and promotion still holds, per unit against the tier on the line total: Optimize 20% of $40.00 = $8.00 beats 2 × $3.00
    const tierWins = await product({ price: 2000 });
    await promo(tierWins.id, 'FIXED_CENTS', 300);
    const m = await makePatient();
    await makeMembership(m.id, 'OPTIMIZE', '2026-10-01');
    const id = (await add(fd, m.id, { productId: tierWins.id })).body.id;
    await setQty(fd, m.id, id, 2);
    expect((await openLines(fd, m.id)).lines[0]).toMatchObject({ discountCents: 800, promotion: null, netCents: 3200 });
    await setQty(fd, m.id, id, 2);
    const pr5 = await product({ price: 2000 });
    await promo(pr5.id, 'FIXED_CENTS', 500);
    const id5 = (await add(fd, m.id, { productId: pr5.id })).body.id;
    await setQty(fd, m.id, id5, 2);
    expect((await openLines(fd, m.id)).lines.find((l: any) => l.id === id5)).toMatchObject({ discountCents: 0, promotion: { cents: 1000 }, netCents: 3000 });   // 2 × $5 beats $8
  });

  it('Accounting counts units, and a provider can set the quantity from their visit', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const prov = await providerLogin('PROVIDER_CHIRO');
    setClockForTests(new Date('2034-07-08T15:00:00Z'));
    const p = await makePatient();
    const v = await priced({ patientId: p.id, staffId: prov.staff.id, start: new Date('2034-07-08T14:00:00Z') });
    const pr = await product({ price: 1000, name: `Counted product ${n}` });
    const id = (await post(prov, `/api/provider/visits/${v.booking.id}/charges`, { idempotencyKey: key(), productId: pr.id })).body.id;
    expect((await post(prov, `/api/provider/visits/${v.booking.id}/charges/${id}/quantity`, { idempotencyKey: key(), quantity: 3 })).body).toEqual({ id, quantity: 3 });
    expect((await checkout(fd, p.id, { charges: await allMoney(fd, p.id) })).status).toBe(200);
    const r = await admin.agent.get('/api/accounting/monthly?from=2034-07-08&to=2034-07-08');
    expect(r.body.rows.find((x: any) => x.service === pr.name)).toMatchObject({ visits: 3, listCents: 3000, netCents: 3000, taxCents: tax55(3000) });
  });
});
