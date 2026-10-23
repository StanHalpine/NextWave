/**
 * Promotions (admin; Phase 2b, rev 2.2; design §2.5).
 *
 *   GET   /api/admin/promotions        every promotion, with its services and whether a charge has used it; the services to pick from
 *   POST  /api/admin/promotions        create one: name, PERCENT (1–100) or FIXED_CENTS (> 0), clinic-local start and end dates (inclusive),
 *                                      the services it covers
 *   PATCH /api/admin/promotions/:id    change it. Once a charge has used it, its kind, value, dates and services are FROZEN (a database
 *                                      trigger backs this up) — deactivate it and create a new one; its name and `active` may still change
 *
 * Check-out applies the best active promotion for a visit's service and CLINIC DATE automatically, when it beats the member's tier
 * discount (never both; lib/moneyMath.ts). Every change is audited by the names of the fields changed — never a value.
 */
import { Router } from 'express';
import { z } from 'zod';
import { basePrisma } from '../lib/prismaBase.js';
import { staffTransaction } from '../lib/staffTx.js';
import { audit } from '../lib/audit.js';
import { toDateOnly, fromDateOnly } from '../lib/credits.js';
import { requireRole } from '../middleware/session.js';

export const promotionsAdminRouter = Router();
const admin = requireRole('ADMIN');

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && toDateOnly(d).toISOString().slice(0, 10) === d, 'Not a real date.');
const fields = {
  name: z.string().trim().min(1, 'Give the promotion a name.').max(80),
  kind: z.enum(['PERCENT', 'FIXED_CENTS']),
  value: z.number().int().min(1),
  startsOn: ISO,
  endsOn: ISO,
  serviceIds: z.array(z.string().min(1).max(64)).min(1, 'Choose at least one service.').max(50),
  active: z.boolean(),
};
const createBody = z.object({ ...fields, active: fields.active.optional() }).strict();
const patchBody = z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof fields]: z.ZodOptional<(typeof fields)[K]> }).strict();

const FROZEN = ['kind', 'value', 'startsOn', 'endsOn', 'serviceIds'] as const;

function shapeProblem(p: { kind: string; value: number; startsOn: string; endsOn: string }): string | null {
  if (p.kind === 'PERCENT' && (p.value < 1 || p.value > 100)) return 'A percentage is from 1 to 100.';
  if (p.endsOn < p.startsOn) return 'The last day is before the first.';
  return null;
}

async function view() {
  const rows = await basePrisma.promotion.findMany({
    include: { services: { include: { service: { select: { id: true, name: true } } } }, _count: { select: { charges: true } } },
    orderBy: [{ startsOn: 'desc' }, { name: 'asc' }],
  });
  return rows.map((p) => ({
    id: p.id, name: p.name, kind: p.kind, value: p.value, startsOn: fromDateOnly(p.startsOn), endsOn: fromDateOnly(p.endsOn), active: p.active,
    services: p.services.map((s) => ({ id: s.service.id, name: s.service.name })).sort((a, b) => a.name.localeCompare(b.name)),
    used: p._count.charges > 0,
  }));
}

promotionsAdminRouter.get('/admin/promotions', admin, async (_req, res) => {
  const services = await basePrisma.service.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  const promotions = await view();
  audit.read('promotion', null, { count: promotions.length }, 'admin-promotions');
  res.json({ promotions, services });
});

promotionsAdminRouter.post('/admin/promotions', admin, async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid promotion.', code: 'bad_request' });
  const b = parsed.data;
  const problem = shapeProblem(b);
  if (problem) return res.status(400).json({ error: problem, code: 'bad_request' });
  const ids = [...new Set(b.serviceIds)];
  if ((await basePrisma.service.count({ where: { id: { in: ids } } })) !== ids.length) return res.status(400).json({ error: 'Unknown service.', code: 'unknown_service' });
  const id = await staffTransaction(async (tx, rec) => {
    const p = await tx.promotion.create({
      data: { name: b.name, kind: b.kind, value: b.value, startsOn: toDateOnly(b.startsOn), endsOn: toDateOnly(b.endsOn), active: b.active ?? true, createdById: req.auth!.account.id,
        services: { create: ids.map((serviceId) => ({ serviceId })) } },
    });
    await rec({ action: 'CREATE', resourceType: 'promotion', resourceId: p.id, meta: { kind: b.kind, services: ids.length } });
    return p.id;
  });
  res.status(201).json({ promotion: (await view()).find((p) => p.id === id) });
});

promotionsAdminRouter.patch('/admin/promotions/:id', admin, async (req, res) => {
  const parsed = patchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid change.', code: 'bad_request' });
  const b = parsed.data;
  const id = req.params.id ?? '';
  const out = await staffTransaction(async (tx, rec) => {
    await tx.$queryRaw`SELECT id FROM "Promotion" WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.promotion.findUnique({ where: { id }, include: { services: true, _count: { select: { charges: true } } } });
    if (!cur) return { status: 404, body: { error: 'Unknown promotion.', code: 'not_found' } };
    const used = cur._count.charges > 0;
    const curServices = cur.services.map((s) => s.serviceId).sort();
    const next = {
      kind: b.kind ?? cur.kind, value: b.value ?? cur.value,
      startsOn: b.startsOn ?? fromDateOnly(cur.startsOn), endsOn: b.endsOn ?? fromDateOnly(cur.endsOn),
      serviceIds: b.serviceIds ? [...new Set(b.serviceIds)].sort() : curServices,
    };
    const changed: string[] = [];
    if (b.name !== undefined && b.name !== cur.name) changed.push('name');
    if (b.active !== undefined && b.active !== cur.active) changed.push('active');
    if (next.kind !== cur.kind) changed.push('kind');
    if (next.value !== cur.value) changed.push('value');
    if (next.startsOn !== fromDateOnly(cur.startsOn)) changed.push('startsOn');
    if (next.endsOn !== fromDateOnly(cur.endsOn)) changed.push('endsOn');
    if (next.serviceIds.join(',') !== curServices.join(',')) changed.push('serviceIds');
    if (used && changed.some((f) => (FROZEN as readonly string[]).includes(f))) {
      return { status: 409, body: { error: 'This promotion has been used at check-out, so its type, amount, dates and services can no longer change. Switch it off and create a new one.', code: 'promotion_in_use' } };
    }
    const problem = shapeProblem(next);
    if (problem) return { status: 400, body: { error: problem, code: 'bad_request' } };
    if (changed.includes('serviceIds') && (await tx.service.count({ where: { id: { in: next.serviceIds } } })) !== next.serviceIds.length) {
      return { status: 400, body: { error: 'Unknown service.', code: 'unknown_service' } };
    }
    if (changed.length === 0) return { status: 200, body: null };
    await tx.promotion.update({
      where: { id },
      data: { name: b.name ?? cur.name, active: b.active ?? cur.active, kind: next.kind, value: next.value, startsOn: toDateOnly(next.startsOn), endsOn: toDateOnly(next.endsOn) },
    });
    if (changed.includes('serviceIds')) {
      await tx.promotionService.deleteMany({ where: { promotionId: id, serviceId: { notIn: next.serviceIds } } });
      for (const serviceId of next.serviceIds) await tx.promotionService.upsert({ where: { promotionId_serviceId: { promotionId: id, serviceId } }, create: { promotionId: id, serviceId }, update: {} });
    }
    await rec({ action: 'UPDATE', resourceType: 'promotion', resourceId: id, meta: { fields: changed } });
    return { status: 200, body: null };
  });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  res.json({ promotion: (await view()).find((p) => p.id === id) });
});
