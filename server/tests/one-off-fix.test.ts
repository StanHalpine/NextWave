import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basePrisma } from '../src/lib/prismaBase.js';
import { setClockForTests } from '../src/lib/clock.js';
import { post, TUESDAY_1007 } from './phase2.js';
import { frontDeskLogin, visit } from './phase4.js';

/**
 * scripts/one-off/2026-10-12-reopen-unpaid-checkout.sql — run by hand in the Supabase SQL editor, so it is run here, as written, against
 * the suite's schema: what it shows, what it changes, and that it cannot touch anything it should not.
 */

beforeAll(() => setClockForTests(TUESDAY_1007));
afterAll(() => setClockForTests(null));

const FILE = 'scripts/one-off/2026-10-12-reopen-unpaid-checkout.sql';
const PLACEHOLDER = 'PASTE-BOOKING-ID-HERE';
const [LOOK, FIX] = readFileSync(FILE, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);

// The listing is newest-first and capped at 20 for a person reading it; this suite's schema holds hundreds of other files' visits (some dated decades
// ahead), so the cap alone is lifted here — everything else about the statement runs as written.
const look = () => basePrisma.$queryRawUnsafe<Array<{ booking_id: string; status: string; has_payment: boolean }>>(LOOK!.replace('LIMIT 20', 'LIMIT 100000'));
const fix = (bookingId: string) => basePrisma.$executeRawUnsafe(FIX!.replace(PLACEHOLDER, bookingId));
const enc = (bookingId: string) => basePrisma.encounter.findUniqueOrThrow({ where: { bookingId } });
const audits = (encounterId: string) => basePrisma.auditLog.findMany({ where: { resourceType: 'encounter', resourceId: encounterId, actorRoles: 'system:one-off-fix' } });

/** The state the fix is for: CHECKED_OUT with no payment — which the app can no longer produce, so it is written directly. */
async function unpaidCheckout() {
  const v = await visit({ encounter: 'CHECKED_OUT' });
  await basePrisma.encounter.update({ where: { id: v.encounter!.id }, data: { checkedOutAt: new Date(), seenAt: new Date() } });
  return v;
}

describe('the one-off SQL', () => {
  it('has the two statements the instructions describe', () => {
    expect(LOOK).toMatch(/^SELECT/);
    expect(LOOK).toContain('LIMIT 20');
    expect(FIX).toMatch(/^WITH reopened AS/);
    expect(FIX).toContain(PLACEHOLDER);
  });

  it('step 1 lists SEEN visits and unpaid check-outs, and not properly checked-out ones — with ids and service, no names', async () => {
    const unpaid = await unpaidCheckout();
    const seen = await visit({ encounter: 'SEEN' });
    const paid = await visit({ staffRole: 'CHIROPRACTOR', encounter: 'CHECKED_IN' });
    const fd = await frontDeskLogin();
    expect((await post(fd, `/api/fd/appointments/${paid.booking.id}/check-out`, { payment: 'CASH', priceCents: 1000 })).status).toBe(200);

    const rows = await look();
    const byId = new Map(rows.map((r) => [r.booking_id, r]));
    expect(byId.get(unpaid.booking.id)).toMatchObject({ status: 'CHECKED_OUT', has_payment: false });
    expect(byId.get(seen.booking.id)).toMatchObject({ status: 'SEEN', has_payment: false });
    expect(byId.has(paid.booking.id)).toBe(false);
    expect(Object.keys(rows[0]!).sort()).toEqual(['booking_id', 'checkedOutAt', 'has_payment', 'service', 'startTime', 'status']);
  });

  it('step 2 as pasted, with the placeholder untouched, changes nothing', async () => {
    const unpaid = await unpaidCheckout();
    const before = await enc(unpaid.booking.id);
    expect(await basePrisma.$executeRawUnsafe(FIX!)).toBe(0);
    expect(await enc(unpaid.booking.id)).toEqual(before);
    expect(await audits(before.id)).toHaveLength(0);
  });

  it('step 2 puts an unpaid check-out back to SEEN, audits it once, and the visit can then be checked out properly', async () => {
    const v = await unpaidCheckout();
    await fix(v.booking.id);
    const after = await enc(v.booking.id);
    expect(after).toMatchObject({ status: 'SEEN', checkedOutAt: null, checkedOutById: null });
    expect(after.seenAt).not.toBeNull();
    const rows = await audits(after.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'UPDATE', success: true, meta: { to: 'SEEN', fields: ['status', 'checkedOutAt'] } });

    await fix(v.booking.id);                                                   // run twice: still one audit row, still SEEN
    expect(await audits(after.id)).toHaveLength(1);
    expect((await enc(v.booking.id)).status).toBe('SEEN');

    const fd = await frontDeskLogin();
    expect((await post(fd, `/api/fd/appointments/${v.booking.id}/check-out`, { payment: 'CASH', priceCents: 5500 })).status).toBe(200);
    expect((await enc(v.booking.id)).status).toBe('CHECKED_OUT');
    expect(await basePrisma.revenueEvent.count({ where: { encounterId: after.id } })).toBe(1);
  });

  it('step 2 will not touch a visit that was checked out properly, one that is only SEEN, or any other visit', async () => {
    const fd = await frontDeskLogin();
    const paid = await visit({ staffRole: 'CHIROPRACTOR', encounter: 'CHECKED_IN' });
    await post(fd, `/api/fd/appointments/${paid.booking.id}/check-out`, { payment: 'CASH', priceCents: 1000 });
    const seen = await visit({ encounter: 'SEEN' });
    const bystander = await unpaidCheckout();

    await fix(paid.booking.id); await fix(seen.booking.id);
    expect((await enc(paid.booking.id)).status).toBe('CHECKED_OUT');
    expect((await enc(seen.booking.id)).status).toBe('SEEN');
    expect(await audits((await enc(paid.booking.id)).id)).toHaveLength(0);
    expect(await audits((await enc(seen.booking.id)).id)).toHaveLength(0);
    expect((await enc(bystander.booking.id)).status).toBe('CHECKED_OUT');      // named no one: untouched
  });
});
