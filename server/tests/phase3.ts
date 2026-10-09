/** Fixtures for the Phase 3 (credits, memberships, check-out) tests. */
import { prisma } from '../src/lib/prisma.js';
import { basePrisma } from '../src/lib/prismaBase.js';
import { staffTransaction } from '../src/lib/staffTx.js';
import { grantMonthly, toDateOnly, getLots, spendable, addDaysISO } from '../src/lib/credits.js';

export const planByCode = (code: 'PREVENT' | 'RESTORE' | 'OPTIMIZE') => prisma.membershipPlan.findUniqueOrThrow({ where: { code } });

/** A membership created directly (no grant), for tests that control the ledger themselves. */
export async function makeMembership(patientId: string, code: 'PREVENT' | 'RESTORE' | 'OPTIMIZE' = 'PREVENT', startedOn = '2026-10-13', over: { status?: 'ACTIVE' | 'PAUSED' | 'CANCELLED'; nextGrantOn?: string } = {}) {
  const plan = await planByCode(code);
  const acct = await prisma.account.findFirst({ select: { id: true } });
  return prisma.membership.create({
    data: {
      patientId, planId: plan.id, status: over.status ?? 'ACTIVE', startedOn: toDateOnly(startedOn),
      nextGrantOn: toDateOnly(over.nextGrantOn ?? startedOn), createdById: acct?.id ?? 'test',
    },
    include: { plan: true },
  });
}

/** One lot, through the same code path the job uses. */
export async function grantLot(a: { patientId: string; membershipId: string; credits: number; periodStart: string; rolloverDays?: number }) {
  return staffTransaction((tx, rec) => grantMonthly(tx, rec, { ...a, rolloverDays: a.rolloverDays ?? 90 }));
}

/** SUM(delta): the ledger's own total. Equals the spendable balance once expiry has been written down. */
export async function ledgerSum(patientId: string): Promise<number> {
  const r = await basePrisma.creditLedger.aggregate({ where: { patientId }, _sum: { delta: true } });
  return r._sum.delta ?? 0;
}

export const spendableOn = async (patientId: string, today: string) => spendable(await getLots(basePrisma, patientId, today));
export { addDaysISO };

/** A service with a known price and credit cost, and its own room/provider so fixtures never collide. */
export async function creditService(opts: { priceCents?: number | null; creditCost?: number | null } = {}) {
  const { makeClinic } = await import('./phase2.js');
  const clinic = await makeClinic({ rooms: 6, staff: 6 });
  const service = await prisma.service.update({
    where: { id: clinic.service.id },
    data: { priceCents: opts.priceCents === undefined ? 5500 : opts.priceCents, creditCost: opts.creditCost === undefined ? 2 : opts.creditCost },
  });
  return { ...clinic, service };
}

/** A checked-in visit for a patient, ready to check out. Inserted directly: the check-out logic is what is under test. */
let slot = 0;
export async function checkedInVisit(clinic: Awaited<ReturnType<typeof creditService>>, patientId: string | null, over: { subOption?: string } = {}) {
  const i = slot++ % 6;
  const start = new Date(Date.UTC(2031, 0, 7, 15, 0) + Math.floor(slot / 6) * 3_600_000);   // far future; distinct per call
  const user = await prisma.user.create({ data: { name: 'Contact', email: '', phone: '6125550000' } });
  const booking = await prisma.booking.create({
    data: {
      userId: user.id, serviceId: clinic.service.id, resourceId: clinic.rooms[i]!.id, staffId: clinic.staff[i]!.id,
      startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), status: 'CONFIRMED', source: 'FRONT_DESK',
      patientId, subOption: over.subOption ?? null,
    },
  });
  const encounter = await prisma.encounter.create({ data: { bookingId: booking.id, status: 'CHECKED_IN', checkedInAt: new Date() } });
  return { booking, encounter };
}
