/**
 * Admin: the membership tiers as DATA.
 *
 *   GET   /api/admin/membership-plans                       every tier, its perks, and how many members
 *   PATCH /api/admin/membership-plans/:id                   name, dues, credits per month, rollover days, active
 *   PATCH /api/admin/membership-plans/:id/perks/:perkId     label, quantity, active, which services redeem it
 *
 * A change applies from the next grant / the next check-out: credits already granted are never
 * touched (they are append-only rows), and nothing is prorated. Every change is audited with its
 * before and after — configuration, not patient data, so the values are safe to record.
 */

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { staffTransaction } from '../lib/staffTx.js';
import { requireRole } from '../middleware/session.js';

export const membershipAdminRouter = Router();

membershipAdminRouter.get('/admin/membership-plans', requireRole('ADMIN'), async (_req, res) => {
  const plans = await prisma.membershipPlan.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      perks: { orderBy: { sortOrder: 'asc' }, include: { services: { select: { serviceId: true } } } },
      _count: { select: { memberships: { where: { status: { in: ['ACTIVE', 'PAUSED'] } } } } },
    },
  });
  const services = await prisma.service.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: { id: true, name: true, durationMin: true, creditCost: true, priceCents: true } });
  audit.read('membership_plan', null, { scope: 'admin' }, 'membership-plans');
  res.json({
    plans: plans.map((p) => ({
      id: p.id, code: p.code, name: p.name, priceCents: p.priceCents, creditsPerMonth: p.creditsPerMonth, rolloverDays: p.rolloverDays,
      active: p.active, members: p._count.memberships,
      perks: p.perks.map((k) => ({ id: k.id, key: k.key, label: k.label, period: k.period, quantity: k.quantity, active: k.active, serviceIds: k.services.map((s) => s.serviceId) })),
    })),
    services,
  });
});

const planPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  priceCents: z.number().int().min(0).max(1_000_000).optional(),
  creditsPerMonth: z.number().int().min(0).max(100).optional(),
  rolloverDays: z.number().int().min(1).max(730).optional(),
  active: z.boolean().optional(),
}).strict();

membershipAdminRouter.patch('/admin/membership-plans/:id', requireRole('ADMIN'), async (req, res) => {
  const parsed = planPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid plan.', code: 'bad_request' });
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to change.', code: 'bad_request' });

  const out = await staffTransaction(async (tx, rec) => {
    const before = await tx.membershipPlan.findUnique({ where: { id: req.params.id ?? '' } });
    if (!before) return null;
    const after = await tx.membershipPlan.update({ where: { id: before.id }, data: parsed.data });
    const diff = Object.fromEntries(fields.filter((f) => (before as Record<string, unknown>)[f] !== (after as Record<string, unknown>)[f])
      .map((f) => [f, { from: (before as Record<string, unknown>)[f], to: (after as Record<string, unknown>)[f] }]));
    await rec({ action: 'UPDATE', resourceType: 'membership_plan', resourceId: before.id, meta: { fields, changes: diff } });
    return after;
  });
  if (!out) return res.status(404).json({ error: 'Unknown plan.', code: 'not_found' });
  res.json({ plan: out });
});

const perkPatch = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  quantity: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
  serviceIds: z.array(z.string().min(1).max(64)).max(40).optional(),
}).strict();

membershipAdminRouter.patch('/admin/membership-plans/:planId/perks/:perkId', requireRole('ADMIN'), async (req, res) => {
  const parsed = perkPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid perk.', code: 'bad_request' });
  const { serviceIds, ...scalars } = parsed.data;
  const fields = Object.keys(parsed.data);
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to change.', code: 'bad_request' });

  const out = await staffTransaction(async (tx, rec) => {
    const before = await tx.planPerk.findFirst({ where: { id: req.params.perkId ?? '', planId: req.params.planId ?? '' }, include: { services: true } });
    if (!before) return { status: 404 as const };
    if (serviceIds) {
      const found = await tx.service.count({ where: { id: { in: serviceIds } } });
      if (found !== new Set(serviceIds).size) return { status: 400 as const };
    }
    if (Object.keys(scalars).length) await tx.planPerk.update({ where: { id: before.id }, data: scalars });
    if (serviceIds) {
      await tx.planPerkService.deleteMany({ where: { perkId: before.id } });
      await tx.planPerkService.createMany({ data: [...new Set(serviceIds)].map((serviceId) => ({ perkId: before.id, serviceId })) });
    }
    const after = await tx.planPerk.findUniqueOrThrow({ where: { id: before.id }, include: { services: true } });
    await rec({
      action: 'UPDATE', resourceType: 'membership_plan', resourceId: before.planId,
      meta: { perk: before.key, fields, from: { quantity: before.quantity, active: before.active, services: before.services.length }, to: { quantity: after.quantity, active: after.active, services: after.services.length } },
    });
    return { status: 200 as const, perk: { id: after.id, key: after.key, label: after.label, period: after.period, quantity: after.quantity, active: after.active, serviceIds: after.services.map((s) => s.serviceId) } };
  });
  if (out.status === 404) return res.status(404).json({ error: 'Unknown perk.', code: 'not_found' });
  if (out.status === 400) return res.status(400).json({ error: 'Unknown service.', code: 'bad_request' });
  res.json({ perk: out.perk });
});
