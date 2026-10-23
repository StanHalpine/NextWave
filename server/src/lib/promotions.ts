/**
 * Promotions (Phase 2b, rev 2.2): which ones a visit qualifies for. An admin creates them (routes/promotionsAdmin.ts); check-out applies
 * the best one automatically when it beats the member's tier discount (lib/moneyMath.ts `betterOf`, decision 1).
 *
 * A promotion applies by THE VISIT'S CLINIC DATE (decision 2) — so a visit on the last day of "Red light week" keeps the week's price
 * when it is checked out the next morning, and a visit the day after does not get it however early it is checked out.
 */
import type { Prisma } from '@prisma/client';
import { toDateOnly } from './credits.js';
import type { PromotionTerms } from './moneyMath.js';

type Read = Pick<Prisma.TransactionClient, 'promotion'>;

export interface ApplicablePromotion extends PromotionTerms { name: string }

/** Active promotions for this service whose inclusive date range contains `visitDate` (a clinic-local YYYY-MM-DD). */
export async function promotionsFor(db: Read, serviceId: string, visitDate: string): Promise<ApplicablePromotion[]> {
  const day = toDateOnly(visitDate);
  const rows = await db.promotion.findMany({
    where: { active: true, startsOn: { lte: day }, endsOn: { gte: day }, services: { some: { serviceId } } },
    select: { id: true, name: true, kind: true, value: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, value: r.value }));
}
