/**
 * The member-discount table the owner approved (Phase 5 follow-up, 2026-10-11), and the code that enters it.
 *
 * THE RULE: one rate per tier — Prevent 10%, Restore 15%, Optimize 20% (the one tiered rate membership.html publishes: its supplements
 * line) — applied to every category below, X-rays included. Where the published copy says something else (a flat 20% on X-rays, a flat
 * 10% on special services), the tier's rate wins; docs/DISCOUNT_MAPPING.md lists every place membership.html now disagrees.
 *
 * It is applied the way the admin screen applies anything — lib/discountConfig.ts — and only ever ADDS: a category whose code already
 * exists is left exactly as an administrator has it, and a service already in another category is not taken from it. So it is safe to
 * run twice, and it never overwrites an edit. After it runs, Admin → Memberships → "Member discounts by service category" is the
 * place to change anything.
 *
 * Perks are untouched (off). A discount applies only when an ACTIVE member pays CASH; credits and perks are never discounted.
 */

import type { Prisma } from '@prisma/client';
import { createCategory, setCategoryDiscounts, updateCategory, codeFromName } from './discountConfig.js';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;

export const TIER_RATES = { PREVENT: 10, RESTORE: 15, OPTIMIZE: 20 } as const;

export const APPROVED_CATEGORIES: ReadonlyArray<{ name: string; serviceSlugs: readonly string[] }> = [
  { name: 'Spinal X-rays', serviceSlugs: ['spinal-xrays'] },
  { name: 'Supplements', serviceSlugs: ['supplementation'] },
  // No service exists for this yet. It is created now so it is ready — at the tier rate — the day one is put in it.
  { name: 'Special services', serviceSlugs: [] },
];

export interface AppliedCategory {
  name: string;
  code: string;
  outcome: 'created' | 'kept';
  /** Services now in it (by slug). */
  services: string[];
  /** Listed services that were NOT put in it: not found, or already in another category. */
  skipped: string[];
  percents: Record<string, number>;
}

export async function applyApprovedTable(tx: Tx, rec: Rec): Promise<AppliedCategory[]> {
  const plans = await tx.membershipPlan.findMany({ where: { code: { in: Object.keys(TIER_RATES) } }, select: { id: true, code: true } });
  if (plans.length !== Object.keys(TIER_RATES).length) throw new Error('The Prevent, Restore and Optimize tiers must exist before the discount table can be entered.');
  const percents = Object.fromEntries(plans.map((p) => [p.id, TIER_RATES[p.code as keyof typeof TIER_RATES]]));
  const byCode = Object.fromEntries(plans.map((p) => [p.code, TIER_RATES[p.code as keyof typeof TIER_RATES]]));

  const out: AppliedCategory[] = [];
  for (const spec of APPROVED_CATEGORIES) {
    const made = await createCategory(tx, rec, spec.name);
    if (!made) { out.push({ name: spec.name, code: codeFromName(spec.name), outcome: 'kept', services: [], skipped: [], percents: {} }); continue; }

    const found = spec.serviceSlugs.length ? await tx.service.findMany({ where: { slug: { in: [...spec.serviceSlugs] } }, select: { id: true, slug: true, discountCategoryId: true } }) : [];
    const free = found.filter((s) => s.discountCategoryId === null);
    const skipped = [...spec.serviceSlugs.filter((slug) => !found.some((s) => s.slug === slug)), ...found.filter((s) => s.discountCategoryId !== null).map((s) => s.slug)];
    if (free.length) await updateCategory(tx, rec, made.id, { serviceIds: free.map((s) => s.id) });
    await setCategoryDiscounts(tx, rec, made.id, percents);
    out.push({ name: spec.name, code: made.code, outcome: 'created', services: free.map((s) => s.slug), skipped, percents: byCode });
  }
  return out;
}
