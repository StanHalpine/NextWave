/**
 * The money writes (Phase 2b, rev 2.2) — front desk and admin; docs/MONEY_LAYER_DESIGN.md §5–§6.
 *
 *   POST /api/fd/patients/:id/checkout                         combined check-out of any of the patient's checked-in visits, with an
 *                                                              optional payment (full, partial with confirmation, or more — refund or
 *                                                              account credit, the patient's choice) and account credit applied
 *   POST /api/fd/patients/:id/payments                         a payment on its own (an old balance, or money put on account)
 *   POST /api/fd/patients/:id/payments/:paymentId/reverse      reverse a payment: the desk on its own clinic day, an admin (MFA) after
 *   POST /api/fd/patients/:id/account-credit/refund            admin (MFA): hand a patient's account credit back
 *
 * Every request carries an `idempotencyKey` (one per press of Confirm) and the Ledger `expectedVersion` it was looking at. A retry with
 * the same key and body gets the recorded answer back; the same key with another body is 409. A changed ledger is 409 `ledger_changed`
 * WITH the fresh Ledger, so the screen shows what is true now. Every write is one transaction (lib/money.ts).
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { basePrisma } from '../lib/prismaBase.js';
import { now } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import { patientLedger } from '../lib/ledger.js';
import {
  idempotent, isUniqueViolation, MoneyError, priorAnswer, refundAccountCredit, requestHash, REVERSAL_REASONS, reversePayment, settle, TENDERS, type Actor,
} from '../lib/money.js';
import { requireFrontDesk } from '../middleware/frontDesk.js';
import { sendSchedulingError } from './http.js';

export const moneyRouter = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = z.number().int().min(0).max(100_000_000);
const key = z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9_-]+$/);
const version = z.string().min(3).max(60);
const tender = z.enum(TENDERS);
const paymentBody = z.object({ tender, amountCents: cents, reference: z.string().max(200).nullish(), note: z.string().max(400).nullish() }).strict();
const overpayment = z.union([
  z.object({ as: z.literal('REFUND'), tender: tender.optional(), note: z.string().max(400).nullish() }).strict(),
  z.object({ as: z.literal('ACCOUNT_CREDIT') }).strict(),
]);
const adjustment = z.object({
  cents: z.number().int().min(1).max(100_000_000),
  reason: z.enum(['SERVICE_RECOVERY', 'PRICE_MATCH', 'COURTESY', 'BILLING_ERROR', 'OTHER']),
  note: z.string().max(400).nullish(),
}).strict();
const visit = z.object({
  bookingId: z.string().regex(UUID),
  pay: z.enum(['MONEY', 'CREDITS', 'PERK']),
  perkId: z.string().max(64).optional(),
  priceCents: z.number().int().min(1).max(100_000_000).optional(),
  expectedNetCents: cents.optional(),
  adjustment: adjustment.nullish(),
}).strict();
const settleBody = z.object({
  idempotencyKey: key,
  expectedVersion: version,
  visits: z.array(visit).max(20).default([]),
  applyAccountCreditCents: cents.optional(),
  payment: paymentBody.nullish(),
  confirmPartial: z.boolean().optional(),
  overpayment: overpayment.nullish(),
}).strict();

function actorOf(req: Request): Actor {
  const a = req.auth!;
  return { accountId: a.account.id, mfaAdmin: a.account.roles.includes('ADMIN') && !!a.session.mfaVerifiedAt };
}

/**
 * Run one money write: idempotent, one transaction, and — on a conflict — the fresh Ledger in the answer. If a twin of this very request
 * (same key, same body) committed while this one waited, its recorded answer is returned instead of an error.
 */
async function moneyWrite(req: Request, res: Response, scope: string, patientId: string, idemKey: string, body: unknown, run: Parameters<typeof staffTransaction>[0]) {
  if (!UUID.test(patientId)) return res.status(404).json({ error: 'Unknown patient.', code: 'unknown_patient' });
  const actor = actorOf(req);
  try {
    const out = await staffTransaction((tx, rec) => idempotent(tx, { key: idemKey, scope, patientId, body, actor: actor.accountId }, () => run(tx, rec)));
    return res.json(out.body);
  } catch (err) {
    if (isUniqueViolation(err) || (err instanceof MoneyError && err.status === 409 && err.code !== 'idempotency_key_reused')) {
      const prior = await priorAnswer(basePrisma, idemKey, scope, patientId, requestHash(body)).catch(() => null);
      if (prior) return res.json(prior.body);
    }
    if (err instanceof MoneyError && err.status === 409) {
      // 409 with fresh state: whatever changed, the screen gets the Ledger as it is now.
      const ledger = await patientLedger(patientId, now());
      return res.status(409).json({ error: err.message, code: err.code, ...err.extra, ledger });
    }
    if (sendSchedulingError(res, err)) return;
    throw err;
  }
}

moneyRouter.post('/fd/patients/:id/checkout', requireFrontDesk, async (req, res) => {
  const parsed = settleBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  if (b.visits.length === 0) return res.status(400).json({ error: 'Choose at least one visit to check out.', code: 'no_visits' });
  const patientId = req.params.id ?? '';
  return moneyWrite(req, res, 'checkout', patientId, b.idempotencyKey, b, (tx, rec) => settle(tx, rec, actorOf(req), now(), { patientId, ...b }));
});

moneyRouter.post('/fd/patients/:id/payments', requireFrontDesk, async (req, res) => {
  const parsed = settleBody.omit({ visits: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  const patientId = req.params.id ?? '';
  return moneyWrite(req, res, 'payment', patientId, b.idempotencyKey, b, (tx, rec) => settle(tx, rec, actorOf(req), now(), { patientId, visits: [], ...b }));
});

const reverseBody = z.object({
  idempotencyKey: key, expectedVersion: version, reason: z.enum(REVERSAL_REASONS), note: z.string().max(400).nullish(),
}).strict();

moneyRouter.post('/fd/patients/:id/payments/:paymentId/reverse', requireFrontDesk, async (req, res) => {
  const parsed = reverseBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  const patientId = req.params.id ?? '';
  const paymentId = req.params.paymentId ?? '';
  if (!UUID.test(paymentId)) return res.status(404).json({ error: 'Unknown payment.', code: 'unknown_payment' });
  return moneyWrite(req, res, `reverse:${paymentId}`, patientId, b.idempotencyKey, b, (tx, rec) => reversePayment(tx, rec, actorOf(req), now(), {
    patientId, paymentId, expectedVersion: b.expectedVersion, reason: b.reason, note: b.note, deskMayReverse: true,
  }));
});

const refundBody = z.object({
  idempotencyKey: key, expectedVersion: version, amountCents: z.number().int().min(1).max(100_000_000), tender, note: z.string().max(400).nullish(),
}).strict();

moneyRouter.post('/fd/patients/:id/account-credit/refund', requireFrontDesk, async (req, res) => {
  const parsed = refundBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.', code: 'bad_request' });
  const b = parsed.data;
  const patientId = req.params.id ?? '';
  return moneyWrite(req, res, 'account-credit-refund', patientId, b.idempotencyKey, b, (tx, rec) => refundAccountCredit(tx, rec, actorOf(req), now(), {
    patientId, expectedVersion: b.expectedVersion, amountCents: b.amountCents, tender: b.tender, note: b.note,
  }));
});
