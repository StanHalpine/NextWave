/**
 * The operations behind Admin → Memberships → "Member discounts by service category": create a category, say which services are in
 * it, set each tier's percentage. The admin routes (routes/discountAdmin.ts) and the one-time apply script
 * (scripts/apply-discount-table.ts, via lib/discountTable.ts) both call these, so a table entered by the script is entered exactly the
 * way the screen enters it — the same checks, the same transaction, the same audit rows (configuration only: ids, names, percentages).
 *
 * What a discount DOES is in lib/checkout.ts: an ACTIVE member who pays CASH for a service in a category gets the percent their tier
 * has for it, off the list price.
 */

import type { Prisma } from '@prisma/client';
import type { Rec } from './staffTx.js';

type Tx = Prisma.TransactionClient;

/** A readable, stable key from a name: "Spinal X-rays" → SPINAL_X_RAYS. */
/**
 * The "Supplements" category's percentages are not its own (owner's decision at the rev 2.3 review): it reads the member discount on
 * products (PlanProductDiscount, Admin → Product catalog), so supplements — sold as products or as the Supplementation service — are
 * discounted from ONE setting. Its own per-tier rows are retired (migration 20261025110000) and cannot be set here.
 */
export const SUPPLEMENTS_CATEGORY_CODE = 'SUPPLEMENTS';

export function codeFromName(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  return /^[A-Z]/.test(base) ? base : `C_${base}`.slice(0, 40);
}

/** Make a category (the code is derived from the name). Null when one with that code already exists. */
export async function createCategory(tx: Tx, rec: Rec, name: string): Promise<{ id: string; code: string; name: string } | null> {
  const code = codeFromName(name);
  if (await tx.discountCategory.findUnique({ where: { code } })) return null;
  const last = await tx.discountCategory.aggregate({ _max: { sortOrder: true } });
  const c = await tx.discountCategory.create({ data: { code, name, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
  await rec({ action: 'CREATE', resourceType: 'discount_category', resourceId: c.id, meta: { code } });
  return { id: c.id, code: c.code, name: c.name };
}

export interface CategoryPatch {
  name?: string | undefined;
  active?: boolean | undefined;
  sortOrder?: number | undefined;
  /** The COMPLETE set of services in this category. A service moves here from any other category. */
  serviceIds?: string[] | undefined;
}

export async function updateCategory(tx: Tx, rec: Rec, id: string, patch: CategoryPatch): Promise<'ok' | 'not_found' | 'unknown_service'> {
  const { serviceIds, ...scalars } = patch;
  const defined = Object.fromEntries(Object.entries(scalars).filter(([, v]) => v !== undefined));
  const before = await tx.discountCategory.findUnique({ where: { id }, include: { services: { select: { id: true } } } });
  if (!before) return 'not_found';
  let moved = 0;
  if (serviceIds) {
    const ids = [...new Set(serviceIds)];
    if (await tx.service.count({ where: { id: { in: ids } } }) !== ids.length) return 'unknown_service';
    // Leave the services that are no longer listed; take in those that are (from wherever they were).
    await tx.service.updateMany({ where: { discountCategoryId: before.id, id: { notIn: ids } }, data: { discountCategoryId: null } });
    moved = (await tx.service.updateMany({ where: { id: { in: ids }, OR: [{ discountCategoryId: null }, { discountCategoryId: { not: before.id } }] }, data: { discountCategoryId: before.id } })).count;
  }
  if (Object.keys(defined).length) await tx.discountCategory.update({ where: { id: before.id }, data: defined });
  const after = await tx.discountCategory.findUniqueOrThrow({ where: { id: before.id }, include: { services: { select: { id: true } } } });
  await rec({
    action: 'UPDATE', resourceType: 'discount_category', resourceId: before.id,
    meta: { fields: [...Object.keys(defined), ...(serviceIds ? ['serviceIds'] : [])], from: { name: before.name, active: before.active, services: before.services.length }, to: { name: after.name, active: after.active, services: after.services.length }, taken: moved },
  });
  return 'ok';
}

/** Set the percentage each named tier (by plan id) gets in this category. Only changes are written and audited. */
export async function setCategoryDiscounts(tx: Tx, rec: Rec, id: string, percents: Record<string, number>): Promise<'ok' | 'not_found' | 'unknown_tier' | 'set_on_products'> {
  const cat = await tx.discountCategory.findUnique({ where: { id }, include: { discounts: true } });
  if (!cat) return 'not_found';
  if (cat.code === SUPPLEMENTS_CATEGORY_CODE) return 'set_on_products';
  const planIds = Object.keys(percents);
  if (await tx.membershipPlan.count({ where: { id: { in: planIds } } }) !== planIds.length) return 'unknown_tier';
  const changes: Record<string, { from: number; to: number }> = {};
  for (const [planId, percent] of Object.entries(percents)) {
    const was = cat.discounts.find((d) => d.planId === planId)?.percent ?? 0;
    if (was === percent) continue;
    changes[planId] = { from: was, to: percent };
    await tx.planCategoryDiscount.upsert({ where: { planId_categoryId: { planId, categoryId: cat.id } }, create: { planId, categoryId: cat.id, percent }, update: { percent } });
  }
  await rec({ action: 'UPDATE', resourceType: 'discount_category', resourceId: cat.id, meta: { fields: ['discounts'], changes } });
  return 'ok';
}
