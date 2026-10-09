import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import {
  addCredits, addMonthsISO, balance, expireLapsed, expiringSoon, firstGrantOnOrAfter, getLots, grantDate, lockPatient, monthsBetween, periodKey,
  spendable, takeCredits, toDateOnly,
} from '../src/lib/credits.js';
import { grantDue } from '../src/lib/membership.js';
import { runCreditExpiry, runMembershipGrants } from '../src/jobs/credits.js';
import { runAllJobsOnce } from '../src/jobs/scheduler.js';
import { loadIntegrations } from '../src/integrations/index.js';
import { makePatient } from './phase2.js';
import { grantLot, ledgerSum, makeMembership, planByCode, spendableOn } from './phase3.js';

afterAll(() => setClockForTests(null));
const at = (iso: string) => new Date(`${iso}T18:00:00Z`);   // noon-ish in Chicago: the clinic date is `iso` whatever the season
const take = (patientId: string, amount: number, today: string, reason: 'REDEMPTION' | 'ADJUSTMENT' = 'REDEMPTION') =>
  staffTransaction(async (tx, rec) => { await lockPatient(tx, patientId); return takeCredits(tx, rec, { patientId, amount, reason, today, now: at(today), actorAccountId: null }); });

describe('the tiers are data, and the seed matches the owner\'s structure', () => {
  it('has Prevent / Restore / Optimize at 4 / 6 / 8 credits a month, 90-day rollover, $99 / $199 / $299', async () => {
    const plans = await prisma.membershipPlan.findMany({ where: { code: { in: ['PREVENT', 'RESTORE', 'OPTIMIZE'] } }, orderBy: { sortOrder: 'asc' } });
    expect(plans.map((p) => [p.code, p.creditsPerMonth, p.rolloverDays, p.priceCents])).toEqual([
      ['PREVENT', 4, 90, 9900], ['RESTORE', 6, 90, 19900], ['OPTIMIZE', 8, 90, 29900],
    ]);
  });

  it('prices services in credits as the owner specified, and leaves the rest cash-only', async () => {
    const cost = async (slug: string, durationMin?: number) =>
      (await prisma.service.findFirstOrThrow({ where: { slug, ...(durationMin ? { durationMin } : {}) } })).creditCost;
    expect(await cost('manual-adjustment')).toBe(2);
    expect(await cost('red-light-therapy')).toBe(2);
    expect(await cost('hyperbaric-oxygen-therapy', 60)).toBe(4);
    expect(await cost('hyperbaric-oxygen-therapy', 90)).toBe(6);
    expect(await cost('vitamin-shots')).toBe(2);
    expect(await cost('iv-therapy')).toBe(6);
    for (const slug of ['spinal-xrays', 'body-composition', 'biomarker-testing', 'peptide-therapy', 'supplementation']) expect(await cost(slug), slug).toBeNull();
  });

  it('ships the perk counters pre-filled from the tier copy but SWITCHED OFF, with their services linked', async () => {
    const perks = await prisma.planPerk.findMany({ where: { plan: { code: { in: ['PREVENT', 'RESTORE', 'OPTIMIZE'] } } }, include: { plan: true, services: { include: { service: true } } }, orderBy: [{ plan: { sortOrder: 'asc' } }, { sortOrder: 'asc' }] });
    expect(perks).toHaveLength(9);
    expect(perks.every((p) => p.active === false)).toBe(true);
    const row = (code: string, key: string) => perks.find((p) => p.plan.code === code && p.key === key)!;
    expect(row('PREVENT', 'monthly_shot_or_iv')).toMatchObject({ quantity: 1, period: 'MONTHLY', label: 'Monthly vitamin shot' });
    expect(row('OPTIMIZE', 'monthly_shot_or_iv')).toMatchObject({ quantity: 1, period: 'MONTHLY', label: 'Monthly IV drip' });
    expect(row('RESTORE', 'guest_pass')).toMatchObject({ quantity: 1, period: 'QUARTERLY' });
    expect(row('OPTIMIZE', 'guest_pass')).toMatchObject({ quantity: 2, period: 'QUARTERLY' });
    expect(row('PREVENT', 'guest_pass').quantity).toBe(0);
    expect(row('PREVENT', 'monthly_shot_or_iv').services.map((s) => s.service.slug)).toEqual(['vitamin-shots']);
    expect(row('OPTIMIZE', 'monthly_shot_or_iv').services.map((s) => s.service.slug)).toEqual(['iv-therapy']);
    expect(row('RESTORE', 'quarterly_body_composition').services.map((s) => s.service.slug)).toEqual(['body-composition']);
    expect(row('RESTORE', 'guest_pass').services).toHaveLength(0);
  });
});

describe('dates', () => {
  it('anchor monthly grants on the start date, clamping short months without drifting', () => {
    const jan31 = [0, 1, 2, 3, 4].map((n) => grantDate('2026-01-31', n));
    expect(jan31).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(grantDate('2028-01-31', 1)).toBe('2028-02-29');                       // leap year
    expect(monthsBetween('2026-01-31', '2026-02-28')).toBe(1);
    expect(firstGrantOnOrAfter('2026-01-31', '2026-02-28')).toBe('2026-02-28');
    expect(firstGrantOnOrAfter('2026-01-31', '2026-03-01')).toBe('2026-03-31');
    expect(firstGrantOnOrAfter('2026-10-13', '2026-10-13')).toBe('2026-10-13');
    expect(addMonthsISO('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('count perks in calendar months, quarters and years', () => {
    expect(periodKey('MONTHLY', '2026-11-30')).toBe('2026-11');
    expect(periodKey('QUARTERLY', '2026-09-30')).toBe('2026-Q3');
    expect(periodKey('QUARTERLY', '2026-10-01')).toBe('2026-Q4');
    expect(periodKey('ANNUAL', '2026-10-01')).toBe('2026');
  });
});

describe('the monthly grant is idempotent', () => {
  it('grants once when the job runs twice, and advances the next grant date by one month', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'RESTORE', '2026-10-13');
    const first = await runMembershipGrants({ now: at('2026-10-13') });
    expect(first.granted).toBeGreaterThanOrEqual(1);
    const again = await runMembershipGrants({ now: at('2026-10-13') });
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id } })).toBe(1);
    expect(again.granted).toBe(0);

    const row = await basePrisma.creditLedger.findFirstOrThrow({ where: { membershipId: m.id } });
    expect(row).toMatchObject({ reason: 'MONTHLY_GRANT', delta: 6, patientId: p.id });
    expect(row.periodStart!.toISOString().slice(0, 10)).toBe('2026-10-13');
    expect(row.lotExpiresOn!.toISOString().slice(0, 10)).toBe('2027-01-11');            // 90 days from 13 Oct
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: m.id } })).nextGrantOn.toISOString().slice(0, 10)).toBe('2026-11-13');
  });

  it('grants once when many runners start at the same instant', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'OPTIMIZE', '2026-10-13');
    await Promise.all(Array.from({ length: 10 }, () => runMembershipGrants({ now: at('2026-10-13') })));
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id } })).toBe(1);
    expect(await ledgerSum(p.id)).toBe(8);
  });

  it('is guarded by the database too: a second grant for the same month is refused outright', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT');
    expect(await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-13' })).toBe(true);
    expect(await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-13' })).toBe(false);   // ON CONFLICT DO NOTHING
    await expect(basePrisma.creditLedger.create({
      data: { patientId: p.id, membershipId: m.id, reason: 'MONTHLY_GRANT', delta: 4, lotExpiresOn: toDateOnly('2027-01-11'), periodStart: toDateOnly('2026-10-13') },
    })).rejects.toThrow();                                                                   // unique (membership, period, reason)
    expect(await ledgerSum(p.id)).toBe(4);
  });

  it('makes up missed months one lot each, and then stops', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-07-13');                           // three months overdue by 13 Oct
    await runMembershipGrants({ now: at('2026-10-13') });
    const grants = await basePrisma.creditLedger.findMany({ where: { membershipId: m.id }, orderBy: { id: 'asc' } });
    expect(grants.map((g) => g.periodStart!.toISOString().slice(0, 10))).toEqual(['2026-07-13', '2026-08-13', '2026-09-13', '2026-10-13']);
    await runMembershipGrants({ now: at('2026-10-14') });
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id } })).toBe(4);
  });

  it('follows the CLINIC\'s calendar, not UTC: due on 1 Nov, not yet at 23:30 CDT on 31 Oct', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-11-01');
    await runMembershipGrants({ now: new Date('2026-11-01T04:30:00Z') });                   // 23:30 CDT, 31 Oct — it is already 1 Nov in UTC
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id } })).toBe(0);
    await runMembershipGrants({ now: new Date('2026-11-01T05:00:00Z') });                   // 00:00 CDT, 1 Nov
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id } })).toBe(1);
  });

  it('does not grant to a paused or cancelled membership', async () => {
    const paused = await makeMembership((await makePatient()).id, 'PREVENT', '2026-10-13', { status: 'PAUSED' });
    const cancelled = await makeMembership((await makePatient()).id, 'PREVENT', '2026-10-13', { status: 'CANCELLED' });
    await runMembershipGrants({ now: at('2026-10-20') });
    expect(await basePrisma.creditLedger.count({ where: { membershipId: { in: [paused.id, cancelled.id] } } })).toBe(0);
  });
});

describe('redemption is FIFO', () => {
  async function threeLots() {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-08-13');
    for (const [credits, period] of [[4, '2026-08-13'], [4, '2026-09-13'], [4, '2026-10-13']] as const) await grantLot({ patientId: p.id, membershipId: m.id, credits, periodStart: period });
    return p;
  }
  const lotsOf = (id: string) => getLots(basePrisma, id, '2026-10-14');

  it('draws from the OLDEST lot first and spills into the next', async () => {
    const p = await threeLots();
    const r = await take(p.id, 6, '2026-10-14');
    expect(r).toMatchObject({ before: 12, after: 6 });
    expect(r.drawnFrom.map((d) => d.amount)).toEqual([4, 2]);
    const lots = await lotsOf(p.id);
    expect(lots.map((l) => [l.period, l.remaining, l.status])).toEqual([['2026-08-13', 0, 'USED'], ['2026-09-13', 2, 'ACTIVE'], ['2026-10-13', 4, 'ACTIVE']]);

    const next = await take(p.id, 3, '2026-10-14');
    expect(next.drawnFrom.map((d) => d.amount)).toEqual([2, 1]);                             // finish September, then start October
    expect((await lotsOf(p.id)).map((l) => l.remaining)).toEqual([0, 0, 3]);
    expect(await spendableOn(p.id, '2026-10-14')).toBe(3);
  });

  it('refuses to take more than is there, writing nothing at all', async () => {
    const p = await threeLots();
    const before = await basePrisma.creditLedger.count({ where: { patientId: p.id } });
    await expect(take(p.id, 13, '2026-10-14')).rejects.toMatchObject({ status: 409, code: 'insufficient_credits' });
    expect(await basePrisma.creditLedger.count({ where: { patientId: p.id } })).toBe(before);
    expect(await basePrisma.creditAllocation.count({ where: { lot: { patientId: p.id } } })).toBe(0);
    for (const bad of [0, -1, 1.5]) await expect(take(p.id, bad, '2026-10-14')).rejects.toMatchObject({ status: 400 });
  });

  it('orders by expiry, so a manual add (a later expiry) is spent after older monthly credits', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-09-13');
    const admin = await prisma.account.create({ data: { email: `fifo-${Date.now()}@example.test`, displayName: 'Adj', roles: ['ADMIN'], passwordHash: 'x' } });
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-09-13' });                 // expires 2026-12-12
    await staffTransaction(async (tx, rec) => { await lockPatient(tx, p.id); await addCredits(tx, rec, { patientId: p.id, amount: 5, today: '2026-10-01', now: at('2026-10-01'), rolloverDays: 90, actorAccountId: admin.id, reasonCode: 'goodwill' }); }); // expires 2026-12-30
    const r = await take(p.id, 6, '2026-10-02');
    expect(r.drawnFrom.map((d) => d.amount)).toEqual([4, 2]);
  });

  it('records which lot each credit came from, and the balance equals SUM(delta)', async () => {
    const p = await threeLots();
    await take(p.id, 5, '2026-10-14');
    const allocs = await basePrisma.creditAllocation.findMany({ where: { ledger: { patientId: p.id } }, orderBy: { id: 'asc' } });
    expect(allocs.map((a) => a.amount)).toEqual([4, 1]);
    expect(await ledgerSum(p.id)).toBe(7);
    expect(await spendableOn(p.id, '2026-10-14')).toBe(7);
  });
});

describe('credits expire — and expire oldest first', () => {
  it('are spendable through the last day and not after; the balance never counts a lapsed lot, with or without the job', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-08-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-08-01' });     // last usable day: 2026-10-30
    expect((await getLots(basePrisma, p.id, '2026-10-30'))[0]).toMatchObject({ expiresOn: '2026-10-30', status: 'ACTIVE', remaining: 4 });
    expect(await spendableOn(p.id, '2026-10-30')).toBe(4);
    expect((await getLots(basePrisma, p.id, '2026-10-31'))[0]).toMatchObject({ status: 'LAPSED' });
    expect(await spendableOn(p.id, '2026-10-31')).toBe(0);
    await expect(take(p.id, 1, '2026-10-31')).rejects.toMatchObject({ code: 'insufficient_credits' });
  });

  it('are written down by the job: one EXPIRATION row per lot, SUM(delta) equals the balance, and it is idempotent', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-06-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-06-01' });     // expires 2026-08-30
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-07-01' });     // expires 2026-09-29
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-01' });     // expires 2026-12-30
    await take(p.id, 3, '2026-07-02');                                                                   // 3 from June's lot
    expect(await ledgerSum(p.id)).toBe(9);

    const r = await runCreditExpiry({ now: at('2026-10-14') });
    expect(r.creditsExpired).toBeGreaterThanOrEqual(1 + 4);                                              // (counts every patient in the shared test schema)
    const expirations = await basePrisma.creditLedger.findMany({ where: { patientId: p.id, reason: 'EXPIRATION' }, orderBy: { id: 'asc' } });
    expect(expirations.map((e) => e.delta)).toEqual([-1, -4]);                                           // oldest lot first
    expect(await ledgerSum(p.id)).toBe(4);
    expect(await spendableOn(p.id, '2026-10-14')).toBe(4);
    const lots = await getLots(basePrisma, p.id, '2026-10-14');
    expect(lots.map((l) => l.status)).toEqual(['EXPIRED', 'EXPIRED', 'ACTIVE']);                          // a lot with anything written off is EXPIRED, even if part was used
    expect(lots.map((l) => [l.granted, l.redeemed, l.expired, l.remaining])).toEqual([[4, 3, 1, 0], [4, 0, 4, 0], [4, 0, 0, 4]]);

    const again = await runCreditExpiry({ now: at('2026-10-14') });
    expect(again.creditsExpired).toBe(0);
    expect(await basePrisma.creditLedger.count({ where: { patientId: p.id, reason: 'EXPIRATION' } })).toBe(2);
  });

  it('never lets a redemption draw from a lapsed lot, even before the job has written it down', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-06-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-06-01' });     // lapsed by October
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-01' });
    const r = await take(p.id, 4, '2026-10-14');
    expect(r.drawnFrom).toHaveLength(1);
    expect((await getLots(basePrisma, p.id, '2026-10-14')).map((l) => [l.remaining, l.status])).toEqual([[4, 'LAPSED'], [0, 'USED']]);
  });

  it('reports what is about to expire', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-08-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-08-01' });     // 2026-10-30
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-01' });
    const lots = await getLots(basePrisma, p.id, '2026-10-14');
    expect(expiringSoon(lots, '2026-10-14')).toEqual({ on: '2026-10-30', credits: 4 });
    expect(expiringSoon(lots, '2026-10-14', 5)).toBeNull();
  });
});

describe('the database refuses to let the ledger be edited or overdrawn', () => {
  async function ledgerWithRedemption() {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-13' });
    await take(p.id, 1, '2026-10-14');
    return p;
  }

  it('rejects UPDATE, DELETE and TRUNCATE on every append-only table', async () => {
    const p = await ledgerWithRedemption();
    const exec = (sql: string) => basePrisma.$executeRawUnsafe(sql);
    await expect(exec(`UPDATE "CreditLedger" SET delta = 99 WHERE "patientId" = '${p.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "CreditLedger" WHERE "patientId" = '${p.id}'`)).rejects.toThrow(/append-only/);
    await expect(exec(`UPDATE "CreditAllocation" SET amount = 99`)).rejects.toThrow(/append-only/);
    await expect(exec(`DELETE FROM "CreditAllocation"`)).rejects.toThrow(/append-only/);
    await expect(exec(`TRUNCATE "CreditLedger" CASCADE`)).rejects.toThrow(/append-only/);
    await expect(exec(`TRUNCATE "CreditAllocation"`)).rejects.toThrow(/append-only/);
    // (PerkUsage and RevenueEvent hold no rows yet, so a row trigger has nothing to fire on; their
    // UPDATE/DELETE are exercised in checkout.test.ts. TRUNCATE is a statement trigger and fires regardless.)
    await expect(exec(`TRUNCATE "PerkUsage"`)).rejects.toThrow(/append-only/);
    await expect(exec(`TRUNCATE "RevenueEvent"`)).rejects.toThrow(/append-only/);
    expect(await ledgerSum(p.id)).toBe(3);
  });

  it('rejects a ledger row of the wrong shape (a grant with no expiry, a zero row, a redemption with an expiry)', async () => {
    const p = await makePatient();
    await expect(basePrisma.creditLedger.create({ data: { patientId: p.id, reason: 'ADJUSTMENT', delta: 3 } })).rejects.toThrow();                                   // lot without expiry
    await expect(basePrisma.creditLedger.create({ data: { patientId: p.id, reason: 'ADJUSTMENT', delta: 0, lotExpiresOn: toDateOnly('2027-01-01') } })).rejects.toThrow();
    await expect(basePrisma.creditLedger.create({ data: { patientId: p.id, reason: 'REDEMPTION', delta: -1, lotExpiresOn: toDateOnly('2027-01-01') } })).rejects.toThrow();
  });

  it('refuses a commit that removes credits with no allocation, or that draws a lot below zero', async () => {
    const p = await ledgerWithRedemption();                                                              // lot of 4, 1 redeemed
    const lot = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id, delta: { gt: 0 } } });
    // A removal whose allocations do not add up.
    await expect(basePrisma.$transaction(async (tx) => { await tx.creditLedger.create({ data: { patientId: p.id, reason: 'REDEMPTION', delta: -2 } }); })).rejects.toThrow(/allocations total/);
    // An allocation that takes the lot below zero (3 left; draw 4).
    await expect(basePrisma.$transaction(async (tx) => {
      const r = await tx.creditLedger.create({ data: { patientId: p.id, reason: 'REDEMPTION', delta: -4 } });
      await tx.creditAllocation.create({ data: { ledgerId: r.id, lotId: lot.id, amount: 4 } });
    })).rejects.toThrow(/overdrawn/);
    // An allocation from something that is not a lot.
    const neg = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id, delta: { lt: 0 } } });
    await expect(basePrisma.$transaction(async (tx) => {
      const r = await tx.creditLedger.create({ data: { patientId: p.id, reason: 'REDEMPTION', delta: -1 } });
      await tx.creditAllocation.create({ data: { ledgerId: r.id, lotId: neg.id, amount: 1 } });
    })).rejects.toThrow(/positive lot/);
    expect(await ledgerSum(p.id)).toBe(3);                                                                // nothing above changed anything
  });

  it('catches two transactions that each take the last credits even when NOTHING locks (the backstop)', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-13' });
    const lot = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id, delta: { gt: 0 } } });

    let reached = 0;
    const bothInserted = new Promise<void>((resolve) => { const t = setInterval(() => { if (reached === 2) { clearInterval(t); resolve(); } }, 5); });
    const racer = (wait: number) => basePrisma.$transaction(async (tx) => {
      const r = await tx.creditLedger.create({ data: { patientId: p.id, reason: 'REDEMPTION', delta: -3 } });
      await tx.creditAllocation.create({ data: { ledgerId: r.id, lotId: lot.id, amount: 3 } });
      reached++;
      await bothInserted;
      if (wait) await new Promise((res) => setTimeout(res, wait));      // the second commits strictly after the first
    }, { timeout: 20_000 });
    const results = await Promise.allSettled([racer(0), racer(300)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await ledgerSum(p.id)).toBe(1);                              // 4 − 3: never −2
  });
});

describe('concurrent redemptions for one patient', () => {
  it('can never spend more than the balance: 8 credits, ten requests for 2 → exactly four succeed', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'OPTIMIZE');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 8, periodStart: '2026-10-13' });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => take(p.id, 2, '2026-10-14')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'insufficient_credits' });
    expect(await ledgerSum(p.id)).toBe(0);
    expect(await spendableOn(p.id, '2026-10-14')).toBe(0);
  });

  it('a redemption racing the expiry job never double-spends a lot', async () => {
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-06-01');
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-06-01' });     // lapses 2026-08-30
    await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2026-10-01' });
    const results = await Promise.allSettled([
      runCreditExpiry({ now: at('2026-10-14') }),
      take(p.id, 4, '2026-10-14'), take(p.id, 4, '2026-10-14'),
    ]);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(1);                              // only 4 spendable: one redemption is refused
    expect(await ledgerSum(p.id)).toBe(0);
    const lots = await getLots(basePrisma, p.id, '2026-10-14');
    for (const l of lots) expect(l.remaining).toBeGreaterThanOrEqual(0);
  });
});

describe('manual adjustment, expiry write-down, and perk-free helpers', () => {
  it('adds credits as a NEW lot with its own expiry, and writes the reason code', async () => {
    const p = await makePatient();
    const admin = await prisma.account.create({ data: { email: `adj-${Date.now()}@example.test`, displayName: 'Adj', roles: ['ADMIN'], passwordHash: 'x' } });
    const r = await staffTransaction(async (tx, rec) => { await lockPatient(tx, p.id); return addCredits(tx, rec, { patientId: p.id, amount: 3, today: '2026-10-14', now: at('2026-10-14'), rolloverDays: 90, actorAccountId: admin.id, reasonCode: 'opening_balance' }); });
    expect(r).toEqual({ before: 0, after: 3 });
    const row = await basePrisma.creditLedger.findFirstOrThrow({ where: { patientId: p.id } });
    expect(row).toMatchObject({ reason: 'ADJUSTMENT', delta: 3, reasonCode: 'opening_balance', actorAccountId: admin.id });
    expect(row.lotExpiresOn!.toISOString().slice(0, 10)).toBe('2027-01-12');
  });

  it('expireLapsed on a patient with nothing lapsed writes nothing', async () => {
    const p = await makePatient();
    const n = await staffTransaction(async (tx, rec) => { await lockPatient(tx, p.id); return expireLapsed(tx, rec, p.id, '2026-10-14', at('2026-10-14')); });
    expect(n).toBe(0);
    expect(await balance(basePrisma, p.id, '2026-10-14')).toBe(0);
  });

  it('refuses to lock a patient who does not exist', async () => {
    await expect(staffTransaction((tx) => lockPatient(tx, 'no-such-patient'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('jobs:run runs the credit jobs', () => {
  it('grants and expires through the one entry point, and reports both', async () => {
    await loadIntegrations();
    const p = await makePatient();
    const m = await makeMembership(p.id, 'PREVENT', '2026-01-01');
    const r = await runAllJobsOnce();
    expect(r.membershipGrants).not.toBeNull();
    expect(r.creditExpiry).not.toBeNull();
    // 2026-01-01 → now: the job made up every month it could (at most 12 per run), and the oldest have lapsed.
    expect(await basePrisma.creditLedger.count({ where: { membershipId: m.id, reason: 'MONTHLY_GRANT' } })).toBeGreaterThan(0);
    void planByCode; void setClockForTests; void beforeAll; void grantDue; void spendable;
  });
});
