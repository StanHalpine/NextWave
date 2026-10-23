/**
 * The patient LEDGER: one read model of a patient's visits and what they are worth, the same for everyone who asks.
 *
 *   GET /api/fd/patients/:id/ledger   (routes/ledger.ts) — keyed by the patient and nothing else, so the answer is the same from
 *   either of Ben's appointments in the Checked-in column, from the patient directory, and from a second desk screen.
 *
 * READ ONLY, and it posts nothing. No revenue is created by looking at it; there are no payment rows to read (they arrive in a later
 * phase), so there is deliberately NO balance here — a number that implied payments exist would be wrong. What it shows:
 *
 *   today    every confirmed visit of the clinic's current day (America/Chicago), each with where it is and its charge:
 *              • CHECKED OUT  — what was RECORDED at check-out (the RevenueEvent snapshot: list, tier discount, credits, net, how paid)
 *              • not yet      — what check-out WOULD record: the same figures the check-out screen shows (checkoutPreview), so the two
 *                               can never disagree. Cash is shown net of the tier discount; credits are shown as a cost, not as applied.
 *            Every visit the patient is checked in for (CHECKED_IN, IN_PROGRESS or SEEN) is ready to check out, whatever its note
 *            (rev 2.0: billing and documentation are decoupled — the provider may sign after the patient has gone). Each visit
 *            carries its note status instead (NOT_REQUIRED | PENDING | SIGNED, lib/noteStatus.ts), which never gates check-out.
 *   prior    earlier visits (newest first), with the amounts recorded at their check-out, or their state if they were never checked out,
 *            and their note status — a visit checked out last week can still have its note pending
 *   credits  the membership, the spendable balance and what expires soon, and the credits redeemed to date (derived from the ledger)
 *   dues     membership dues billed, as information only — collection is outside the app, so they are NOT a balance
 *
 * Everything is read in ONE repeatable-read transaction: a check-out landing halfway through cannot show a visit as both pending and
 * recorded. Money is integer cents. "Today" is the clinic's calendar day, computed here from the server clock — never the browser's.
 */

import type { Prisma } from '@prisma/client';
import { basePrisma } from './prismaBase.js';
import { APPT_INCLUDE, appointmentView } from './appointmentView.js';
import { checkoutPreview } from './checkout.js';
import { noteStatusOf, type NoteStatus } from './noteStatus.js';
import { balance, clinicDay, expiringSoon, getLots } from './credits.js';
import { openMembership } from './membership.js';
import { localDayBounds } from './time.js';
import { moneyView } from './moneyLedger.js';
import { config } from '../config.js';

/** Where the visit is, for check-out. `ready_to_check_out` is any checked-in visit (CHECKED_IN, IN_PROGRESS, SEEN) — the note does not matter. */
export type VisitState = 'not_arrived' | 'no_show' | 'ready_to_check_out' | 'checked_out';

export interface VisitCharge {
  /** recorded = what check-out wrote down; projected = what check-out would record (paid at the desk); none = no charge (a no-show). */
  basis: 'recorded' | 'projected' | 'none';
  listPriceCents: number | null;
  discountPercent: number;
  discountCents: number;
  /** Recorded: the credits redeemed. Projected: null — nothing is applied until check-out. */
  creditsApplied: number | null;
  /** What this visit costs in credits, when it can be paid with them. */
  creditCost: number | null;
  /** Projected only: whether the patient's balance covers it now. */
  creditsAvailable: boolean | null;
  /** Recorded: what the patient owed in money (0 when the membership covered it). Projected: the cash price after the discount; null when the price is not set yet. */
  netCents: number | null;
  /** False when the service has no set price (the desk types it at check-out). */
  priceKnown: boolean;
  paidWith: 'CASH' | 'CREDITS' | 'PERK' | null;
  recordedAt: string | null;
  /** Rev 2.2: a promotion that applied instead of the tier discount (never both), and a one-off adjustment, with its reason. */
  promotionCents: number;
  promotionName: string | null;
  adjustmentCents: number;
  adjustmentReason: string | null;
}

export interface LedgerVisit {
  id: string;
  /** The appointment as the Front Desk shows it — what the existing check-out screen opens with. */
  appointment: ReturnType<typeof appointmentView>;
  localDate: string;
  localStart: string;
  service: string;
  subOption: string | null;
  provider: string | null;
  state: VisitState;
  /** The visit's note, apart from its state: NOT_REQUIRED | PENDING | SIGNED; null when the patient was never checked in. */
  note: NoteStatus | null;
  charge: VisitCharge;
}

const PRIOR_LIMIT = 100;
const DUES_LIMIT = 24;

const NO_CHARGE: VisitCharge = {
  basis: 'none', listPriceCents: null, discountPercent: 0, discountCents: 0, creditsApplied: null, creditCost: null,
  creditsAvailable: null, netCents: null, priceKnown: false, paidWith: null, recordedAt: null,
  promotionCents: 0, promotionName: null, adjustmentCents: 0, adjustmentReason: null,
};

function stateOf(status: string | undefined): VisitState {
  switch (status) {
    case 'CHECKED_IN': case 'IN_PROGRESS': case 'SEEN': return 'ready_to_check_out';
    case 'CHECKED_OUT': return 'checked_out';
    case 'NO_SHOW': return 'no_show';
    default: return 'not_arrived';
  }
}

type RevenueRow = Prisma.RevenueEventGetPayload<object>;

function recorded(e: RevenueRow): VisitCharge {
  return {
    basis: 'recorded', listPriceCents: e.listPriceCents, discountPercent: e.discountPercent, discountCents: e.discountCents,
    creditsApplied: e.creditsRedeemed, creditCost: e.creditsRedeemed > 0 ? e.creditsRedeemed : null, creditsAvailable: null,
    netCents: e.netPriceCents, priceKnown: e.listPriceCents != null,
    paidWith: e.paymentType === 'CASH' ? 'CASH' : e.memberBenefit === 'PERK' ? 'PERK' : 'CREDITS',
    recordedAt: e.occurredAt.toISOString(),
    promotionCents: e.promotionCents, promotionName: null, adjustmentCents: e.adjustmentCents, adjustmentReason: e.adjustmentReason,
  };
}

export async function patientLedger(patientId: string, now: Date) {
  const today = clinicDay(now);
  const { dayStart, dayEnd } = localDayBounds(today);

  return basePrisma.$transaction(async (tx) => {
    const patient = await tx.patient.findFirst({ where: { id: patientId, deletedAt: null }, select: { id: true, firstName: true, lastName: true, preferredName: true } });
    if (!patient) return null;

    const todayRows = await tx.booking.findMany({
      where: { patientId, status: 'CONFIRMED', startTime: { gte: dayStart, lt: dayEnd } },
      include: APPT_INCLUDE, orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
    });
    const priorRows = await tx.booking.findMany({
      where: { patientId, status: 'CONFIRMED', startTime: { lt: dayStart } },
      include: APPT_INCLUDE, orderBy: [{ startTime: 'desc' }, { id: 'desc' }], take: PRIOR_LIMIT + 1,
    });
    const hasMore = priorRows.length > PRIOR_LIMIT;
    const prior = priorRows.slice(0, PRIOR_LIMIT);

    const encounterIds = [...todayRows, ...prior].map((b) => b.encounter?.id).filter((x): x is string => !!x);
    const events = encounterIds.length ? await tx.revenueEvent.findMany({ where: { encounterId: { in: encounterIds } }, include: { promotion: { select: { name: true } } } }) : [];
    const byEncounter = new Map(events.map((e) => [e.encounterId, e]));

    const visit = async (b: (typeof todayRows)[number], priceUnrecorded: boolean): Promise<LedgerVisit> => {
      const state = stateOf(b.encounter?.status);
      let charge: VisitCharge = NO_CHARGE;
      const ev = b.encounter ? byEncounter.get(b.encounter.id) : undefined;
      if (state === 'checked_out' && ev) {
        charge = { ...recorded(ev), promotionName: ev.promotion?.name ?? null };
      } else if (state !== 'no_show' && state !== 'checked_out' && priceUnrecorded) {
        // The very figures the check-out screen will show for it.
        const pv = await checkoutPreview(tx, b.id, now);
        if (pv) {
          charge = {
            basis: 'projected', listPriceCents: pv.listPriceCents, discountPercent: pv.cash.discountPercent, discountCents: pv.cash.discountCents ?? 0,
            creditsApplied: null, creditCost: pv.creditCost, creditsAvailable: pv.creditCost != null ? pv.credits.available : null,
            netCents: pv.cash.netPriceCents, priceKnown: pv.cash.priceKnown, paidWith: null, recordedAt: null,
            promotionCents: pv.cash.promotion?.cents ?? 0, promotionName: pv.cash.promotion?.name ?? null, adjustmentCents: 0, adjustmentReason: null,
          };
        }
      }
      const v = appointmentView(b);
      return {
        id: b.id, appointment: v, localDate: v.localDate, localStart: v.localStart,
        service: b.service.name, subOption: b.subOption, provider: b.staff?.name ?? null,
        state, note: noteStatusOf(b), charge,
      };
    };

    const todayVisits: LedgerVisit[] = [];
    for (const b of todayRows) todayVisits.push(await visit(b, true));
    // Earlier visits are not re-priced: what was never checked out is shown by its state, with no invented amount.
    const priorVisits: LedgerVisit[] = [];
    for (const b of prior) priorVisits.push(await visit(b, false));

    const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);
    const done = todayVisits.filter((v) => v.state === 'checked_out');
    const pending = todayVisits.filter((v) => v.state !== 'checked_out' && v.state !== 'no_show');

    const membership = await openMembership(tx, patientId);
    const lots = await getLots(tx, patientId, today);
    const soon = expiringSoon(lots, today);
    const redeemed = await tx.creditLedger.aggregate({ where: { patientId, reason: 'REDEMPTION' }, _sum: { delta: true } });

    const dues = await tx.revenueEvent.findMany({
      where: { patientId, paymentType: 'DUES' }, orderBy: [{ periodStart: 'desc' }, { id: 'desc' }], take: DUES_LIMIT,
    });

    return {
      patient: { id: patient.id, name: `${patient.preferredName?.trim() || patient.firstName} ${patient.lastName}` },
      asOf: now.toISOString(),
      today,
      timezone: config.clinicTimezone,
      todayVisits,
      todayTotals: {
        /** What check-out already wrote down for today. */
        recorded: {
          visits: done.length,
          listPriceCents: sum(done.map((v) => v.charge.listPriceCents)),
          discountCents: sum(done.map((v) => v.charge.discountCents)),
          creditsApplied: sum(done.map((v) => v.charge.creditsApplied)),
          netCents: sum(done.map((v) => v.charge.netCents)),
        },
        /** What the rest of today comes to if each is paid at the desk. An estimate: nothing is charged until check-out. */
        pending: {
          visits: pending.length,
          readyToCheckOut: pending.filter((v) => v.state === 'ready_to_check_out').length,
          notArrived: pending.filter((v) => v.state === 'not_arrived').length,
          listPriceCents: sum(pending.map((v) => v.charge.listPriceCents)),
          discountCents: sum(pending.map((v) => v.charge.discountCents)),
          cashNetCents: sum(pending.map((v) => v.charge.netCents)),
          /** Visits whose service has no set price: left out of the sums above, priced at check-out. */
          unpricedVisits: pending.filter((v) => !v.charge.priceKnown).length,
        },
        /** Today's visits whose required note is still unsigned, checked out or not. Information for the desk; it holds nothing up. */
        notesPending: todayVisits.filter((v) => v.note === 'PENDING').length,
      },
      priorVisits,
      priorVisitsMore: hasMore,
      credits: {
        membership: membership ? { planName: membership.plan.name, status: membership.status } : null,
        balance: await balance(tx, patientId, today),
        expiringSoon: soon,
        redeemedToDate: -(redeemed._sum.delta ?? 0),
      },
      dues: dues.map((d) => ({
        id: d.id, periodStart: d.periodStart ? d.periodStart.toISOString().slice(0, 10) : null, description: d.serviceName,
        listPriceCents: d.listPriceCents, billingStatus: d.billingStatus ?? null, recordedAt: d.occurredAt.toISOString(),
      })),
      /** Phase 2b: what has been posted, the balance carried forward, and account credit ($). Read in this same snapshot. */
      money: await moneyView(tx, patientId, today),
    };
  }, { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 20_000 });
}

export type PatientLedger = NonNullable<Awaited<ReturnType<typeof patientLedger>>>;
