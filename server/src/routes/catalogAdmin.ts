/**
 * Admin → Catalog (Phase 2c-A, SPEC rev 2.3, decisions 1–3).
 *
 *   GET   /api/admin/catalog                        products, the sales-tax rate, the member discount on products per tier, and the
 *                                                   services that may be offered as add-ons
 *   POST  /api/admin/catalog/products               a new product: name, group, price, taxable, tier-discount eligible, active
 *   PATCH /api/admin/catalog/products/:id           change any of those — the NAME and PRICE included (decision 1)
 *   PUT   /api/admin/catalog/tax-rate               the clinic's sales-tax rate, in thousandths of a percent (5.5% = 5500)
 *   PUT   /api/admin/catalog/product-discounts      the member discount on products, a percent per tier
 *   PATCH /api/admin/catalog/add-ons/:serviceId     offer a service (one that needs no note) as a quick-add, or stop
 *
 * Nothing here can change a past charge: every line snapshots its name, price and tax rate when it is added (charges.ts). Admin only,
 * on an MFA-verified session; every change audited by the names of the fields changed — never a value (no amounts in audit meta).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { basePrisma } from '../lib/prismaBase.js';
import { SALES_TAX_CODE } from '../lib/charges.js';
import { staffTransaction } from '../lib/staffTx.js';
import { requireRole } from '../middleware/session.js';

export const catalogAdminRouter = Router();

/** Prices and tax are money settings: an administrator who has used their authenticator in this session. */
function requireMfaAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.session.mfaVerifiedAt) return res.status(403).json({ error: 'Enter your authenticator code before changing the catalog.', code: 'mfa_required' });
  next();
}
const admin = [requireRole('ADMIN')];
const adminWrite = [requireRole('ADMIN'), requireMfaAdmin];

const name = z.string().trim().min(1, 'Give it a name.').max(80);
const group = z.string().trim().min(1, 'Choose a group.').max(40);
const price = z.number().int().min(0, 'A price is zero or more.').max(10_000_00);
const productFields = {
  name, category: group, priceCents: price, taxable: z.boolean(), tierDiscount: z.boolean(), active: z.boolean(), sortOrder: z.number().int().min(0).max(999),
};
const createProduct = z.object({ ...productFields, taxable: productFields.taxable.optional(), tierDiscount: productFields.tierDiscount.optional(), active: productFields.active.optional(), sortOrder: productFields.sortOrder.optional() }).strict();
const patchProduct = z.object(Object.fromEntries(Object.entries(productFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof productFields]: z.ZodOptional<(typeof productFields)[K]> }).strict();

async function view() {
  const products = await basePrisma.product.findMany({ include: { _count: { select: { charges: true, openCharges: true } } }, orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
  const tax = await basePrisma.taxRate.findUnique({ where: { code: SALES_TAX_CODE } });
  const plans = await basePrisma.membershipPlan.findMany({ include: { productDiscount: true }, orderBy: { sortOrder: 'asc' } });
  const services = await basePrisma.service.findMany({
    where: { OR: [{ offerAsAddOn: true }, { requiresNote: false, priceCents: { not: null } }] },
    select: { id: true, name: true, category: true, priceCents: true, requiresNote: true, offerAsAddOn: true }, orderBy: { name: 'asc' },
  });
  return {
    products: products.map(({ _count, ...p }) => ({ ...p, used: _count.charges + _count.openCharges > 0 })),
    taxRate: { rateMilli: tax?.rateMilli ?? 0 },
    productDiscounts: plans.map((p) => ({ planId: p.id, code: p.code, name: p.name, active: p.active, percent: p.productDiscount?.percent ?? 0 })),
    addOnServices: services,
  };
}

catalogAdminRouter.get('/admin/catalog', ...admin, async (_req, res) => {
  const v = await view();
  audit.read('catalog', null, { products: v.products.length }, 'admin-catalog');
  res.json(v);
});

catalogAdminRouter.post('/admin/catalog/products', ...adminWrite, async (req, res) => {
  const parsed = createProduct.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid product.', code: 'bad_request' });
  const id = await staffTransaction(async (tx, rec) => {
    const p = await tx.product.create({ data: parsed.data });
    await rec({ action: 'CREATE', resourceType: 'product', resourceId: p.id, meta: { fields: Object.keys(parsed.data).sort() } });
    return p.id;
  });
  res.status(201).json({ product: (await view()).products.find((p) => p.id === id) });
});

catalogAdminRouter.patch('/admin/catalog/products/:id', ...adminWrite, async (req, res) => {
  const parsed = patchProduct.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid change.', code: 'bad_request' });
  const id = req.params.id ?? '';
  const out = await staffTransaction(async (tx, rec) => {
    const cur = await tx.product.findUnique({ where: { id } });
    if (!cur) return 404;
    const changed = (Object.keys(parsed.data) as Array<keyof typeof parsed.data>).filter((k) => parsed.data[k] !== undefined && parsed.data[k] !== cur[k]);
    if (changed.length === 0) return 200;
    await tx.product.update({ where: { id }, data: Object.fromEntries(changed.map((k) => [k, parsed.data[k]])) });
    // A rename or re-price changes nothing already added or checked out: those carry their own snapshots.
    await rec({ action: 'UPDATE', resourceType: 'product', resourceId: id, meta: { fields: changed.sort() } });
    return 200;
  });
  if (out === 404) return res.status(404).json({ error: 'Unknown product.', code: 'not_found' });
  res.json({ product: (await view()).products.find((p) => p.id === id) });
});

const taxBody = z.object({ rateMilli: z.number().int().min(0).max(100_000) }).strict();

catalogAdminRouter.put('/admin/catalog/tax-rate', ...adminWrite, async (req, res) => {
  const parsed = taxBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'The rate is in thousandths of a percent, 0 to 100 000 (5.5% = 5500).', code: 'bad_request' });
  await staffTransaction(async (tx, rec) => {
    const row = await tx.taxRate.upsert({
      where: { code: SALES_TAX_CODE },
      create: { code: SALES_TAX_CODE, name: 'Sales tax', rateMilli: parsed.data.rateMilli, updatedById: req.auth!.account.id },
      update: { rateMilli: parsed.data.rateMilli, updatedById: req.auth!.account.id },
    });
    await rec({ action: 'UPDATE', resourceType: 'tax_rate', resourceId: row.id, meta: { fields: ['rateMilli'] } });
  });
  res.json(await view());
});

const discountsBody = z.object({ discounts: z.array(z.object({ planId: z.string().min(1).max(64), percent: z.number().int().min(0).max(100) }).strict()).min(1).max(10) }).strict();

catalogAdminRouter.put('/admin/catalog/product-discounts', ...adminWrite, async (req, res) => {
  const parsed = discountsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'A discount is a whole percent from 0 to 100, per tier.', code: 'bad_request' });
  const ids = [...new Set(parsed.data.discounts.map((d) => d.planId))];
  if (ids.length !== parsed.data.discounts.length) return res.status(400).json({ error: 'A tier is listed twice.', code: 'bad_request' });
  if ((await basePrisma.membershipPlan.count({ where: { id: { in: ids } } })) !== ids.length) return res.status(400).json({ error: 'Unknown tier.', code: 'unknown_plan' });
  await staffTransaction(async (tx, rec) => {
    for (const d of parsed.data.discounts) {
      await tx.planProductDiscount.upsert({
        where: { planId: d.planId }, create: { planId: d.planId, percent: d.percent, updatedById: req.auth!.account.id }, update: { percent: d.percent, updatedById: req.auth!.account.id },
      });
    }
    await rec({ action: 'UPDATE', resourceType: 'product_discount', resourceId: null, meta: { tiers: ids.length } });
  });
  res.json(await view());
});

const addOnBody = z.object({ offerAsAddOn: z.boolean() }).strict();

catalogAdminRouter.patch('/admin/catalog/add-ons/:serviceId', ...adminWrite, async (req, res) => {
  const parsed = addOnBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Say whether to offer it.', code: 'bad_request' });
  const s = await basePrisma.service.findUnique({ where: { id: req.params.serviceId ?? '' }, select: { id: true, name: true, requiresNote: true, priceCents: true } });
  if (!s) return res.status(404).json({ error: 'Unknown service.', code: 'not_found' });
  if (parsed.data.offerAsAddOn && (s.requiresNote || s.priceCents == null)) {
    return res.status(409).json({ error: `${s.name} ${s.requiresNote ? 'needs a signed note, so it is booked as a visit' : 'has no set price'} — it cannot be a quick-add.`, code: 'not_add_on_eligible' });
  }
  await staffTransaction(async (tx, rec) => {
    await tx.service.update({ where: { id: s.id }, data: { offerAsAddOn: parsed.data.offerAsAddOn } });
    await rec({ action: 'UPDATE', resourceType: 'service', resourceId: s.id, meta: { fields: ['offerAsAddOn'] } });
  });
  res.json(await view());
});
