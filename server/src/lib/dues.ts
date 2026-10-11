/**
 * Membership dues as revenue.
 *
 * When a month's credits are granted (lib/membership.ts grantDue: at enrolment, on resume, and from the monthly job), the same
 * month's dues are BILLED: one RevenueEvent of payment type DUES for the tier's monthly price. Payment collection is outside this
 * system for now, so the only status is BILLED; nothing here takes or records a payment, and a later "paid" would be a new event
 * because RevenueEvent is append-only.
 *
 *  • One event per (membership, period): a second run — or two at once — bills nothing (the unique key, and the membership row lock).
 *  • Dated the first day of the period it covers, in the clinic's calendar, so a job that was down over a month end still puts the
 *    dues in the right month.
 *  • The price is the tier's price AT THE TIME (a snapshot): a later price change rewrites no history, and a plan change takes
 *    effect at the next period, like the credits.
 *  • A tier priced at $0 bills nothing. A paused or cancelled membership is never reached (grantDue only works ACTIVE ones), so a
 *    month missed while paused is not billed, just as its credits are not made up.
 *  • It is not a visit: no encounter, booking or service, and never counted as one by Accounting or Reports.
 */

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { toDateOnly } from './credits.js';
import type { Rec } from './staffTx.js';
import { wallClockToUtc } from './time.js';

type Tx = Prisma.TransactionClient;

export const DUES_LABEL = 'Membership dues';
/** What a dues event carries in the service columns of RevenueEvent (which a visit fills with its service). */
export const DUES_CATEGORY = 'Membership';

export async function billDues(
  tx: Tx, rec: Rec,
  a: { membership: { id: string; patientId: string }; plan: { code: string; priceCents: number }; periodStart: string; actorAccountId: string | null },
): Promise<boolean> {
  if (a.plan.priceCents <= 0) return false;
  const id = randomUUID();
  // ON CONFLICT DO NOTHING: a transaction cannot recover from a unique violation, and a repeat run is expected, not an error.
  const made = await tx.revenueEvent.createMany({
    skipDuplicates: true,
    data: [{
      id, patientId: a.membership.patientId, membershipId: a.membership.id, periodStart: toDateOnly(a.periodStart),
      serviceName: DUES_LABEL, serviceCategory: DUES_CATEGORY, paymentType: 'DUES', billingStatus: 'BILLED',
      listPriceCents: a.plan.priceCents, discountPercent: 0, discountCents: 0, netPriceCents: a.plan.priceCents, creditsRedeemed: 0,
      planCode: a.plan.code, occurredAt: wallClockToUtc(a.periodStart, '00:00'), recordedById: a.actorAccountId ?? 'system:membership-grant',
    }],
  });
  if (made.count !== 1) return false;
  await rec({ action: 'CREATE', resourceType: 'revenue_event', resourceId: id, meta: { paymentType: 'DUES', billingStatus: 'BILLED', period: a.periodStart, plan: a.plan.code, amountCents: a.plan.priceCents } });
  return true;
}
