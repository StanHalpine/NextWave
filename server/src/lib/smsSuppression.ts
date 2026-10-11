/**
 * The do-not-text list.
 *
 * A number that texts STOP (or that the provider reports as opted out) goes on it, keyed by
 * digits. It is checked before EVERY send, whatever else says "consented". Consent evidence that is
 * NEWER than the suppression — a fresh checkbox on a new booking, consent a staff member records —
 * overrides it; older evidence does not. (The messaging provider may still refuse to deliver until
 * the patient texts START; the job turns that refusal back into a suppression.)
 */
import type { Prisma } from '@prisma/client';
import type { Rec } from './staffTx.js';
import { canonicalDigits, phoneVariants } from './phone.js';
import { utcTimestamp } from './sqlTime.js';

type Db = Prisma.TransactionClient;

/** Suppression times for the given numbers (digits). */
export async function loadSuppressions(db: Pick<Db, 'smsSuppression'>, digits: string[]): Promise<Map<string, Date>> {
  const unique = [...new Set(digits.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.smsSuppression.findMany({ where: { phoneDigits: { in: unique } } });
  return new Map(rows.map((r) => [r.phoneDigits, r.suppressedAt]));
}

/** Is there consent for this number that was given AFTER `since`? (Staff-recorded or the widget's checkbox.) */
async function hasConsentNewerThan(tx: Db, phone: string, since: Date): Promise<boolean> {
  const variants = phoneVariants(phone);
  const patients = await tx.patient.count({ where: { phoneDigits: { in: variants }, deletedAt: null, smsOptIn: true, smsOptInAt: { gt: since } } });
  if (patients > 0) return true;
  const rows = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n
    FROM "Booking" b JOIN "User" u ON u.id = b."userId"
    WHERE b."smsConsentAt" > ${utcTimestamp(since)}
      AND regexp_replace(u.phone, '\\D', '', 'g') = ANY(${variants})`;
  return (rows[0]?.n ?? 0) > 0;
}

export interface SuppressResult {
  /** True when this changed the number from "may be texted" to "may not" — the moment to confirm it. */
  changed: boolean;
  patientsOptedOut: number;
}

/**
 * Put a number on the list and turn off the consent of every patient record that has it.
 * Writes its own audit rows through `rec` (ids and field names only; never the number).
 */
export async function suppressNumber(tx: Db, rec: Rec, a: { phone: string; source: 'STOP' | 'PROVIDER'; at: Date }): Promise<SuppressResult> {
  const digits = canonicalDigits(a.phone);
  const existing = await tx.smsSuppression.findUnique({ where: { phoneDigits: digits } });
  const wasTextable = !existing || (await hasConsentNewerThan(tx, a.phone, existing.suppressedAt));

  await tx.smsSuppression.upsert({
    where: { phoneDigits: digits },
    create: { phoneDigits: digits, suppressedAt: a.at, source: a.source },
    update: { suppressedAt: a.at, source: a.source },
  });
  await rec({ action: existing ? 'UPDATE' : 'CREATE', resourceType: 'sms_consent', meta: { to: 'suppressed', source: a.source } });

  const patients = await tx.patient.findMany({ where: { phoneDigits: { in: phoneVariants(a.phone) }, deletedAt: null, smsOptIn: true }, select: { id: true } });
  for (const p of patients) {
    await tx.patient.update({ where: { id: p.id }, data: { smsOptIn: false } });
    await rec({ action: 'UPDATE', resourceType: 'patient', resourceId: p.id, meta: { fields: ['smsOptIn'], reason: a.source === 'STOP' ? 'texted_stop' : 'provider_opt_out' } });
  }
  return { changed: wasTextable, patientsOptedOut: patients.length };
}

/** The patient texted START: take the number off the list. Consent on file is unchanged. */
export async function liftSuppression(tx: Db, rec: Rec, phone: string): Promise<boolean> {
  const digits = canonicalDigits(phone);
  const existing = await tx.smsSuppression.findUnique({ where: { phoneDigits: digits } });
  if (!existing) return false;
  await tx.smsSuppression.delete({ where: { phoneDigits: digits } });
  await rec({ action: 'UPDATE', resourceType: 'sms_consent', meta: { to: 'resubscribed' } });
  return true;
}
