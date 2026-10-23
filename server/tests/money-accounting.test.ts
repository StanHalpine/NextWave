import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { makePatient, post } from './phase2.js';
import { adminLogin, frontDeskLogin, visit } from './phase4.js';

/**
 * Accounting → Billed vs collected, and the Review list (Phase 2b, rev 2.2; design §7). The suite's database is shared by every test
 * file, so these use days in March 2034 that nothing else touches, and assert the totals for exactly those days.
 */

afterEach(() => setClockForTests(null));
afterAll(() => setClockForTests(null));

const local = (iso: string) => DateTime.fromISO(iso, { zone: 'America/Chicago' }).toJSDate();
const key = () => `t${randomUUID().replace(/-/g, '')}`;
type S = Awaited<ReturnType<typeof frontDeskLogin>>;
const version = async (s: S, pid: string) => (await s.agent.get(`/api/fd/patients/${pid}/ledger`)).body.money.version as string;

async function visitAt(patientId: string, iso: string, price = 10000, serviceName?: string) {
  const v = await visit({ encounter: 'CHECKED_IN', patientId, start: local(iso) });
  await basePrisma.service.update({ where: { id: v.service.id }, data: { priceCents: price, ...(serviceName ? { name: serviceName } : {}) } });
  return v;
}

describe('Accounting: billed vs collected, by the clinic\'s day', () => {
  it('bills at check-out; collects each payment on the day it was taken in Chicago, and takes reversals and refunds off on THEIR day', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient();

    // Tue 14 Mar 2034, 23:30 Chicago (Wed 04:30 UTC): a $100 visit, paid $120 by card — $20 refunded as cash
    setClockForTests(local('2034-03-14T23:30:00'));
    const a = await visitAt(p.id, '2034-03-14T22:00:00');
    const first = await post(fd, `/api/fd/patients/${p.id}/checkout`, {
      idempotencyKey: key(), expectedVersion: await version(fd, p.id), visits: [{ bookingId: a.booking.id, pay: 'MONEY' }],
      payment: { tender: 'CARD', amountCents: 12000 }, overpayment: { as: 'REFUND', tender: 'CASH' },
    });
    expect(first.status).toBe(200);
    expect(first.body.payment.collectedOn).toBe('2034-03-14');

    // Wed 15 Mar: a $100 visit with a $20 courtesy adjustment, paid $50 in cash; that $50 is then reversed — by an admin on Thursday
    setClockForTests(local('2034-03-15T10:00:00'));
    const b = await visitAt(p.id, '2034-03-15T09:00:00');
    const second = await post(fd, `/api/fd/patients/${p.id}/checkout`, {
      idempotencyKey: key(), expectedVersion: await version(fd, p.id), visits: [{ bookingId: b.booking.id, pay: 'MONEY', adjustment: { cents: 2000, reason: 'COURTESY' } }],
      payment: { tender: 'CASH', amountCents: 5000 }, confirmPartial: true,
    });
    expect(second.status).toBe(200);
    setClockForTests(local('2034-03-16T09:00:00'));
    expect((await post(admin, `/api/fd/patients/${p.id}/payments/${second.body.payment.id}/reverse`, { idempotencyKey: key(), expectedVersion: await version(admin, p.id), reason: 'DECLINED' })).status).toBe(200);

    const r = await admin.agent.get('/api/accounting/collections?from=2034-03-14&to=2034-03-16&group=day');
    expect(r.status).toBe(200);
    const day = (d: string) => r.body.rows.find((x: any) => x.day === d);
    expect(day('2034-03-14')).toMatchObject({ billedCents: 10000, adjustmentCents: 0, collectedCents: 12000 - 2000 });   // the card, less the cash refund the same night
    expect(day('2034-03-15')).toMatchObject({ billedCents: 8000, adjustmentCents: 2000, collectedCents: 5000 });
    expect(day('2034-03-16')).toMatchObject({ billedCents: 0, collectedCents: -5000 });                                  // the reversal, on its own day
    expect(r.body.totals).toMatchObject({ billedCents: 18000, collectedCents: 10000, adjustmentCents: 2000 });
    expect(r.body.summary.outstandingNowCents).toBeGreaterThanOrEqual(8000);
    // and by month
    const m = await admin.agent.get('/api/accounting/collections?from=2034-03-01&to=2034-03-31&group=month');
    expect(m.body.rows).toEqual([expect.objectContaining({ month: '2034-03', billedCents: 18000, collectedCents: 10000 })]);
  });

  it('lists every adjustment, reversal and refund for review — no patient named — admin only, with CSV', async () => {
    const fd = await frontDeskLogin();
    const admin = await adminLogin();
    const p = await makePatient({ firstName: 'Reviewa', lastName: 'Unnamed' });
    setClockForTests(local('2034-03-21T10:00:00'));
    const v = await visitAt(p.id, '2034-03-21T09:00:00', 10000, `Review Service ${randomUUID().slice(0, 6)}`);
    const r = await post(fd, `/api/fd/patients/${p.id}/checkout`, {
      idempotencyKey: key(), expectedVersion: await version(fd, p.id), visits: [{ bookingId: v.booking.id, pay: 'MONEY', adjustment: { cents: 1500, reason: 'PRICE_MATCH' } }],
      payment: { tender: 'CHECK', amountCents: 9000 }, overpayment: { as: 'REFUND' },
    });
    expect(r.status).toBe(200);
    await post(fd, `/api/fd/patients/${p.id}/payments/${r.body.payment.id}/reverse`, { idempotencyKey: key(), expectedVersion: await version(fd, p.id), reason: 'ENTERED_IN_ERROR' }).then((x) => expect(x.body.code).toBe('payment_refunded'));
    const other = await post(fd, `/api/fd/patients/${p.id}/payments`, { idempotencyKey: key(), expectedVersion: await version(fd, p.id), payment: { tender: 'CASH', amountCents: 1000 }, overpayment: { as: 'ACCOUNT_CREDIT' } });
    expect((await post(fd, `/api/fd/patients/${p.id}/payments/${other.body.payment.id}/reverse`, { idempotencyKey: key(), expectedVersion: await version(fd, p.id), reason: 'DUPLICATE' })).status).toBe(200);

    expect((await fd.agent.get('/api/accounting/review?from=2034-03-21&to=2034-03-21')).status).toBe(403);
    const list = await admin.agent.get('/api/accounting/review?from=2034-03-21&to=2034-03-21');
    expect(list.status).toBe(200);
    const mine = list.body.rows.filter((x: any) => [r.body.visits[0].revenueEventId, r.body.payment.refund.id, other.body.payment.id].includes(x.ref));
    expect(mine.map((x: any) => [x.kind, x.amountCents, x.reason, x.tender])).toEqual([
      ['Adjustment', 1500, 'Price match', ''],
      ['Refund of an overpayment', 500, '', 'Check'],
      ['Payment reversal', 1000, 'Duplicate', 'Cash'],
    ]);
    expect(mine[0].service).toMatch(/^Review Service/);
    expect(JSON.stringify(list.body)).not.toMatch(/Reviewa|Unnamed/);

    const csv = await admin.agent.get('/api/accounting/review?from=2034-03-21&to=2034-03-21&format=csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Reference id');
    expect(csv.text).toContain('15.00');
    const audit = await basePrisma.auditLog.findFirst({ where: { resourceType: 'accounting_report', resourceId: 'review', action: 'EXPORT' }, orderBy: { id: 'desc' } });
    expect(audit?.meta).toMatchObject({ view: 'review', from: '2034-03-21', to: '2034-03-21', format: 'csv' });
  });
});
