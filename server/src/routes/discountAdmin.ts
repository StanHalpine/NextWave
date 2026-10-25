/**
 * Admin: member discounts as DATA — a percentage per tier per service category.
 *
 *   GET    /api/admin/discount-categories              categories, their services, and each tier's percent; the tiers and services
 *   POST   /api/admin/discount-categories              create a category (name; the code is derived)
 *   PATCH  /api/admin/discount-categories/:id          rename, switch on/off, reorder, and set which services belong to it
 *   PUT    /api/admin/discount-categories/:id/discounts  set the percent for each tier ({ [planId]: 0–100 })
 *   DELETE /api/admin/discount-categories/:id          remove it (its services become uncategorised, its percentages go)
 *
 * What a discount does is in lib/checkout.ts: an ACTIVE member who pays CASH for a service in a category gets the
 * percent their tier has for it, off the LIST price. A service is in at most one category; one in none is never
 * discounted; a category switched off discounts nothing. Nothing exists until an admin creates it. Every change
 * is audited with its before and after — configuration, not patient data.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { staffTransaction } from '../lib/staffTx.js';
import { SUPPLEMENTS_CATEGORY_CODE, createCategory, setCategoryDiscounts, updateCategory } from '../lib/discountConfig.js';
import { requireRole } from '../middleware/session.js';

export const discountAdminRouter = Router();

// Re-exported: tests import it from here.
export { codeFromName } from '../lib/discountConfig.js';

async function view() {
  const [categories, plans, services] = await Promise.all([
    prisma.discountCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { discounts: true, services: { select: { id: true } } } }),
    prisma.membershipPlan.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true } }),
    prisma.service.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, durationMin: true, discountCategoryId: true, priceCents: true } }),
  ]);
  const shared = new Map((await prisma.planProductDiscount.findMany()).map((d) => [d.planId, d.percent]));
  return {
    categories: categories.map((c) => ({
      id: c.id, code: c.code, name: c.name, active: c.active, sortOrder: c.sortOrder,
      serviceIds: c.services.map((s) => s.id),
      // Supplements reads the member discount on products (rev 2.3 review): shown here, edited on Admin → Product catalog.
      percents: Object.fromEntries(plans.map((p) => [p.id, (c.code === SUPPLEMENTS_CATEGORY_CODE ? shared.get(p.id) : c.discounts.find((d) => d.planId === p.id)?.percent) ?? 0])),
      percentsFrom: c.code === SUPPLEMENTS_CATEGORY_CODE ? 'products' : 'category',
    })),
    plans, services,
  };
}

discountAdminRouter.get('/admin/discount-categories', requireRole('ADMIN'), async (_req, res) => {
  audit.read('discount_category', null, { scope: 'admin' }, 'discount-categories');
  res.json(await view());
});

const createBody = z.object({ name: z.string().trim().min(1, 'A category needs a name.').max(80) }).strict();

discountAdminRouter.post('/admin/discount-categories', requireRole('ADMIN'), async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid category.', code: 'bad_request' });
  const out = await staffTransaction((tx, rec) => createCategory(tx, rec, parsed.data.name));
  if (!out) return res.status(409).json({ error: 'A category with that name already exists.', code: 'duplicate' });
  res.status(201).json({ category: { id: out.id, code: out.code, name: out.name } });
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  /** The COMPLETE set of services in this category. A service moves here from any other category. */
  serviceIds: z.array(z.string().min(1).max(64)).max(100).optional(),
}).strict();

discountAdminRouter.patch('/admin/discount-categories/:id', requireRole('ADMIN'), async (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: parsed.success ? 'Nothing to change.' : (parsed.error.issues[0]?.message ?? 'Invalid category.'), code: 'bad_request' });
  const out = await staffTransaction((tx, rec) => updateCategory(tx, rec, req.params.id ?? '', parsed.data));
  if (out === 'not_found') return res.status(404).json({ error: 'Unknown category.', code: 'not_found' });
  if (out === 'unknown_service') return res.status(400).json({ error: 'Unknown service.', code: 'bad_request' });
  res.json(await view());
});

const discountsBody = z.object({ percents: z.record(z.string().min(1).max(64), z.number().int().min(0, 'A discount cannot be negative.').max(100, 'A discount cannot be over 100%.')) }).strict();

discountAdminRouter.put('/admin/discount-categories/:id/discounts', requireRole('ADMIN'), async (req, res) => {
  const parsed = discountsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid discounts.', code: 'bad_request' });
  const out = await staffTransaction((tx, rec) => setCategoryDiscounts(tx, rec, req.params.id ?? '', parsed.data.percents));
  if (out === 'not_found') return res.status(404).json({ error: 'Unknown category.', code: 'not_found' });
  if (out === 'unknown_tier') return res.status(400).json({ error: 'Unknown tier.', code: 'bad_request' });
  if (out === 'set_on_products') return res.status(409).json({ error: 'Supplement discounts are set in one place: Admin → Product catalog, "Member discount on products". This category reads them from there.', code: 'set_on_products' });
  res.json(await view());
});

discountAdminRouter.delete('/admin/discount-categories/:id', requireRole('ADMIN'), async (req, res) => {
  const ok = await staffTransaction(async (tx, rec) => {
    const cat = await tx.discountCategory.findUnique({ where: { id: req.params.id ?? '' }, include: { _count: { select: { services: true, discounts: true } } } });
    if (!cat) return false;
    await tx.discountCategory.delete({ where: { id: cat.id } });           // services become uncategorised (SET NULL); its percentages cascade
    await rec({ action: 'DELETE', resourceType: 'discount_category', resourceId: cat.id, meta: { code: cat.code, services: cat._count.services, discounts: cat._count.discounts } });
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'Unknown category.', code: 'not_found' });
  res.json({ ok: true });
});
