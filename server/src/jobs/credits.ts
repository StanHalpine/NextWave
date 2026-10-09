/**
 * Credit jobs: the monthly grant and the expiry write-down. Both are idempotent, so the five-minute
 * cron can run them over and over, overlap, or be re-run by hand.
 *
 *  • runMembershipGrants — every ACTIVE membership whose next grant date has arrived gets that
 *    month's credits as one new lot. The unique key (membership, period, reason) in the ledger is
 *    what makes a second run — or two at once — grant nothing; SKIP LOCKED stops two runners
 *    queueing on one membership.
 *  • runCreditExpiry — lots past their last day have what is left of them written down as an
 *    EXPIRATION row (oldest first, one row per lot). Credits are already unusable the moment their
 *    day passes; this makes the history say so and brings SUM(delta) back to the balance.
 *
 * "Today" is the clinic-local date, so a grant due on the 1st happens when the clinic's 1st begins,
 * not at UTC midnight.
 */
import { basePrisma } from '../lib/prismaBase.js';
import { now as clockNow } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import { clinicDay, expireLapsed, lockPatient, toDateOnly } from '../lib/credits.js';
import { grantDue } from '../lib/membership.js';

const BATCH = 500;

export interface GrantRunResult { due: number; granted: number }
export interface ExpiryRunResult { patients: number; creditsExpired: number }

export async function runMembershipGrants(deps: { now?: Date } = {}): Promise<GrantRunResult> {
  const today = clinicDay(deps.now ?? clockNow());
  const due = await basePrisma.membership.findMany({
    where: { status: 'ACTIVE', nextGrantOn: { lte: toDateOnly(today) } },
    select: { id: true },
    orderBy: { nextGrantOn: 'asc' },
    take: BATCH,
  });
  let granted = 0;
  for (const m of due) {
    granted += await staffTransaction((tx, rec) => grantDue(tx, rec, m.id, today, { skipLocked: true }));
  }
  return { due: due.length, granted };
}

export async function runCreditExpiry(deps: { now?: Date } = {}): Promise<ExpiryRunResult> {
  const today = clinicDay(deps.now ?? clockNow());
  const patients = await basePrisma.$queryRaw<Array<{ patientId: string }>>`
    SELECT DISTINCT l."patientId"
    FROM "CreditLedger" l
    WHERE l.delta > 0 AND l."lotExpiresOn" < ${today}::date
      AND l.delta > COALESCE((SELECT SUM(a.amount) FROM "CreditAllocation" a WHERE a."lotId" = l.id), 0)
    LIMIT ${BATCH}`;
  let expired = 0;
  for (const p of patients) {
    expired += await staffTransaction(async (tx, rec) => {
      await lockPatient(tx, p.patientId);
      return expireLapsed(tx, rec, p.patientId, today);
    });
  }
  return { patients: patients.length, creditsExpired: expired };
}
