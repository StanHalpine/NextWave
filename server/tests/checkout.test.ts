import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { memberDiscount } from '../src/lib/pricing.js';
import { app, auditRows, blob, chiroStaff, makeAccount, signInFully } from './helpers.js';
import { makePatient, patch, post, TUESDAY_1007 } from './phase2.js';
import { checkedInVisit, creditService, grantLot, ledgerSum, makeMembership, makePlan } from './phase3.js';

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const fdLogin = async () => signInFully((await makeAccount({ roles: ['FRONT_DESK'] })).email);
const out = (s: any, appointmentId: string, body: object) => post(s, `/api/fd/appointments/${appointmentId}/check-out`, body);
const preview = (s: any, appointmentId: string) => s.agent.get(`/api/fd/appointments/${appointmentId}/checkout-preview`);

/** A member holding `credits` spendable credits (one lot, granted today). */
async function member(code: 'PREVENT' | 'RESTORE' | 'OPTIMIZE' = 'RESTORE', credits = 6) {
  const p = await makePatient();
  const m = await makeMembership(p.id, code, '2026-10-13');
  if (credits > 0) await grantLot({ patientId: p.id, membershipId: m.id, credits, periodStart: '2026-10-13', now: TUESDAY_1007 });
  return { p, m };
}
const events = (encounterId: string) => basePrisma.revenueEvent.findMany({ where: { encounterId } });

describe('access', () => {
  it('is closed to anonymous callers and providers, and needs the CSRF token', async () => {
    const clinic = await creditService();
    const { booking } = await checkedInVisit(clinic, null);
    expect((await request(app).post(`/api/fd/appointments/${booking.id}/check-out`).send({ payment: 'CASH' })).status).toBe(401);
    expect((await request(app).get(`/api/fd/appointments/${booking.id}/checkout-preview`)).status).toBe(401);
    const staff = await chiroStaff();
    const prov = await signInFully((await makeAccount({ roles: ['PROVIDER_CHIRO'], staffId: staff.id })).email);
    expect((await out(prov, booking.id, { payment: 'CASH' })).status).toBe(403);
    const fd = await fdLogin();
    expect((await fd.agent.post(`/api/fd/appointments/${booking.id}/check-out`).send({ payment: 'CASH' })).status).toBe(403);
  });
});

describe('the check-out screen\'s preview', () => {
  it('shows a member their balance before and after, and every way the visit can be paid', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const { p } = await member('RESTORE', 6);
    const { booking } = await checkedInVisit(clinic, p.id);

    const r = (await preview(fd, booking.id)).body.preview;
    expect(r).toMatchObject({
      alreadyCheckedOut: false, listPriceCents: 5500, creditCost: 2, balance: 6,
      membership: { planCode: 'RESTORE', planName: 'Restore', status: 'ACTIVE' },
      credits: { available: true, cost: 2, balanceAfter: 4, reason: null },
      cash: { priceCents: 5500, priceKnown: true }, perks: [],
      patient: { id: p.id }, service: { id: clinic.service.id, subOption: null },
    });
    expect(await auditRows({ resourceType: 'appointment', resourceId: booking.id, action: 'READ' })).toHaveLength(1);
    expect(await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'READ' })).toHaveLength(1);
  });

  it('says why credits are not an option, rather than hiding it', async () => {
    const fd = await fdLogin();
    const eligible = await creditService({ creditCost: 2 });
    const cashOnly = await creditService({ creditCost: null });
    const poor = await member('PREVENT', 1);
    const nonMember = await makePatient();

    expect((await preview(fd, (await checkedInVisit(eligible, null)).booking.id)).body.preview.credits).toMatchObject({ available: false, reason: expect.stringMatching(/link a patient/i) });
    expect((await preview(fd, (await checkedInVisit(cashOnly, poor.p.id)).booking.id)).body.preview.credits).toMatchObject({ available: false, reason: expect.stringMatching(/not credit-eligible/i) });
    expect((await preview(fd, (await checkedInVisit(eligible, poor.p.id)).booking.id)).body.preview.credits).toMatchObject({ available: false, reason: 'Needs 2 credits; 1 available.' });
    const nm = (await preview(fd, (await checkedInVisit(eligible, nonMember.id)).booking.id)).body.preview;
    expect(nm.membership).toBeNull();
    expect(nm.balance).toBe(0);
  });

  it('uses the chosen option\'s price, says when a service has no price, and reports a finished visit', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: null, creditCost: null });
    await prisma.serviceOption.create({ data: { serviceId: clinic.service.id, label: 'Methyl B12', priceCents: 2500, sortOrder: 1 } });
    const withOption = await checkedInVisit(clinic, null, { subOption: 'Methyl B12' });
    expect((await preview(fd, withOption.booking.id)).body.preview).toMatchObject({ listPriceCents: 2500, cash: { priceCents: 2500, priceKnown: true } });
    const noPrice = await checkedInVisit(clinic, null);
    expect((await preview(fd, noPrice.booking.id)).body.preview.cash).toEqual({ priceCents: null, priceKnown: false, discountPercent: 0, discountCents: null, netPriceCents: null });

    expect((await out(fd, withOption.booking.id, { payment: 'CASH' })).status).toBe(200);
    expect((await preview(fd, withOption.booking.id)).body.preview.alreadyCheckedOut).toBe(true);
    expect((await preview(fd, 'nope')).status).toBe(404);
  });
});

describe('paying with credits', () => {
  it('redeems the service\'s credit cost, shows balance before and after, writes one revenue event, and checks the patient out', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const { p } = await member('RESTORE', 6);
    const { booking, encounter } = await checkedInVisit(clinic, p.id);

    const res = await out(fd, booking.id, { payment: 'CREDITS' });
    expect(res.status).toBe(200);
    expect(res.body.checkout).toMatchObject({
      paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, netPriceCents: 0, listPriceCents: 5500, discountCents: 0,
      balanceBefore: 6, balanceAfter: 4, planName: 'Restore', alreadyCheckedOut: false,
    });
    expect(res.body.appointment.encounter.status).toBe('CHECKED_OUT');

    const [ev] = await events(encounter.id);
    expect(ev).toMatchObject({
      bookingId: booking.id, patientId: p.id, serviceId: clinic.service.id, serviceName: clinic.service.name, serviceCategory: 'Chiropractic',
      listPriceCents: 5500, paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, netPriceCents: 0, discountPercent: 0, discountCents: 0, planCode: 'RESTORE',
      recordedById: fd.state.account.id,
    });
    expect(ev!.occurredAt.toISOString()).toBe(TUESDAY_1007.toISOString());

    const ledger = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id, reason: 'REDEMPTION' } });
    expect(ledger).toMatchObject({ delta: -2, encounterId: encounter.id, revenueEventId: ev!.id, actorAccountId: fd.state.account.id });
    expect(ledger.createdAt.toISOString()).toBe(TUESDAY_1007.toISOString());
    expect((await fd.agent.get(`/api/fd/patients/${p.id}/credits`)).body.balance).toBe(4);

    expect(await auditRows({ resourceType: 'revenue_event', resourceId: ev!.id, action: 'CREATE' })).toHaveLength(1);
    expect(await auditRows({ resourceType: 'credit_ledger', resourceId: p.id, action: 'CREATE' }, 1)).not.toHaveLength(0);
    expect(await auditRows({ resourceType: 'encounter', resourceId: encounter.id, action: 'UPDATE' })).toHaveLength(1);
    expect(blob(await auditRows({ resourceType: 'revenue_event', resourceId: ev!.id }))).not.toContain(p.lastName);
  });

  it('draws the oldest lot first and spans lots when it must', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 18500, creditCost: 6 });
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-09-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-09-13', now: TUESDAY_1007 });
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-13', now: TUESDAY_1007 });
    const { booking } = await checkedInVisit(clinic, p.id);
    const res = await out(fd, booking.id, { payment: 'CREDITS' });
    expect(res.body.checkout).toMatchObject({ balanceBefore: 8, balanceAfter: 2, creditsRedeemed: 6 });
    const allocs = await basePrisma.creditAllocation.findMany({ where: { ledger: { patientId: p.id } }, orderBy: { id: 'asc' }, include: { lot: true } });
    expect(allocs.map((a) => [a.lot.periodStart!.toISOString().slice(0, 10), a.amount])).toEqual([['2026-09-13', 4], ['2026-10-13', 2]]);
  });

  it('refuses when credits are short — and leaves the visit, the ledger and the books exactly as they were', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ creditCost: 2 });
    const { p } = await member('PREVENT', 1);
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    const r = await out(fd, booking.id, { payment: 'CREDITS' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('insufficient_credits');
    expect(r.body).toMatchObject({ balance: 1, needed: 2 });
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: encounter.id } })).status).toBe('CHECKED_IN');
    expect(await events(encounter.id)).toHaveLength(0);
    expect(await ledgerSum(p.id)).toBe(1);
    // …and the desk can still settle the same visit another way.
    expect((await out(fd, booking.id, { payment: 'CASH' })).status).toBe(200);
  });

  it('refuses a cash-only service, an unlinked visit, and credits the patient does not have', async () => {
    const fd = await fdLogin();
    const cashOnly = await creditService({ creditCost: null });
    const { p } = await member('PREVENT', 4);
    expect((await out(fd, (await checkedInVisit(cashOnly, p.id)).booking.id, { payment: 'CREDITS' })).body.code).toBe('not_credit_eligible');
    const eligible = await creditService({ creditCost: 2 });
    expect((await out(fd, (await checkedInVisit(eligible, null)).booking.id, { payment: 'CREDITS' })).body.code).toBe('no_patient');
    const nobody = await makePatient();
    expect((await out(fd, (await checkedInVisit(eligible, nobody.id)).booking.id, { payment: 'CREDITS' })).body.code).toBe('insufficient_credits');
  });

  it('still lets a CANCELLED member spend credits already granted (they run out their rollover)', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ creditCost: 2 });
    const { p, m } = await member('PREVENT', 4);
    await prisma.membership.update({ where: { id: m.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const { booking } = await checkedInVisit(clinic, p.id);
    const r = await out(fd, booking.id, { payment: 'CREDITS' });
    expect(r.status).toBe(200);
    expect(r.body.checkout.balanceAfter).toBe(2);
  });
});

describe('paying cash (recorded, never processed)', () => {
  it('records the list price as cash due for a non-member, and the member/cash split for a member who chooses cash', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const nonMember = await makePatient();
    const v1 = await checkedInVisit(clinic, nonMember.id);
    const r1 = await out(fd, v1.booking.id, { payment: 'CASH' });
    expect(r1.body.checkout).toMatchObject({ paymentType: 'CASH', memberBenefit: null, listPriceCents: 5500, discountPercent: 0, discountCents: 0, netPriceCents: 5500, creditsRedeemed: 0, balanceBefore: 0, balanceAfter: 0 });
    expect((await events(v1.encounter.id))[0]).toMatchObject({ paymentType: 'CASH', planCode: null, netPriceCents: 5500, listPriceCents: 5500, discountCents: 0 });

    const { p } = await member('RESTORE', 6);
    const v2 = await checkedInVisit(clinic, p.id);
    const r2 = await out(fd, v2.booking.id, { payment: 'CASH', priceCents: 5500 });
    expect(r2.body.checkout).toMatchObject({ paymentType: 'CASH', creditsRedeemed: 0, balanceBefore: 6, balanceAfter: 6 });
    expect((await events(v2.encounter.id))[0]).toMatchObject({ paymentType: 'CASH', planCode: 'RESTORE' });   // paid cash is a cash sale, but the active member's tier is recorded
    expect(await ledgerSum(p.id)).toBe(6);
  });

  it('records a walk-up cash visit with no patient record', async () => {
    const fd = await fdLogin();
    const { booking, encounter } = await checkedInVisit(await creditService({ priceCents: 5500 }), null);
    expect((await out(fd, booking.id, { payment: 'CASH' })).status).toBe(200);
    expect((await events(encounter.id))[0]).toMatchObject({ patientId: null, paymentType: 'CASH', netPriceCents: 5500 });
  });

  it('will not accept a price that is not the service\'s; a service with no price needs the amount', async () => {
    const fd = await fdLogin();
    const known = await creditService({ priceCents: 5500 });
    const v = await checkedInVisit(known, null);
    const wrong = await out(fd, v.booking.id, { payment: 'CASH', priceCents: 100 });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ code: 'price_mismatch', priceCents: 5500 });
    expect(await events(v.encounter.id)).toHaveLength(0);

    const unpriced = await creditService({ priceCents: null });
    const u = await checkedInVisit(unpriced, null);
    const missing = await out(fd, u.booking.id, { payment: 'CASH' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('price_required');
    for (const bad of [0, -5, 12.5, 100_000_01]) expect((await out(fd, u.booking.id, { payment: 'CASH', priceCents: bad })).status, String(bad)).toBe(400);
    const ok = await out(fd, u.booking.id, { payment: 'CASH', priceCents: 7300 });
    expect(ok.body.checkout).toMatchObject({ listPriceCents: 7300, netPriceCents: 7300 });
  });

  it('uses the option\'s price, not the service\'s', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: null, creditCost: null });
    await prisma.serviceOption.create({ data: { serviceId: clinic.service.id, label: 'Glutathione', priceCents: 4000, sortOrder: 1 } });
    const v = await checkedInVisit(clinic, null, { subOption: 'Glutathione' });
    const r = await out(fd, v.booking.id, { payment: 'CASH' });
    expect(r.body.checkout).toMatchObject({ listPriceCents: 4000, netPriceCents: 4000 });
    expect((await events(v.encounter.id))[0]!.subOption).toBe('Glutathione');
  });
});

describe('using a perk', () => {
  async function perkSetup(over: { quantity?: number; active?: boolean; covers?: boolean } = {}) {
    const clinic = await creditService({ priceCents: 4500, creditCost: 2 });
    const { plan, perks } = await makePlan({ perks: [{ key: 'monthly_shot_or_iv', label: 'Monthly shot', quantity: over.quantity ?? 1, active: over.active ?? true, serviceIds: over.covers === false ? [] : [clinic.service.id] }] });
    const p = await makePatient();
    await prisma.membership.create({ data: { patientId: p.id, planId: plan.id, startedOn: new Date('2026-10-13'), nextGrantOn: new Date('2026-11-13'), createdById: 'x' } });
    return { clinic, plan, perk: perks[0]!, p };
  }

  it('counts the perk instead of credits, writes the revenue event as a member sale, and links the usage to it', async () => {
    const fd = await fdLogin();
    const { clinic, perk, p, plan } = await perkSetup();
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    const r = await out(fd, booking.id, { payment: 'PERK', perkId: perk.id });
    expect(r.status).toBe(200);
    expect(r.body.checkout).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'PERK', creditsRedeemed: 0, netPriceCents: 0, listPriceCents: 4500, perkLabel: 'Monthly shot' });
    const [ev] = await events(encounter.id);
    expect(ev).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'PERK', planCode: plan.code });
    const use = await basePrisma.perkUsage.findFirstOrThrow({ where: { patientId: p.id } });
    expect(use).toMatchObject({ perkId: perk.id, periodKey: '2026-10', revenueEventId: ev!.id, quantity: 1 });
    expect(await ledgerSum(p.id)).toBe(0);
  });

  it('shows the perk in the preview while any is left — and offers it no more once used', async () => {
    const fd = await fdLogin();
    const { clinic, perk, p } = await perkSetup({ quantity: 1 });
    const a = await checkedInVisit(clinic, p.id);
    expect((await preview(fd, a.booking.id)).body.preview.perks).toEqual([{ perkId: perk.id, label: 'Monthly shot', remaining: 1, period: 'MONTHLY' }]);
    await out(fd, a.booking.id, { payment: 'PERK', perkId: perk.id });
    const b = await checkedInVisit(clinic, p.id);
    expect((await preview(fd, b.booking.id)).body.preview.perks).toEqual([]);
    const second = await out(fd, b.booking.id, { payment: 'PERK', perkId: perk.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('perk_used_up');
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: b.encounter.id } })).status).toBe('CHECKED_IN');
  });

  it('refuses a perk that does not cover the service, is switched off, or whose membership is paused or absent', async () => {
    const fd = await fdLogin();
    const wrongService = await perkSetup({ covers: false });
    expect((await out(fd, (await checkedInVisit(wrongService.clinic, wrongService.p.id)).booking.id, { payment: 'PERK', perkId: wrongService.perk.id })).body.code).toBe('perk_not_for_service');
    const off = await perkSetup({ active: false });
    expect((await out(fd, (await checkedInVisit(off.clinic, off.p.id)).booking.id, { payment: 'PERK', perkId: off.perk.id })).body.code).toBe('perk_not_for_service');
    const paused = await perkSetup();
    await prisma.membership.updateMany({ where: { patientId: paused.p.id }, data: { status: 'PAUSED' } });
    expect((await out(fd, (await checkedInVisit(paused.clinic, paused.p.id)).booking.id, { payment: 'PERK', perkId: paused.perk.id })).body.code).toBe('membership_not_active');
    const stranger = await makePatient();
    expect((await out(fd, (await checkedInVisit(paused.clinic, stranger.id)).booking.id, { payment: 'PERK', perkId: paused.perk.id })).body.code).toBe('membership_not_active');
    expect((await out(fd, (await checkedInVisit(paused.clinic, null)).booking.id, { payment: 'PERK', perkId: paused.perk.id })).body.code).toBe('no_patient');
  });
});

describe('checking out is idempotent and race-proof', () => {
  it('a repeat returns what was recorded and changes nothing — even if it asks for a different payment', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const { p } = await member('RESTORE', 6);
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    const first = await out(fd, booking.id, { payment: 'CREDITS' });
    const again = await out(fd, booking.id, { payment: 'CREDITS' });
    const different = await out(fd, booking.id, { payment: 'CASH' });
    expect(again.status).toBe(200);
    expect(again.body.checkout).toMatchObject({ alreadyCheckedOut: true, paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2 });
    expect(different.body.checkout).toMatchObject({ alreadyCheckedOut: true, paymentType: 'MEMBER' });
    expect(first.body.checkout.alreadyCheckedOut).toBe(false);
    expect(await events(encounter.id)).toHaveLength(1);
    expect(await ledgerSum(p.id)).toBe(4);
  });

  it('a double-click: eight simultaneous submits make one revenue event and take the credits once', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const { p } = await member('RESTORE', 6);
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    const results = await Promise.all(Array.from({ length: 8 }, () => out(fd, booking.id, { payment: 'CREDITS' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.checkout.alreadyCheckedOut === false)).toHaveLength(1);
    expect(await events(encounter.id)).toHaveLength(1);
    expect(await ledgerSum(p.id)).toBe(4);
    expect(await basePrisma.creditLedger.count({ where: { patientId: p.id, reason: 'REDEMPTION' } })).toBe(1);
  });

  it('several visits for ONE patient racing for too few credits: only as many succeed as the balance allows', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ creditCost: 2 });
    const { p } = await member('OPTIMIZE', 8);
    const visits = await Promise.all(Array.from({ length: 7 }, () => checkedInVisit(clinic, p.id)));
    const results = await Promise.all(visits.map((v) => out(fd, v.booking.id, { payment: 'CREDITS' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('insufficient_credits');
    expect(await ledgerSum(p.id)).toBe(0);
    // Each visit that failed is still checked in, with no revenue event; each that succeeded has exactly one.
    for (const [i, v] of visits.entries()) {
      const evs = await events(v.encounter.id);
      expect(evs).toHaveLength(results[i]!.status === 200 ? 1 : 0);
      expect((await prisma.encounter.findUniqueOrThrow({ where: { id: v.encounter.id } })).status).toBe(results[i]!.status === 200 ? 'CHECKED_OUT' : 'CHECKED_IN');
    }
  });

  it('visits for DIFFERENT patients do not wait for or disturb each other', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ creditCost: 2 });
    const people = await Promise.all(Array.from({ length: 5 }, () => member('PREVENT', 4)));
    const visits = await Promise.all(people.map(({ p }) => checkedInVisit(clinic, p.id)));
    const results = await Promise.all(visits.map((v) => out(fd, v.booking.id, { payment: 'CREDITS' })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    for (const { p } of people) expect(await ledgerSum(p.id)).toBe(2);
  });
});

describe('what check-out refuses', () => {
  it('a visit nobody checked in, an unknown appointment, and a body that does not say how it was paid', async () => {
    const fd = await fdLogin();
    const clinic = await creditService();
    const { booking } = await checkedInVisit(clinic, null);
    await prisma.encounter.updateMany({ where: { bookingId: booking.id }, data: { status: 'SCHEDULED' } });
    expect((await out(fd, booking.id, { payment: 'CASH', priceCents: 5500 })).body.code).toBe('not_checked_in');
    expect((await out(fd, 'no-such-appointment', { payment: 'CASH' })).status).toBe(404);

    const v = await checkedInVisit(clinic, null);
    for (const bad of [{}, { payment: 'CHEQUE' }, { payment: 'PERK' }, { payment: 'CREDITS', priceCents: 5 }, { payment: 'CASH', priceCents: 'free' }, { payment: 'CASH', note: 'x' }]) {
      expect((await out(fd, v.booking.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: v.encounter.id } })).status).toBe('CHECKED_IN');
  });

  it('accepts a visit the provider has started or finished (IN_PROGRESS, SEEN) — only the front desk\'s own states are off limits', async () => {
    const fd = await fdLogin();
    const clinic = await creditService();
    for (const status of ['IN_PROGRESS', 'SEEN'] as const) {
      const v = await checkedInVisit(clinic, null);
      await prisma.encounter.update({ where: { id: v.encounter.id }, data: { status } });
      expect((await out(fd, v.booking.id, { payment: 'CASH' })).status, status).toBe(200);
    }
  });
});

describe('the revenue record cannot be rewritten', () => {
  it('rejects UPDATE and DELETE of a revenue event, a perk use, and a ledger row at the database', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ creditCost: 2 });
    const { p } = await member('RESTORE', 6);
    const { booking, encounter } = await checkedInVisit(clinic, p.id);
    await out(fd, booking.id, { payment: 'CREDITS' });
    const exec = (sql: string) => basePrisma.$executeRawUnsafe(sql);
    await expect(exec(`UPDATE "RevenueEvent" SET "listPriceCents" = 1 WHERE "encounterId" = '${encounter.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "RevenueEvent" WHERE "encounterId" = '${encounter.id}'`)).rejects.toThrow(/append-only/);

    const perkVisit = await (async () => {
      const c = await creditService();
      const { plan, perks } = await makePlan({ perks: [{ key: 'x', quantity: 1, serviceIds: [c.service.id] }] });
      const q = await makePatient();
      await prisma.membership.create({ data: { patientId: q.id, planId: plan.id, startedOn: new Date('2026-10-13'), nextGrantOn: new Date('2026-11-13'), createdById: 'x' } });
      const v = await checkedInVisit(c, q.id);
      await out(fd, v.booking.id, { payment: 'PERK', perkId: perks[0]!.id });
      return q;
    })();
    await expect(exec(`UPDATE "PerkUsage" SET quantity = 5 WHERE "patientId" = '${perkVisit.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "PerkUsage" WHERE "patientId" = '${perkVisit.id}'`)).rejects.toThrow(/append-only/);
  });

  it('refuses a self-contradictory row (a member sale with cash due, cash with credits, cash with no price)', async () => {
    const fd = await fdLogin();
    const clinic = await creditService();
    const { encounter, booking } = await checkedInVisit(clinic, null);
    const base = { bookingId: booking.id, serviceId: clinic.service.id, serviceName: 's', serviceCategory: 'c', occurredAt: new Date(), recordedById: fd.state.account.id };
    const bad = [
      { paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, netPriceCents: 500, listPriceCents: 5500 },   // member sale with money due
      { paymentType: 'CASH', memberBenefit: null, creditsRedeemed: 2, netPriceCents: 5500, listPriceCents: 5500 },         // cash that redeemed credits
      { paymentType: 'CASH', memberBenefit: null, creditsRedeemed: 0, netPriceCents: 0, listPriceCents: null },            // cash with no price
      { paymentType: 'MEMBER', memberBenefit: 'PERK', creditsRedeemed: 1, netPriceCents: 0, listPriceCents: 5500 },        // a perk that took credits
      { paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 0, netPriceCents: 0, listPriceCents: 5500 },     // "credits" that took none
      { paymentType: 'CASH', memberBenefit: null, creditsRedeemed: 0, listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 5500 }, // net is not list − discount
      { paymentType: 'CASH', memberBenefit: null, creditsRedeemed: 0, listPriceCents: 5500, discountPercent: 0, discountCents: 550, netPriceCents: 4950 },  // a discount with no percent
      { paymentType: 'CASH', memberBenefit: null, creditsRedeemed: 0, listPriceCents: 5500, discountPercent: 100, discountCents: 6000, netPriceCents: -500 }, // discount larger than the price
      { paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 0 }, // credits are not discounted
    ];
    for (const b of bad) {
      await expect(basePrisma.revenueEvent.create({ data: { ...base, encounterId: encounter.id, ...b } as never }), JSON.stringify(b)).rejects.toThrow();
    }
    expect(await events(encounter.id)).toHaveLength(0);
  });

  it('allows exactly one revenue event per visit', async () => {
    const fd = await fdLogin();
    const clinic = await creditService();
    const { encounter, booking } = await checkedInVisit(clinic, null);
    const row = { encounterId: encounter.id, bookingId: booking.id, serviceId: clinic.service.id, serviceName: 's', serviceCategory: 'c', occurredAt: new Date(), recordedById: fd.state.account.id, paymentType: 'CASH' as const, netPriceCents: 100, listPriceCents: 100 };
    await basePrisma.revenueEvent.create({ data: row });
    await expect(basePrisma.revenueEvent.create({ data: row })).rejects.toThrow();
  });
});

describe('the front desk screen after a check-out', () => {
  it('moves the visit to the Seen / checked out column', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500 });
    const v = await checkedInVisit(clinic, null);
    await prisma.booking.update({ where: { id: v.booking.id }, data: { startTime: new Date('2026-10-13T16:00:00Z'), endTime: new Date('2026-10-13T16:30:00Z') } });
    await out(fd, v.booking.id, { payment: 'CASH' });
    const dash = (await fd.agent.get('/api/fd/dashboard')).body;
    expect(dash.done.map((a: any) => a.id)).toContain(v.booking.id);
    expect(dash.checkedIn.map((a: any) => a.id)).not.toContain(v.booking.id);
  });
});

// ---- the member discount ---------------------------------------------------------------------------

describe('memberDiscount (whole cents, halves round up)', () => {
  it.each([
    [5500, 10, 550, 4950],
    [5500, 0, 0, 5500],
    [5500, 100, 5500, 0],
    [1999, 15, 300, 1699],      // 299.85 → 300
    [1999, 20, 400, 1599],      // 399.8 → 400
    [5, 10, 1, 4],              // 0.5 → 1: a half rounds up
    [4, 10, 0, 4],              // 0.4 → 0
    [1, 49, 0, 1],
    [1, 50, 1, 0],
    [18500, 20, 3700, 14800],
    [0, 20, 0, 0],
  ])('%i cents at %i%% takes off %i, leaving %i', (list, pct, off, net) => {
    expect(memberDiscount(list, pct)).toEqual({ discountCents: off, netCents: net });
    expect(off + net).toBe(list);
  });

  it('refuses a price or a percent that is not whole, or out of range', () => {
    for (const [list, pct] of [[-1, 10], [10.5, 10], [100, -1], [100, 101], [100, 12.5], [Number.NaN, 10]] as const) {
      expect(() => memberDiscount(list, pct), `${list}/${pct}`).toThrow(RangeError);
    }
  });
});

describe('paying cash with a member discount', () => {
  async function discounted(percent: number, status: 'ACTIVE' | 'PAUSED' = 'ACTIVE') {
    const { plan } = await makePlan({ discountPercent: percent });
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-10-13', { status });
    return { plan, p, m };
  }

  it('takes the tier percentage off the list price for an active member, and records all three figures', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500, creditCost: 2 });
    const { plan, p } = await discounted(10);
    const v = await checkedInVisit(clinic, p.id);

    const pv = (await preview(fd, v.booking.id)).body.preview;
    expect(pv.cash).toEqual({ priceCents: 5500, priceKnown: true, discountPercent: 10, discountCents: 550, netPriceCents: 4950 });

    const r = await out(fd, v.booking.id, { payment: 'CASH', expectedNetCents: 4950 });
    expect(r.status).toBe(200);
    expect(r.body.checkout).toMatchObject({ paymentType: 'CASH', memberBenefit: null, listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 4950, creditsRedeemed: 0 });
    expect((await events(v.encounter.id))[0]).toMatchObject({
      paymentType: 'CASH', listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 4950, planCode: plan.code,
    });
    const audit = await auditRows({ resourceType: 'revenue_event', action: 'CREATE' });
    expect(JSON.stringify(audit.find((a) => JSON.stringify(a.meta).includes('"discountCents":550'))?.meta)).toMatch(/"netPriceCents":4950/);
  });

  it('applies to a credit-eligible service paid in cash, and to one with no credit cost', async () => {
    const fd = await fdLogin();
    const { p } = await discounted(20);
    for (const creditCost of [2, null]) {
      const clinic = await creditService({ priceCents: 18500, creditCost });
      const v = await checkedInVisit(clinic, p.id);
      const r = await out(fd, v.booking.id, { payment: 'CASH' });
      expect(r.body.checkout, String(creditCost)).toMatchObject({ listPriceCents: 18500, discountPercent: 20, discountCents: 3700, netPriceCents: 14800 });
    }
  });

  it('rounds half a cent up', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 1999 });
    const { p } = await discounted(15);
    const v = await checkedInVisit(clinic, p.id);
    expect((await out(fd, v.booking.id, { payment: 'CASH' })).body.checkout).toMatchObject({ listPriceCents: 1999, discountCents: 300, netPriceCents: 1699 });
  });

  it('does not discount a non-member, a visit with no patient record, a paused member, or a tier set to 0%', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500 });
    const nonMember = await makePatient();
    const paused = (await discounted(20, 'PAUSED')).p;
    const zero = (await discounted(0)).p;
    for (const patientId of [nonMember.id, null, paused.id, zero.id]) {
      const v = await checkedInVisit(clinic, patientId);
      const r = await out(fd, v.booking.id, { payment: 'CASH' });
      expect(r.body.checkout, String(patientId)).toMatchObject({ listPriceCents: 5500, discountPercent: 0, discountCents: 0, netPriceCents: 5500 });
    }
  });

  it('never discounts credits or a perk — those events carry a zero discount and no money due', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 4500, creditCost: 2 });
    const { plan } = await makePlan({ discountPercent: 20, perks: [{ key: 'shot', label: 'Monthly shot', quantity: 1, serviceIds: [clinic.service.id] }] });
    const perkId = (await prisma.planPerk.findFirstOrThrow({ where: { planId: plan.id } })).id;
    const p = await makePatient();
    const m = await makeMembership(p.id, plan.code, '2026-10-13');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 6, periodStart: '2026-10-13', now: TUESDAY_1007 });

    const byCredits = await out(fd, (await checkedInVisit(clinic, p.id)).booking.id, { payment: 'CREDITS' });
    expect(byCredits.body.checkout).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'CREDITS', creditsRedeemed: 2, listPriceCents: 4500, discountPercent: 0, discountCents: 0, netPriceCents: 0 });
    const byPerk = await out(fd, (await checkedInVisit(clinic, p.id)).booking.id, { payment: 'PERK', perkId });
    expect(byPerk.body.checkout).toMatchObject({ paymentType: 'MEMBER', memberBenefit: 'PERK', creditsRedeemed: 0, listPriceCents: 4500, discountPercent: 0, discountCents: 0, netPriceCents: 0 });
  });

  it('treats the amount typed for an unpriced service as the LIST price and discounts it', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: null, creditCost: null });
    const { p } = await discounted(10);
    const v = await checkedInVisit(clinic, p.id);
    expect((await preview(fd, v.booking.id)).body.preview.cash).toEqual({ priceCents: null, priceKnown: false, discountPercent: 10, discountCents: null, netPriceCents: null });
    expect((await out(fd, v.booking.id, { payment: 'CASH' })).body.code).toBe('price_required');
    const r = await out(fd, v.booking.id, { payment: 'CASH', priceCents: 7300, expectedNetCents: 6570 });
    expect(r.body.checkout).toMatchObject({ listPriceCents: 7300, discountPercent: 10, discountCents: 730, netPriceCents: 6570 });
  });

  it('refuses, and records nothing, when the net the desk was shown is not what the server works out', async () => {
    const fd = await fdLogin();
    const clinic = await creditService({ priceCents: 5500 });
    const { p } = await discounted(10);
    const v = await checkedInVisit(clinic, p.id);
    const r = await out(fd, v.booking.id, { payment: 'CASH', expectedNetCents: 5500 });   // the desk saw no discount
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'price_changed', listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 4950 });
    expect(await events(v.encounter.id)).toHaveLength(0);
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: v.encounter.id } })).status).toBe('CHECKED_IN');
  });

  it('uses the percentage in force at check-out, so an admin edit between preview and submit is caught, not silently applied', async () => {
    const fd = await fdLogin();
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const clinic = await creditService({ priceCents: 5500 });
    const { plan, p } = await discounted(10);
    const v = await checkedInVisit(clinic, p.id);
    const shown = (await preview(fd, v.booking.id)).body.preview.cash.netPriceCents;
    expect(shown).toBe(4950);
    expect((await patch(admin, `/api/admin/membership-plans/${plan.id}`, { discountPercent: 20 })).status).toBe(200);
    expect((await out(fd, v.booking.id, { payment: 'CASH', expectedNetCents: shown })).body.code).toBe('price_changed');
    const r = await out(fd, v.booking.id, { payment: 'CASH', expectedNetCents: 4400 });
    expect(r.body.checkout).toMatchObject({ discountPercent: 20, discountCents: 1100, netPriceCents: 4400 });
  });

  it('replays the original figures on a second submit instead of recomputing them', async () => {
    const fd = await fdLogin();
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const clinic = await creditService({ priceCents: 5500 });
    const { plan, p } = await discounted(10);
    const v = await checkedInVisit(clinic, p.id);
    await out(fd, v.booking.id, { payment: 'CASH' });
    await patch(admin, `/api/admin/membership-plans/${plan.id}`, { discountPercent: 50 });
    const again = await out(fd, v.booking.id, { payment: 'CASH' });
    expect(again.body.checkout).toMatchObject({ alreadyCheckedOut: true, listPriceCents: 5500, discountPercent: 10, discountCents: 550, netPriceCents: 4950 });
    expect(await events(v.encounter.id)).toHaveLength(1);
  });
});

describe('the tier discount in the admin screen\'s API', () => {
  it('starts at 0% on all three seeded tiers', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const plans = (await admin.agent.get('/api/admin/membership-plans')).body.plans.filter((x: any) => ['PREVENT', 'RESTORE', 'OPTIMIZE'].includes(x.code));
    expect(plans).toHaveLength(3);
    expect(plans.map((x: any) => x.discountPercent)).toEqual([0, 0, 0]);
  });

  it('can be edited by an admin only, whole percent 0–100, and the change is audited with before and after', async () => {
    const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
    const fd = await fdLogin();
    const { plan } = await makePlan();
    const url = `/api/admin/membership-plans/${plan.id}`;
    for (const bad of [{ discountPercent: -1 }, { discountPercent: 101 }, { discountPercent: 12.5 }, { discountPercent: '10' }, { discountPercent: null }]) {
      expect((await patch(admin, url, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await patch(fd, url, { discountPercent: 10 })).status).toBe(403);
    expect((await patch(admin, url, { discountPercent: 15 })).status).toBe(200);
    expect((await prisma.membershipPlan.findUniqueOrThrow({ where: { id: plan.id } })).discountPercent).toBe(15);
    const rows = await auditRows({ resourceType: 'membership_plan', resourceId: plan.id, action: 'UPDATE' });
    expect((rows[0]!.meta as any).changes.discountPercent).toEqual({ from: 0, to: 15 });
  });

  it('is enforced by the database as well: a tier cannot be set above 100%', async () => {
    const { plan } = await makePlan();
    await expect(prisma.membershipPlan.update({ where: { id: plan.id }, data: { discountPercent: 101 } })).rejects.toThrow();
    await expect(prisma.membershipPlan.update({ where: { id: plan.id }, data: { discountPercent: -1 } })).rejects.toThrow();
  });
});
