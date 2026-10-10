/**
 * Macros: saved text blocks a provider inserts into a note section with one click.
 *
 *   Provider   GET  /api/provider/macros             their own, plus the shared sets offered to their role
 *              POST /api/provider/macros             add one to their own set
 *              PATCH|DELETE /api/provider/macros/:id (their own only)
 *   Admin      GET|POST /api/admin/macro-sets        shared sets (name, which provider roles see it)
 *              PATCH|DELETE /api/admin/macro-sets/:id
 *              POST /api/admin/macro-sets/:id/macros, PATCH|DELETE /api/admin/macros/:id
 *
 * A macro is a template, not patient data, so listing them is not an audited read; every change is
 * audited (who changed which set). Providers are told not to put patient details in one.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { AccountRole, NoteKind } from '@prisma/client';
import { isProviderRole, providerRolesOf } from '../lib/providerRoles.js';
import { prisma } from '../lib/prisma.js';
import { staffTransaction } from '../lib/staffTx.js';
import { requireRole } from '../middleware/session.js';
import { requireClinicalWrite } from '../middleware/clinical.js';

export const macrosRouter = Router();

const MAX_PER_SET = 200;
const SECTION = z.enum(['SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL']);
const title = z.string().trim().min(1, 'A macro needs a title.').max(80);
const body = z.string().refine((s) => s.trim().length > 0, 'A macro cannot be empty.').refine((s) => s.length <= 4000, 'A macro can hold at most 4,000 characters.');
const roles = z.array(z.string().refine(isProviderRole, 'Unknown provider role.')).max(3);

const macroView = (m: { id: string; section: NoteKind; title: string; body: string; sortOrder: number }) =>
  ({ id: m.id, section: m.section, title: m.title, body: m.body, sortOrder: m.sortOrder });
const MACRO_ORDER = [{ section: 'asc' as const }, { sortOrder: 'asc' as const }, { createdAt: 'asc' as const }];

// ---- a provider's own ---------------------------------------------------------------------------------

macrosRouter.get('/provider/macros', ...requireClinicalWrite, async (req, res) => {
  const me = req.auth!.account;
  const mine = await prisma.macroSet.findFirst({ where: { scope: 'PERSONAL', ownerAccountId: me.id }, include: { macros: { orderBy: MACRO_ORDER } } });
  const held = providerRolesOf(me.roles);
  const shared = (await prisma.macroSet.findMany({ where: { scope: 'SHARED', active: true }, orderBy: { name: 'asc' }, include: { macros: { orderBy: MACRO_ORDER } } }))
    .filter((s) => s.roles.length === 0 || s.roles.some((r) => held.includes(r as never)));
  res.json({
    personal: { macros: (mine?.macros ?? []).map(macroView) },
    shared: shared.map((s) => ({ id: s.id, name: s.name, macros: s.macros.map(macroView) })),
  });
});

const newMacro = z.object({ section: SECTION, title, body }).strict();

macrosRouter.post('/provider/macros', ...requireClinicalWrite, async (req, res) => {
  const parsed = newMacro.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid macro.', code: 'bad_request' });
  const me = req.auth!.account;
  const out = await staffTransaction(async (tx, rec) => {
    let set = await tx.macroSet.findFirst({ where: { scope: 'PERSONAL', ownerAccountId: me.id } });
    if (!set) {
      set = await tx.macroSet.create({ data: { scope: 'PERSONAL', name: 'My macros', ownerAccountId: me.id, createdByAccountId: me.id } });
      await rec({ action: 'CREATE', resourceType: 'macro_set', resourceId: set.id, meta: { scope: 'PERSONAL' } });
    }
    if (await tx.macro.count({ where: { setId: set.id } }) >= MAX_PER_SET) return null;
    const last = await tx.macro.aggregate({ where: { setId: set.id, section: parsed.data.section }, _max: { sortOrder: true } });
    const m = await tx.macro.create({ data: { setId: set.id, ...parsed.data, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    await rec({ action: 'CREATE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'PERSONAL', section: m.section } });
    return m;
  });
  if (!out) return res.status(409).json({ error: `You can keep at most ${MAX_PER_SET} macros.`, code: 'too_many' });
  res.status(201).json({ macro: macroView(out) });
});

const patchMacro = z.object({ section: SECTION.optional(), title: title.optional(), body: body.optional() }).strict();

macrosRouter.patch('/provider/macros/:id', ...requireClinicalWrite, async (req, res) => {
  const parsed = patchMacro.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: parsed.success ? 'Nothing to change.' : (parsed.error.issues[0]?.message ?? 'Invalid macro.'), code: 'bad_request' });
  const me = req.auth!.account;
  const out = await staffTransaction(async (tx, rec) => {
    const m = await tx.macro.findFirst({ where: { id: req.params.id ?? '', set: { scope: 'PERSONAL', ownerAccountId: me.id } } });
    if (!m) return null;
    const after = await tx.macro.update({ where: { id: m.id }, data: parsed.data });
    await rec({ action: 'UPDATE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'PERSONAL', fields: Object.keys(parsed.data) } });
    return after;
  });
  if (!out) return res.status(404).json({ error: 'Unknown macro.', code: 'not_found' });
  res.json({ macro: macroView(out) });
});

macrosRouter.delete('/provider/macros/:id', ...requireClinicalWrite, async (req, res) => {
  const me = req.auth!.account;
  const ok = await staffTransaction(async (tx, rec) => {
    const m = await tx.macro.findFirst({ where: { id: req.params.id ?? '', set: { scope: 'PERSONAL', ownerAccountId: me.id } } });
    if (!m) return false;
    await tx.macro.delete({ where: { id: m.id } });
    await rec({ action: 'DELETE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'PERSONAL' } });
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'Unknown macro.', code: 'not_found' });
  res.json({ ok: true });
});

// ---- shared sets (admin) ------------------------------------------------------------------------------

macrosRouter.get('/admin/macro-sets', requireRole('ADMIN'), async (_req, res) => {
  const sets = await prisma.macroSet.findMany({ where: { scope: 'SHARED' }, orderBy: { name: 'asc' }, include: { macros: { orderBy: MACRO_ORDER } } });
  res.json({ sets: sets.map((s) => ({ id: s.id, name: s.name, roles: s.roles, active: s.active, macros: s.macros.map(macroView) })) });
});

const newSet = z.object({ name: z.string().trim().min(1, 'A set needs a name.').max(80), roles: roles.optional() }).strict();

macrosRouter.post('/admin/macro-sets', requireRole('ADMIN'), async (req, res) => {
  const parsed = newSet.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid set.', code: 'bad_request' });
  const set = await staffTransaction(async (tx, rec) => {
    const s = await tx.macroSet.create({ data: { scope: 'SHARED', name: parsed.data.name, roles: (parsed.data.roles ?? []) as AccountRole[], createdByAccountId: req.auth!.account.id } });
    await rec({ action: 'CREATE', resourceType: 'macro_set', resourceId: s.id, meta: { scope: 'SHARED', roles: s.roles } });
    return s;
  });
  res.status(201).json({ set: { id: set.id, name: set.name, roles: set.roles, active: set.active, macros: [] } });
});

const patchSet = z.object({ name: z.string().trim().min(1).max(80).optional(), roles: roles.optional(), active: z.boolean().optional() }).strict();

macrosRouter.patch('/admin/macro-sets/:id', requireRole('ADMIN'), async (req, res) => {
  const parsed = patchSet.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'Nothing valid to change.', code: 'bad_request' });
  const out = await staffTransaction(async (tx, rec) => {
    const s = await tx.macroSet.findFirst({ where: { id: req.params.id ?? '', scope: 'SHARED' } });
    if (!s) return null;
    const after = await tx.macroSet.update({ where: { id: s.id }, data: { ...parsed.data, ...(parsed.data.roles ? { roles: parsed.data.roles as AccountRole[] } : {}) } });
    await rec({ action: 'UPDATE', resourceType: 'macro_set', resourceId: s.id, meta: { scope: 'SHARED', fields: Object.keys(parsed.data) } });
    return after;
  });
  if (!out) return res.status(404).json({ error: 'Unknown set.', code: 'not_found' });
  res.json({ set: { id: out.id, name: out.name, roles: out.roles, active: out.active } });
});

macrosRouter.delete('/admin/macro-sets/:id', requireRole('ADMIN'), async (req, res) => {
  const ok = await staffTransaction(async (tx, rec) => {
    const s = await tx.macroSet.findFirst({ where: { id: req.params.id ?? '', scope: 'SHARED' }, include: { _count: { select: { macros: true } } } });
    if (!s) return false;
    await tx.macroSet.delete({ where: { id: s.id } });        // its macros go with it (cascade)
    await rec({ action: 'DELETE', resourceType: 'macro_set', resourceId: s.id, meta: { scope: 'SHARED', macros: s._count.macros } });
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'Unknown set.', code: 'not_found' });
  res.json({ ok: true });
});

macrosRouter.post('/admin/macro-sets/:id/macros', requireRole('ADMIN'), async (req, res) => {
  const parsed = newMacro.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid macro.', code: 'bad_request' });
  const out = await staffTransaction(async (tx, rec) => {
    const s = await tx.macroSet.findFirst({ where: { id: req.params.id ?? '', scope: 'SHARED' } });
    if (!s) return { status: 404 as const };
    if (await tx.macro.count({ where: { setId: s.id } }) >= MAX_PER_SET) return { status: 409 as const };
    const last = await tx.macro.aggregate({ where: { setId: s.id, section: parsed.data.section }, _max: { sortOrder: true } });
    const m = await tx.macro.create({ data: { setId: s.id, ...parsed.data, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    await rec({ action: 'CREATE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'SHARED', set: s.id, section: m.section } });
    return { status: 201 as const, macro: m };
  });
  if (out.status === 404) return res.status(404).json({ error: 'Unknown set.', code: 'not_found' });
  if (out.status === 409) return res.status(409).json({ error: `A set can hold at most ${MAX_PER_SET} macros.`, code: 'too_many' });
  res.status(201).json({ macro: macroView(out.macro) });
});

macrosRouter.patch('/admin/macros/:id', requireRole('ADMIN'), async (req, res) => {
  const parsed = patchMacro.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return res.status(400).json({ error: 'Nothing valid to change.', code: 'bad_request' });
  const out = await staffTransaction(async (tx, rec) => {
    const m = await tx.macro.findFirst({ where: { id: req.params.id ?? '', set: { scope: 'SHARED' } } });
    if (!m) return null;
    const after = await tx.macro.update({ where: { id: m.id }, data: parsed.data });
    await rec({ action: 'UPDATE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'SHARED', fields: Object.keys(parsed.data) } });
    return after;
  });
  if (!out) return res.status(404).json({ error: 'Unknown macro.', code: 'not_found' });
  res.json({ macro: macroView(out) });
});

macrosRouter.delete('/admin/macros/:id', requireRole('ADMIN'), async (req, res) => {
  const ok = await staffTransaction(async (tx, rec) => {
    const m = await tx.macro.findFirst({ where: { id: req.params.id ?? '', set: { scope: 'SHARED' } } });
    if (!m) return false;
    await tx.macro.delete({ where: { id: m.id } });
    await rec({ action: 'DELETE', resourceType: 'macro', resourceId: m.id, meta: { scope: 'SHARED' } });
    return true;
  });
  if (!ok) return res.status(404).json({ error: 'Unknown macro.', code: 'not_found' });
  res.json({ ok: true });
});
