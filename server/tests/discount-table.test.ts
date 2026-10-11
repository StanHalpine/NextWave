import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { runAsSystem } from '../src/lib/audit.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { checkoutVisit, checkoutPreview } from '../src/lib/checkout.js';
import { setCategoryDiscounts } from '../src/lib/discountConfig.js';
import { APPROVED_CATEGORIES, TIER_RATES, applyApprovedTable } from '../src/lib/discountTable.js';
import { auditRows, blob, makeAccount, signInFully } from './helpers.js';
import { makePatient } from './phase2.js';
import { makeCategory, makeMembership } from './phase3.js';

/**
 * The approved table: Prevent 10% · Restore 15% · Optimize 20%, on Spinal X-rays, Supplements and Special services — entered by
 * lib/discountTable.ts through the admin screen's own operations. These tests enter it into the (shared) test schema and ALWAYS take
 * it back out, because other files assert that the seeded tiers start with no discounts.
 */

const CODES = ['SPINAL_X_RAYS', 'SUPPLEMENTS', 'SPECIAL_SERVICES'];
const CDT = (local: string) => new Date(`${local}-06:00`);                              // February: CST
const apply = () => runAsSystem('apply-discount-table', () => staffTransaction((tx, rec) => applyApprovedTable(tx, rec)));
const takeOut = async () => { await prisma.discountCategory.deleteMany({ where: { code: { in: CODES } } }); };   // services become uncategorised; percentages cascade
afterAll(takeOut);

async function withTable<T>(fn: () => Promise<T>): Promise<T> {
  expect(await prisma.discountCategory.count({ where: { code: { in: CODES } } }), 'a previous test left the table in').toBe(0);
  try { return await fn(); } finally { await takeOut(); }
}

const percentsOf = async (code: string) => {
  const rows = await prisma.planCategoryDiscount.findMany({ where: { category: { code } }, include: { plan: { select: { code: true } } } });
  return Object.fromEntries(rows.map((r) => [r.plan.code, r.percent]));
};

describe('the approved table', () => {
  it('is Prevent 10%, Restore 15%, Optimize 20% — the tier\'s rate, the same on every category, X-rays included', async () => {
    expect(TIER_RATES).toEqual({ PREVENT: 10, RESTORE: 15, OPTIMIZE: 20 });
    expect(APPROVED_CATEGORIES.map((c) => [c.name, c.serviceSlugs])).toEqual([['Spinal X-rays', ['spinal-xrays']], ['Supplements', ['supplementation']], ['Special services', []]]);
    await withTable(async () => {
      const out = await apply();
      expect(out.map((c) => [c.name, c.outcome])).toEqual([['Spinal X-rays', 'created'], ['Supplements', 'created'], ['Special services', 'created']]);
      for (const code of CODES) expect(await percentsOf(code), code).toEqual({ PREVENT: 10, RESTORE: 15, OPTIMIZE: 20 });   // not a separate 20% for X-rays
      const members = async (code: string) => (await prisma.service.findMany({ where: { discountCategory: { code } }, select: { slug: true } })).map((s) => s.slug);
      expect(await members('SPINAL_X_RAYS')).toEqual(['spinal-xrays']);
      expect(await members('SUPPLEMENTS')).toEqual(['supplementation']);
      expect(await members('SPECIAL_SERVICES')).toEqual([]);                          // no such service yet: it discounts nothing today
      expect((await prisma.discountCategory.findMany({ where: { code: { in: CODES } } })).every((c) => c.active)).toBe(true);
    });
  });

  it('leaves perks off, and discounts nothing else: no other service is in a category', async () => {
    await withTable(async () => {
      await apply();
      expect(await prisma.planPerk.count({ where: { active: true, plan: { code: { in: ['PREVENT', 'RESTORE', 'OPTIMIZE'] } } } })).toBe(0);   // (other files make plans of their own)
      const inCategory = await prisma.service.findMany({ where: { id: { startsWith: '5e401ce0-' }, discountCategoryId: { not: null } }, select: { slug: true } });
      expect(inCategory.map((s) => s.slug).sort()).toEqual(['spinal-xrays', 'supplementation']);
    });
  });

  it('is what the admin screen sees and can change: the same categories, percentages by tier, editable there', async () => {
    await withTable(async () => {
      await apply();
      const admin = await signInFully((await makeAccount({ roles: ['ADMIN'] })).email);
      const body = (await admin.agent.get('/api/admin/discount-categories')).body;
      const plans = Object.fromEntries(body.plans.map((p: { id: string; code: string }) => [p.id, p.code]));
      const mine = body.categories.filter((c: { code: string }) => CODES.includes(c.code));
      expect(mine.map((c: { name: string }) => c.name)).toEqual(['Spinal X-rays', 'Supplements', 'Special services']);
      const tiers = ['PREVENT', 'RESTORE', 'OPTIMIZE'];          // other files make plans of their own, which show as 0%
      for (const c of mine) expect(Object.fromEntries(Object.entries(c.percents as Record<string, number>).map(([id, p]) => [plans[id], p]).filter(([code]) => tiers.includes(code as string))), c.name).toEqual({ PREVENT: 10, RESTORE: 15, OPTIMIZE: 20 });
    });
  });

  it('is audited like any admin change — configuration only, attributed to the system actor, no patient anywhere', async () => {
    await withTable(async () => {
      await apply();
      const cats = await prisma.discountCategory.findMany({ where: { code: { in: CODES } } });
      const rows = (await Promise.all(cats.map((c) => auditRows({ resourceType: 'discount_category', resourceId: c.id })))).flat();
      expect(rows.filter((r) => r.action === 'CREATE')).toHaveLength(3);
      const discounts = rows.filter((r) => (r.meta as { fields?: string[] } | null)?.fields?.includes('discounts'));
      expect(discounts).toHaveLength(3);
      for (const r of discounts) expect(Object.values((r.meta as { changes: Record<string, { from: number; to: number }> }).changes).map((c) => [c.from, c.to]).sort()).toEqual([[0, 10], [0, 15], [0, 20]]);
      expect(new Set(rows.map((r) => r.actorRoles))).toEqual(new Set(['system:apply-discount-table']));
      expect(blob(rows)).not.toMatch(/@|firstName|phone/i);
    });
  });
});

describe('entering it twice, or after an administrator has changed things', () => {
  it('is safe to run twice: the second run changes nothing and writes nothing', async () => {
    await withTable(async () => {
      await apply();
      const before = await prisma.auditLog.count({ where: { resourceType: 'discount_category' } });
      const again = await apply();
      expect(again.map((c) => c.outcome)).toEqual(['kept', 'kept', 'kept']);
      expect(await prisma.auditLog.count({ where: { resourceType: 'discount_category' } })).toBe(before);
      expect(await prisma.discountCategory.count({ where: { code: { in: CODES } } })).toBe(3);
    });
  });

  it('never overwrites an edit: a percentage an administrator changed, or a category switched off, stays', async () => {
    await withTable(async () => {
      await apply();
      const xr = await prisma.discountCategory.findUniqueOrThrow({ where: { code: 'SPINAL_X_RAYS' } });
      const restore = await prisma.membershipPlan.findUniqueOrThrow({ where: { code: 'RESTORE' } });
      await staffTransaction((tx, rec) => setCategoryDiscounts(tx, rec, xr.id, { [restore.id]: 18 }));
      await prisma.discountCategory.update({ where: { code: 'SUPPLEMENTS' }, data: { active: false } });
      await apply();
      expect((await percentsOf('SPINAL_X_RAYS')).RESTORE).toBe(18);
      expect((await prisma.discountCategory.findUniqueOrThrow({ where: { code: 'SUPPLEMENTS' } })).active).toBe(false);
    });
  });

  it('does not take a service out of another category — it says so and enters the rest', async () => {
    const xray = await prisma.service.findFirstOrThrow({ where: { slug: 'spinal-xrays', id: { startsWith: '5e401ce0-' } } });
    const other = await makeCategory({ serviceIds: [xray.id] });
    try {
      await withTable(async () => {
        const out = await apply();
        expect(out[0]).toMatchObject({ name: 'Spinal X-rays', outcome: 'created', services: [], skipped: ['spinal-xrays'] });
        expect((await prisma.service.findUniqueOrThrow({ where: { id: xray.id } })).discountCategoryId).toBe(other.id);
        expect(out[1]).toMatchObject({ name: 'Supplements', services: ['supplementation'], skipped: [] });
      });
    } finally {
      await prisma.service.update({ where: { id: xray.id }, data: { discountCategoryId: null } });
      await prisma.discountCategory.delete({ where: { id: other.id } });
    }
  });

  it('refuses to run without the three tiers, rather than half-enter a table', async () => {
    await withTable(async () => {
      await expect(staffTransaction(async (tx, rec) => {
        await tx.membershipPlan.update({ where: { code: 'OPTIMIZE' }, data: { code: 'OPTIMIZE_RENAMED' } });
        return applyApprovedTable(tx, rec);
      })).rejects.toThrow(/Prevent, Restore and Optimize/);
      expect((await prisma.membershipPlan.findMany({ where: { code: 'OPTIMIZE' } }))).toHaveLength(1);         // the rename rolled back with it
      expect(await prisma.discountCategory.count({ where: { code: { in: CODES } } })).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------------------------------
describe('what a member is charged at check-out, through the entered table', () => {
  let rooms = 0;
  /** A checked-in visit for the SEEDED service (the table is on the seeded services), ready to check out. */
  async function visit(slug: string, patientId: string | null, minute: number) {
    const service = await prisma.service.findFirstOrThrow({ where: { slug, id: { startsWith: '5e401ce0-' } } });
    const room = await prisma.resource.create({ data: { name: `Table Room ${Date.now()}-${++rooms}`, type: 'TEST_ROOM', maxCapacity: 1 } });
    const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: '6125550000' } });
    const start = new Date(Date.UTC(2037, 1, 10, 16, minute));
    const booking = await prisma.booking.create({
      data: { userId: user.id, serviceId: service.id, resourceId: room.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000), status: 'CONFIRMED', source: 'FRONT_DESK', patientId },
    });
    await prisma.encounter.create({ data: { bookingId: booking.id, status: 'CHECKED_IN', checkedInAt: start } });
    return booking;
  }
  const cash = async (slug: string, patientId: string | null, minute: number, priceCents?: number) => {
    const booking = await visit(slug, patientId, minute);
    const account = await makeAccount({ roles: ['FRONT_DESK'] });
    const r = await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: account.id, now: CDT('2037-02-10T11:00:00'), payment: 'CASH', ...(priceCents ? { priceCents } : {}) }));
    return { r, event: await basePrisma.revenueEvent.findFirstOrThrow({ where: { bookingId: booking.id } }), booking };
  };
  const memberOn = async (code: 'PREVENT' | 'RESTORE' | 'OPTIMIZE', status: 'ACTIVE' | 'PAUSED' = 'ACTIVE') => {
    const p = await makePatient();
    await makeMembership(p.id, code, '2037-01-05', { status });
    return p;
  };

  it('takes the tier\'s rate off a spinal X-ray ($250.00): Prevent 10%, Restore 15%, Optimize 20% — not 20% for everyone, not 25%', async () => {
    await withTable(async () => {
      await apply();
      const rows: Array<[string, number, number]> = [];
      for (const [i, code] of (['PREVENT', 'RESTORE', 'OPTIMIZE'] as const).entries()) {
        const { r, event } = await cash('spinal-xrays', (await memberOn(code)).id, i);
        rows.push([code, r.discountCents, r.netPriceCents]);
        expect(event).toMatchObject({ listPriceCents: 25000, discountPercent: TIER_RATES[code], discountCents: r.discountCents, discountCategory: 'SPINAL_X_RAYS', planCode: code });
      }
      expect(rows).toEqual([['PREVENT', 2500, 22500], ['RESTORE', 3750, 21250], ['OPTIMIZE', 5000, 20000]]);
    });
  });

  it('takes the same rate off supplementation, which has no set price (the desk types the list price): halves round up', async () => {
    await withTable(async () => {
      await apply();
      const got: Array<[string, number, number]> = [];
      for (const [i, code] of (['PREVENT', 'RESTORE', 'OPTIMIZE'] as const).entries()) {
        const { r } = await cash('supplementation', (await memberOn(code)).id, 10 + i, 1999);          // $19.99
        got.push([code, r.discountCents, r.netPriceCents]);
      }
      expect(got).toEqual([['PREVENT', 200, 1799], ['RESTORE', 300, 1699], ['OPTIMIZE', 400, 1599]]);     // 199.9→200 · 299.85→300 · 399.8→400
    });
  });

  it('discounts no one else: a non-member, a paused member, and any service outside the table pay list price', async () => {
    await withTable(async () => {
      await apply();
      expect((await cash('spinal-xrays', null, 20)).r).toMatchObject({ discountPercent: 0, discountCents: 0, netPriceCents: 25000 });
      expect((await cash('spinal-xrays', (await memberOn('OPTIMIZE', 'PAUSED')).id, 21)).r).toMatchObject({ discountCents: 0, netPriceCents: 25000 });
      expect((await cash('manual-adjustment', (await memberOn('OPTIMIZE')).id, 22)).r).toMatchObject({ discountCents: 0, netPriceCents: 5500 });   // not in any category
      expect((await cash('red-light-therapy', (await memberOn('RESTORE')).id, 23)).r).toMatchObject({ discountCents: 0, netPriceCents: 5500 });
    });
  });

  it('shows the desk list, discount and net before it confirms, naming the category — and refuses if the figure changed under it', async () => {
    await withTable(async () => {
      await apply();
      const p = await memberOn('RESTORE');
      const booking = await visit('spinal-xrays', p.id, 30);
      const preview = (await checkoutPreview(basePrisma as never, booking.id, CDT('2037-02-10T11:00:00')))!;
      expect(preview.cash).toMatchObject({ priceCents: 25000, discountPercent: 15, discountCategory: 'Spinal X-rays' });
      const account = await makeAccount({ roles: ['FRONT_DESK'] });
      await expect(staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: account.id, now: CDT('2037-02-10T11:00:00'), payment: 'CASH', expectedNetCents: 20000 }))).rejects.toMatchObject({ code: 'price_changed' });
      const ok = await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: account.id, now: CDT('2037-02-10T11:00:00'), payment: 'CASH', expectedNetCents: 21250 }));
      expect(ok).toMatchObject({ listPriceCents: 25000, discountCents: 3750, netPriceCents: 21250 });
    });
  });

  it('never discounts a visit paid with credits or a perk', async () => {
    await withTable(async () => {
      await apply();
      // Supplementation and X-rays carry no credit cost, so use a credit-eligible service the table does not cover.
      const p = await memberOn('OPTIMIZE');
      const booking = await visit('manual-adjustment', p.id, 40);
      const account = await makeAccount({ roles: ['FRONT_DESK'] });
      const { grantLot } = await import('./phase3.js');
      const m = await prisma.membership.findFirstOrThrow({ where: { patientId: p.id } });
      await grantLot({ patientId: p.id, membershipId: m.id, credits: 4, periodStart: '2037-02-01', now: new Date('2037-02-01T12:00:00Z') });
      const r = await staffTransaction((tx, rec) => checkoutVisit(tx, rec, { bookingId: booking.id, accountId: account.id, now: CDT('2037-02-10T11:00:00'), payment: 'CREDITS' }));
      expect(r).toMatchObject({ paymentType: 'MEMBER', discountPercent: 0, discountCents: 0, netPriceCents: 0, creditsRedeemed: 2 });
    });
  });
});
