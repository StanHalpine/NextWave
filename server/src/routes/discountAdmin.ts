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
import { requireRole } from '../middleware/session.js';

export const discountAdminRouter = Router();

/** A readable, stable key from a name: "Spinal X-rays" → SPINAL_X_RAYS. */
export function codeFromName(name: string): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  return /^[A-Z]/.test(base) ? base : `C_${base}`.slice(0, 40);
}

async function view() {
  const [categories, plans, services] = await Promise.all([
    prisma.discountCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], include: { discounts: true, services: { select: { id: true } } } }),
    prisma.membershipPlan.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true } }),
    prisma.service.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, category: true, durationMin: true, discountCategoryId: true, priceCents: true } }),
  ]);
  return {
    categories: categories.map((c) => ({
      id: c.id, code: c.code, name: c.name, active: c.active, sortOrder: c.sortOrder,
      serviceIds: c.services.map((s) => s.id),
      percents: Object.fromEntries(plans.map((p) => [p.id, c.discounts.find((d) => d.planId === p.id)?.percent ?? 0])),
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
  const code = codeFromName(parsed.data.name);
  const out = await staffTransaction(async (tx, rec) => {
    if (await tx.discountCategory.findUnique({ where: { code } })) return null;
    const last = await tx.discountCategory.aggregate({ _max: { sortOrder: true } });
    const c = await tx.discountCategory.create({ data: { code, name: parsed.data.name, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    await rec({ action: 'CREATE', resourceType: 'discount_category', resourceId: c.id, meta: { code } });
    return c;
  });
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
  const { serviceIds, ...scalars } = parsed.data;
  const out = await staffTransaction(async (tx, rec) => {
    const before = await tx.discountCategory.findUnique({ where: { id: req.params.id ?? '' }, include: { services: { select: { id: true } } } });
    if (!before) return { status: 404 as const };
    let moved = 0;
    if (serviceIds) {
      const ids = [...new Set(serviceIds)];
      if (await tx.service.count({ where: { id: { in: ids } } }) !== ids.length) return { status: 400 as const };
      // Leave the services that are no longer listed; take in those that are (from wherever they were).
      await tx.service.updateMany({ where: { discountCategoryId: before.id, id: { notIn: ids } }, data: { discountCategoryId: null } });
      moved = (await tx.service.updateMany({ where: { id: { in: ids }, OR: [{ discountCategoryId: null }, { discountCategoryId: { not: before.id } }] }, data: { discountCategoryId: before.id } })).count;
    }
    if (Object.keys(scalars).length) await tx.discountCategory.update({ where: { id: before.id }, data: scalars });
    const after = await tx.discountCategory.findUniqueOrThrow({ where: { id: before.id }, include: { services: { select: { id: true } } } });
    await rec({
      action: 'UPDATE', resourceType: 'discount_category', resourceId: before.id,
      meta: { fields: Object.keys(parsed.data), from: { name: before.name, active: before.active, services: before.services.length }, to: { name: after.name, active: after.active, services: after.services.length }, taken: moved },
    });
    return { status: 200 as const };
  });
  if (out.status === 404) return res.status(404).json({ error: 'Unknown category.', code: 'not_found' });
  if (out.status === 400) return res.status(400).json({ error: 'Unknown service.', code: 'bad_request' });
  res.json(await view());
});

const discountsBody = z.object({ percents: z.record(z.string().min(1).max(64), z.number().int().min(0, 'A discount cannot be negative.').max(100, 'A discount cannot be over 100%.')) }).strict();

discountAdminRouter.put('/admin/discount-categories/:id/discounts', requireRole('ADMIN'), async (req, res) => {
  const parsed = discountsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid discounts.', code: 'bad_request' });
  const out = await staffTransaction(async (tx, rec) => {
    const cat = await tx.discountCategory.findUnique({ where: { id: req.params.id ?? '' }, include: { discounts: true } });
    if (!cat) return { status: 404 as const };
    const planIds = Object.keys(parsed.data.percents);
    if (await tx.membershipPlan.count({ where: { id: { in: planIds } } }) !== planIds.length) return { status: 400 as const };
    const changes: Record<string, { from: number; to: number }> = {};
    for (const [planId, percent] of Object.entries(parsed.data.percents)) {
      const was = cat.discounts.find((d) => d.planId === planId)?.percent ?? 0;
      if (was === percent) continue;
      changes[planId] = { from: was, to: percent };
      await tx.planCategoryDiscount.upsert({ where: { planId_categoryId: { planId, categoryId: cat.id } }, create: { planId, categoryId: cat.id, percent }, update: { percent } });
    }
    await rec({ action: 'UPDATE', resourceType: 'discount_category', resourceId: cat.id, meta: { fields: ['discounts'], changes } });
    return { status: 200 as const };
  });
  if (out.status === 404) return res.status(404).json({ error: 'Unknown category.', code: 'not_found' });
  if (out.status === 400) return res.status(400).json({ error: 'Unknown tier.', code: 'bad_request' });
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
