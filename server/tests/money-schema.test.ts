import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { chargesOf } from '../src/lib/money.js';
import { makePatient, post, slotAt, TUESDAY_1007 } from './phase2.js';
import { adminLogin, frontDeskLogin, visit } from './phase4.js';
import { makeMembership } from './phase3.js';

/**
 * The money layer's database backstops (migration 20261023120000_money_layer): append-only tables, the commit-time money guard, the
 * charge rule, the promotion freeze, and the settlement of charges from before payments were tracked — exercised with direct SQL,
 * past the application's own checks.
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const key = () => `t${randomUUID().replace(/-/g, '')}`;
const exec = (sql: string) => basePrisma.$executeRawUnsafe(sql);
type S = Awaited<ReturnType<typeof frontDeskLogin>>;

async function ledgerVersion(s: S, pid: string) { return (await s.agent.get(`/api/fd/patients/${pid}/ledger`)).body.money.version as string; }
async function checkedOut(fd: S, o: { payment?: number; overpayment?: 'ACCOUNT_CREDIT' | 'REFUND' } = {}) {
  const p = await makePatient();
  const v = await visit({ encounter: 'CHECKED_IN', patientId: p.id, start: slotAt('09:00') });
  await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: 5500 } });
  const r = await post(fd, `/api/fd/patients/${p.id}/checkout`, {
    idempotencyKey: key(), expectedVersion: await ledgerVersion(fd, p.id), visits: [{ bookingId: v.booking.id, pay: 'MONEY' }],
    ...(o.payment ? { payment: { tender: 'CASH', amountCents: o.payment }, confirmPartial: true } : {}),
    ...(o.overpayment ? { overpayment: o.overpayment === 'REFUND' ? { as: 'REFUND' } : { as: 'ACCOUNT_CREDIT' } } : {}),
  });
  expect(r.status).toBe(200);
  const charge = await basePrisma.revenueEvent.findFirstOrThrow({ where: { bookingId: v.booking.id } });
  return { p, v, charge, body: r.body };
}

/** Run statements in one transaction; resolve with the error the COMMIT raises (or null). */
async function commitError(statements: string[]): Promise<string | null> {
  try {
    await basePrisma.$transaction(async (tx) => { for (const s of statements) await tx.$executeRawUnsafe(s); });
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}
const pay = (id: string, patientId: string, cents: number, tender = 'CASH') =>
  `INSERT INTO "Payment" ("id","patientId","collectedOn","receivedAt","recordedById","tender","amountCents") VALUES ('${id}','${patientId}','2026-10-13',now(),'test','${tender}',${cents})`;
const alloc = (paymentId: string, chargeId: string, cents: number) =>
  `INSERT INTO "PaymentAllocation" ("paymentId","revenueEventId","amountCents") VALUES ('${paymentId}','${chargeId}',${cents})`;

describe('append-only: every money table refuses UPDATE, DELETE and TRUNCATE', () => {
  it('Payment, PaymentAllocation, PaymentReversal, Refund, AccountCreditEntry, CheckoutBatch, IdempotencyRecord, PreTrackingSettlement', async () => {
    const fd = await frontDeskLogin();
    const credited = await checkedOut(fd, { payment: 7000, overpayment: 'ACCOUNT_CREDIT' });
    const refunded = await checkedOut(fd, { payment: 7000, overpayment: 'REFUND' });
    await post(fd, `/api/fd/patients/${credited.p.id}/payments/${credited.body.payment.id}/reverse`, { idempotencyKey: key(), expectedVersion: await ledgerVersion(fd, credited.p.id), reason: 'DUPLICATE' });
    await basePrisma.preTrackingSettlement.create({ data: { revenueEventId: (await checkedOut(fd)).charge.id } });

    const tables: Array<[string, string]> = [
      ['Payment', `"id" = '${credited.body.payment.id}'`], ['PaymentAllocation', `"paymentId" = '${refunded.body.payment.id}'`],
      ['PaymentReversal', `"paymentId" = '${credited.body.payment.id}'`], ['Refund', `"paymentId" = '${refunded.body.payment.id}'`],
      ['AccountCreditEntry', `"patientId" = '${credited.p.id}'`], ['CheckoutBatch', `"patientId" = '${credited.p.id}'`],
      ['IdempotencyRecord', `"patientId" = '${credited.p.id}'`], ['PreTrackingSettlement', 'true'],
    ];
    // a column each table really has, for a no-op UPDATE the trigger must still refuse
    const COLUMN: Record<string, string> = {
      Payment: 'note', PaymentAllocation: 'amountCents', PaymentReversal: 'note', Refund: 'note', AccountCreditEntry: 'deltaCents',
      CheckoutBatch: 'createdById', IdempotencyRecord: 'scope', PreTrackingSettlement: 'settledAt',
    };
    for (const [t, where] of tables) {
      expect(Number(await basePrisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}" WHERE ${where}`).then((r) => r[0]!.n)), `${t} has a row`).toBeGreaterThan(0);
      await expect(exec(`UPDATE "${t}" SET "${COLUMN[t]}" = "${COLUMN[t]}" WHERE ${where}`), `${t} UPDATE`).rejects.toThrow(/append-only/);
      await expect(exec(`DELETE FROM "${t}" WHERE ${where}`), `${t} DELETE`).rejects.toThrow(/append-only/);
      await expect(exec(`TRUNCATE "${t}" CASCADE`), `${t} TRUNCATE`).rejects.toThrow(/append-only/);
    }
  });
});

describe('the money guard, at commit', () => {
  it('refuses a payment that is not fully accounted for', async () => {
    const p = await makePatient();
    expect(await commitError([pay(randomUUID(), p.id, 1000)])).toMatch(/not fully accounted for/);
  });

  it('refuses paying a charge more than it costs — one allocation or several', async () => {
    const fd = await frontDeskLogin();
    const { p, charge } = await checkedOut(fd);
    const a = randomUUID();
    expect(await commitError([pay(a, p.id, 6000), alloc(a, charge.id, 6000)])).toMatch(/paid more than it costs/);
    const b = randomUUID(); const c = randomUUID();
    expect(await commitError([pay(b, p.id, 3000), alloc(b, charge.id, 3000), pay(c, p.id, 3000), alloc(c, charge.id, 3000)])).toMatch(/paid more than it costs/);
    expect(await commitError([pay(b, p.id, 5500), alloc(b, charge.id, 5500)])).toBeNull();          // exactly its net is fine
  });

  it('refuses money for dues, for another patient\'s charge, or for a charge settled before tracking', async () => {
    const fd = await frontDeskLogin();
    const { p, charge } = await checkedOut(fd);
    const other = await makePatient();
    const x = randomUUID();
    expect(await commitError([pay(x, other.id, 100), alloc(x, charge.id, 100)])).toMatch(/cannot be settled/);

    const m = await makeMembership(p.id, 'PREVENT', '2026-10-13');
    const dues = await basePrisma.revenueEvent.create({ data: { patientId: p.id, serviceName: 'Dues', serviceCategory: 'Membership', listPriceCents: 9900, netPriceCents: 9900, paymentType: 'DUES', membershipId: m.id, periodStart: new Date('2026-10-13T00:00:00Z'), billingStatus: 'BILLED', occurredAt: new Date(), recordedById: 'test' } });
    const y = randomUUID();
    expect(await commitError([pay(y, p.id, 100), alloc(y, dues.id, 100)])).toMatch(/cannot be settled/);

    const old = await checkedOut(fd);
    await basePrisma.preTrackingSettlement.create({ data: { revenueEventId: old.charge.id } });
    const z = randomUUID();
    expect(await commitError([pay(z, old.p.id, 100), alloc(z, old.charge.id, 100)])).toMatch(/settled before payments were tracked/);
  });

  it('refuses an allocation from a reversed payment', async () => {
    const fd = await frontDeskLogin();
    const { p, charge, body } = await checkedOut(fd, { payment: 2000 });
    await post(fd, `/api/fd/patients/${p.id}/payments/${body.payment.id}/reverse`, { idempotencyKey: key(), expectedVersion: await ledgerVersion(fd, p.id), reason: 'DUPLICATE' });
    expect(await commitError([alloc(body.payment.id, charge.id, 100)])).toMatch(/reversed payment/);
  });

  it('refuses account credit below zero, and an account-credit refund without its account-credit row', async () => {
    const fd = await frontDeskLogin();
    const { p, charge } = await checkedOut(fd);
    expect(await commitError([`INSERT INTO "AccountCreditEntry" ("patientId","kind","deltaCents","revenueEventId","entryOn","createdById") VALUES ('${p.id}','APPLIED',-100,'${charge.id}','2026-10-13','test')`]))
      .toMatch(/below zero/);
    expect(await commitError([`INSERT INTO "Refund" ("id","patientId","source","tender","amountCents","refundedOn","refundedAt","recordedById") VALUES ('${randomUUID()}','${p.id}','ACCOUNT_CREDIT','CASH',100,'2026-10-13',now(),'test')`]))
      .toMatch(/no matching account credit/);
  });

  it('refuses the wrong shapes: a zero payment, OTHER with no note, an account-credit row of the wrong sign', async () => {
    const p = await makePatient();
    expect(await commitError([pay(randomUUID(), p.id, 0)])).toMatch(/Payment_amount_positive/);
    expect(await commitError([pay(randomUUID(), p.id, 100, 'OTHER')])).toMatch(/Payment_other_has_note/);
    expect(await commitError([`INSERT INTO "AccountCreditEntry" ("patientId","kind","deltaCents","paymentId","entryOn","createdById") VALUES ('${p.id}','OVERPAYMENT',-5,'${randomUUID()}','2026-10-13','test')`])).toMatch(/AccountCreditEntry_shape/);
  });
});

describe('the charge rule (RevenueEvent_consistent)', () => {
  async function base() {
    const v = await visit({ encounter: 'CHECKED_IN' });
    return { encounterId: v.encounter!.id, bookingId: v.booking.id, serviceId: v.service.id, serviceName: 'X', serviceCategory: 'Chiropractic', paymentType: 'CASH' as const, occurredAt: new Date(), recordedById: 'test' };
  }
  it('never a promotion and the tier discount together; net must equal list − every reduction; an adjustment has its reason', async () => {
    const promo = await basePrisma.promotion.create({ data: { name: 'P', kind: 'PERCENT', value: 10, startsOn: new Date('2026-10-01T00:00:00Z'), endsOn: new Date('2026-10-31T00:00:00Z'), createdById: 'test' } });
    await expect(basePrisma.revenueEvent.create({ data: { ...(await base()), listPriceCents: 5500, discountPercent: 10, discountCents: 550, promotionId: promo.id, promotionCents: 550, netPriceCents: 4400 } })).rejects.toThrow(/RevenueEvent_consistent/);
    await expect(basePrisma.revenueEvent.create({ data: { ...(await base()), listPriceCents: 5500, promotionId: promo.id, promotionCents: 550, netPriceCents: 5500 } })).rejects.toThrow(/RevenueEvent_consistent/);
    await expect(basePrisma.revenueEvent.create({ data: { ...(await base()), listPriceCents: 5500, adjustmentCents: 500, netPriceCents: 5000 } })).rejects.toThrow(/RevenueEvent_consistent/);
    await expect(basePrisma.revenueEvent.create({ data: { ...(await base()), listPriceCents: 5500, adjustmentCents: 500, adjustmentReason: 'OTHER', netPriceCents: 5000 } })).rejects.toThrow(/RevenueEvent_consistent/);
    await expect(basePrisma.revenueEvent.create({ data: { ...(await base()), listPriceCents: 5500, promotionId: promo.id, promotionCents: 550, adjustmentCents: 500, adjustmentReason: 'COURTESY', netPriceCents: 4450 } })).resolves.toBeTruthy();
  });
});

describe('promotions are frozen once used, and never deleted', () => {
  it('the database: editable until a charge uses it; then only name and active change; never deleted', async () => {
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const v = await visit({ encounter: 'CHECKED_IN', patientId: p.id, start: slotAt('09:00') });
    await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: 5500 } });
    const promo = await basePrisma.promotion.create({ data: { name: 'Week', kind: 'PERCENT', value: 10, startsOn: new Date('2026-10-01T00:00:00Z'), endsOn: new Date('2026-10-31T00:00:00Z'), createdById: 'test', services: { create: [{ serviceId: v.service.id }] } } });
    await basePrisma.promotion.update({ where: { id: promo.id }, data: { value: 20 } });                 // not used yet: fine
    await post(fd, `/api/fd/patients/${p.id}/checkout`, { idempotencyKey: key(), expectedVersion: await ledgerVersion(fd, p.id), visits: [{ bookingId: v.booking.id, pay: 'MONEY' }] });
    expect((await basePrisma.revenueEvent.findFirstOrThrow({ where: { bookingId: v.booking.id } })).promotionId).toBe(promo.id);

    await expect(basePrisma.promotion.update({ where: { id: promo.id }, data: { value: 30 } })).rejects.toThrow(/frozen/);
    await expect(basePrisma.promotion.update({ where: { id: promo.id }, data: { endsOn: new Date('2026-11-30T00:00:00Z') } })).rejects.toThrow(/frozen/);
    await expect(basePrisma.promotionService.deleteMany({ where: { promotionId: promo.id } })).rejects.toThrow(/frozen/);
    await basePrisma.promotion.update({ where: { id: promo.id }, data: { active: false, name: 'Week (ended)' } });   // still allowed
    await expect(basePrisma.promotion.delete({ where: { id: promo.id } })).rejects.toThrow(/never deleted/);
  });

  it('the admin API: create, list, edit — then 409 on a frozen field once used; audited by field names only; admin only', async () => {
    const admin = await adminLogin();
    const fd = await frontDeskLogin();
    const p = await makePatient();
    const v = await visit({ encounter: 'CHECKED_IN', patientId: p.id, start: slotAt('09:00') });
    await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: 5500 } });
    const make = (body: object) => post(admin, '/api/admin/promotions', body);
    expect((await post(fd, '/api/admin/promotions', {})).status).toBe(403);
    expect((await make({ name: 'Bad', kind: 'PERCENT', value: 101, startsOn: '2026-10-01', endsOn: '2026-10-31', serviceIds: [v.service.id] })).status).toBe(400);
    expect((await make({ name: 'Bad', kind: 'PERCENT', value: 10, startsOn: '2026-10-31', endsOn: '2026-10-01', serviceIds: [v.service.id] })).status).toBe(400);
    expect((await make({ name: 'Bad', kind: 'PERCENT', value: 10, startsOn: '2026-02-30', endsOn: '2026-10-01', serviceIds: [v.service.id] })).status).toBe(400);
    const created = await make({ name: 'Red light week', kind: 'PERCENT', value: 20, startsOn: '2026-10-12', endsOn: '2026-10-18', serviceIds: [v.service.id] });
    expect(created.status).toBe(201);
    const id = created.body.promotion.id;
    expect(created.body.promotion).toMatchObject({ name: 'Red light week', kind: 'PERCENT', value: 20, startsOn: '2026-10-12', endsOn: '2026-10-18', active: true, used: false });
    const patch = (body: object) => admin.agent.patch(`/api/admin/promotions/${id}`).set('x-csrf-token', admin.csrf).send(body);
    expect((await patch({ value: 25 })).body.promotion.value).toBe(25);

    // used at check-out — then frozen
    await post(fd, `/api/fd/patients/${p.id}/checkout`, { idempotencyKey: key(), expectedVersion: await ledgerVersion(fd, p.id), visits: [{ bookingId: v.booking.id, pay: 'MONEY' }] });
    const frozen = await patch({ value: 30 });
    expect([frozen.status, frozen.body.code]).toEqual([409, 'promotion_in_use']);
    expect((await patch({ active: false })).body.promotion).toMatchObject({ active: false, used: true });
    const list = await admin.agent.get('/api/admin/promotions');
    expect(list.body.promotions.find((x: any) => x.id === id)).toMatchObject({ used: true, active: false, value: 25 });
    const audits = await basePrisma.auditLog.findMany({ where: { resourceType: 'promotion', resourceId: id } });
    expect(audits.map((a) => a.action).sort()).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(JSON.stringify(audits.map((a) => a.meta))).not.toMatch(/25|20|30/);
  });
});

describe('charges from before payments were tracked: the migration\'s own statement', () => {
  it('settles every visit charge that exists when it runs — not dues, and not a charge made afterwards', async () => {
    const sql = readFileSync('prisma/migrations/20261023120000_money_layer/migration.sql', 'utf8');
    const stmt = sql.slice(sql.indexOf('INSERT INTO "PreTrackingSettlement"'), sql.indexOf(';', sql.indexOf('INSERT INTO "PreTrackingSettlement"')));
    expect(stmt).toMatch(/SELECT "id" FROM "RevenueEvent" WHERE "paymentType" <> 'DUES'/);
    const fd = await frontDeskLogin();
    const before = await checkedOut(fd);
    const m = await makeMembership(before.p.id, 'RESTORE', '2026-10-13');
    const dues = await basePrisma.revenueEvent.create({ data: { patientId: before.p.id, serviceName: 'Dues', serviceCategory: 'Membership', listPriceCents: 19900, netPriceCents: 19900, paymentType: 'DUES', membershipId: m.id, periodStart: new Date('2026-10-13T00:00:00Z'), billingStatus: 'BILLED', occurredAt: new Date(), recordedById: 'test' } });

    // Run it as the migration would — inside a transaction rolled back afterwards, since it would settle every charge in this schema.
    const seen = await basePrisma.$transaction(async (tx) => {
      await tx.preTrackingSettlement.deleteMany({ where: { revenueEventId: before.charge.id } }).catch(() => undefined);
      await tx.$executeRawUnsafe(`${stmt} AND "id" NOT IN (SELECT "revenueEventId" FROM "PreTrackingSettlement")`);
      const settled = await tx.preTrackingSettlement.findMany({ where: { revenueEventId: { in: [before.charge.id, dues.id] } } });
      const charges = await chargesOf(tx, before.p.id);
      throw Object.assign(new Error('rollback'), { settled, charges });
    }).catch((e: any) => e);
    expect(seen.message).toBe('rollback');
    expect(seen.settled.map((r: any) => r.revenueEventId)).toEqual([before.charge.id]);              // the visit charge — not the dues
    expect(seen.charges.find((c: any) => c.id === before.charge.id)).toMatchObject({ preTracking: true, outstandingCents: 0 });
    // rolled back: today the charge is still owed
    expect((await chargesOf(basePrisma, before.p.id)).find((c) => c.id === before.charge.id)!.outstandingCents).toBe(5500);
  });
});
