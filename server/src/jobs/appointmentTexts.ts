/**
 * Appointment confirmation and 24-hour reminder texts.
 *
 * A job, not a hook: the booking and approval routes are not edited, so nothing
 * "fires" when an appointment is confirmed. Instead this finds CONFIRMED future
 * appointments that have not yet been texted about. That also makes it idempotent
 * for free — run it twice, run it from two processes, kill it half way, and a
 * patient still gets each text once (see "Exactly once" below).
 *
 * ── Who is texted ─────────────────────────────────────────────────────────────
 * Only a LINKED patient (Booking.patientId) who has smsOptIn, with a US number.
 * The anonymous online widget cannot capture consent, so an online booking is
 * texted only after the front desk links it to a patient who has agreed. Nobody
 * else is ever texted; there is no "assume yes".
 *
 * ── What a text says ──────────────────────────────────────────────────────────
 * First name, date, time (integrations/templates.ts enforces it). No service, no
 * provider, no room.
 *
 * ── When ──────────────────────────────────────────────────────────────────────
 * Never outside 08:00–21:00 clinic time; a text that comes due overnight waits for
 * the morning. Never for a walk-in. Never for an appointment that has started or
 * whose patient is already checked in.
 *
 * ── Exactly once ──────────────────────────────────────────────────────────────
 * MessageLog is unique on (bookingId, kind, forStart). Inserting that row IS the
 * claim: of two runners that race, one insert succeeds and the other hits the
 * unique key and stands down. The row is written BEFORE the provider is called and
 * carries a lease (nextAttemptAt in the future); a crash between "claimed" and
 * "recorded sent" means the row is retried after the lease runs out. That is
 * at-least-once for that one crash window — a provider with idempotency keys is the
 * only full fix, and Twilio has none — but it can never be a duplicate in the
 * ordinary case, and it never silently drops a text.
 *
 * `forStart` is the appointment time the text was for. Moving an appointment
 * changes it, so the move gets its own confirmation ("…is confirmed" for the new
 * time) and its own reminder rather than being suppressed by the old time's rows.
 * A queued retry for an old time is cancelled (SKIPPED 'superseded') rather than sent.
 *
 * No text is sent when an appointment is cancelled. A cancellation notice would be a
 * third template and a decision about wording (see PHASE2_NOTES).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { now as clockNow } from '../lib/clock.js';
import { staffTransaction } from '../lib/staffTx.js';
import { clinicHour, formatApptDate, formatApptTime } from '../lib/format.js';
import { loadSuppressions, suppressNumber } from '../lib/smsSuppression.js';
import { SELECT_PATIENT_FOR_TEXT, candidateDigits, resolveRecipient, type Recipient } from '../lib/smsRecipient.js';
import { type TemplateId } from '../integrations/templates.js';
import { toLocalDateISO } from '../lib/time.js';
import { DateTime } from 'luxon';
import { config } from '../config.js';
import { MessagingError, type Messaging } from '../integrations/types.js';

export const QUIET_START_HOUR = 8;   // first hour a text may go out
export const QUIET_END_HOUR = 21;    // texts stop at 21:00
export const MAX_ATTEMPTS = 4;
const LEASE_MS = 10 * 60_000;
const BACKOFF_MS = [5, 15, 60].map((m) => m * 60_000); // after attempt 1, 2, 3
const BATCH = 200;

const TEMPLATE: Record<'CONFIRMATION' | 'REMINDER_24H', TemplateId> = {
  CONFIRMATION: 'appt_confirmation_v2',
  REMINDER_24H: 'appt_reminder_24h_v2',
};

export interface TextRunResult {
  sent: number;
  retryScheduled: number;
  failed: number;
  skipped: number;
  /** Due, but held back (quiet hours) — will be picked up on a later run. */
  deferred: number;
  /** Future appointments whose patient cannot be texted (no consent / no valid number). */
  notEligible: number;
}

export interface TextRunDeps {
  messaging: Messaging;
  now?: Date;
}

export function withinSendingHours(at: Date): boolean {
  const h = clinicHour(at);
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

type Kind = 'CONFIRMATION' | 'REMINDER_24H';

interface Target {
  bookingId: string;
  /** The linked patient, if any — an online booking nobody has linked is still texted when its own checkbox was ticked. */
  patientId: string | null;
  kind: Kind;
  forStart: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** One pass. Safe to call concurrently and repeatedly. */
export async function runAppointmentTexts(deps: TextRunDeps): Promise<TextRunResult> {
  const at = deps.now ?? clockNow();
  const result: TextRunResult = { sent: 0, retryScheduled: 0, failed: 0, skipped: 0, deferred: 0, notEligible: 0 };
  const notEligible = new Set<string>(); // distinct bookings: one seen in both the confirmation and reminder pass counts once

  if (!withinSendingHours(at)) {
    // Count what is waiting so the log shows the job is alive overnight.
    result.deferred = await prisma.messageLog.count({ where: { status: 'QUEUED', nextAttemptAt: { lte: at } } });
    return result;
  }

  // 1. Retries that are due (transient failures and expired leases).
  const due = await prisma.messageLog.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: at } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
  });
  for (const row of due) await retry(row, deps, at, result);

  // 2. Confirmations for appointments nobody has been told about. A booking is texted when EITHER
  //    its linked patient has consented (staff recorded it) OR the person who made it ticked the
  //    widget's checkbox — and the number has not since texted STOP (lib/smsRecipient.ts).
  const upcoming = await prisma.booking.findMany({
    where: {
      status: 'CONFIRMED',
      startTime: { gt: at },
      source: { not: 'WALK_IN' },
      AND: [
        { OR: [{ patientId: { not: null } }, { smsConsentAt: { not: null } }] },
        { OR: [{ encounter: null }, { encounter: { status: 'SCHEDULED' } }] },
      ],
    },
    include: {
      patient: { select: SELECT_PATIENT_FOR_TEXT },
      user: { select: { name: true, phone: true } },
      messages: { select: { kind: true, forStart: true, queuedAt: true } },
    },
    orderBy: { startTime: 'asc' },
    take: BATCH * 5,
  });
  const suppressed = await loadSuppressions(prisma, upcoming.flatMap(candidateDigits));

  for (const b of upcoming) {
    const has = (kind: Kind) => b.messages.some((m) => m.kind === kind && m.forStart.getTime() === b.startTime.getTime());
    if (has('CONFIRMATION')) continue;
    const to = resolveRecipient(b, suppressed);
    if (!to) { notEligible.add(b.id); continue; }
    await deliver({ bookingId: b.id, patientId: b.patientId, kind: 'CONFIRMATION', forStart: b.startTime }, to, deps, at, result);
  }

  // 3. Reminders, for what is now inside the 24-hour window. (A confirmation sent in
  //    this very pass counts: re-read so a booking made at 3 p.m. for tomorrow 10 a.m.
  //    is not texted twice within the hour.)
  const horizon = new Date(at.getTime() + 24 * 3_600_000);
  const tomorrow = DateTime.fromJSDate(at, { zone: config.clinicTimezone }).plus({ days: 1 }).toFormat('yyyy-MM-dd');
  const soon = upcoming.filter((b) => b.startTime <= horizon);
  if (soon.length > 0) {
    const fresh = await prisma.messageLog.findMany({
      where: { bookingId: { in: soon.map((b) => b.id) } },
      select: { bookingId: true, kind: true, forStart: true, queuedAt: true },
    });
    for (const b of soon) {
      const mine = fresh.filter((m) => m.bookingId === b.id && m.forStart.getTime() === b.startTime.getTime());
      if (mine.some((m) => m.kind === 'REMINDER_24H')) continue;
      const to = resolveRecipient(b, suppressed);
      if (!to) { notEligible.add(b.id); continue; }

      const windowOpened = b.startTime.getTime() - 24 * 3_600_000;
      const target: Target = { bookingId: b.id, patientId: b.patientId, kind: 'REMINDER_24H', forStart: b.startTime };
      const confirmation = mine.find((m) => m.kind === 'CONFIRMATION');
      if (toLocalDateISO(b.startTime) !== tomorrow) {
        // The wording says "see you tomorrow". Within 24 hours of an appointment that is TODAY
        // (the job was down overnight, or consent arrived late) that would be false — skip it.
        // Compared by clinic-local calendar date, so a 23- or 25-hour DST day cannot confuse it.
        await recordSkip(target, 'same_day', result);
      } else if (confirmation && confirmation.queuedAt.getTime() >= windowOpened) {
        await recordSkip(target, 'booked_inside_window', result); // they were told less than a day ago
      } else {
        await deliver(target, to, deps, at, result);
      }
    }
  }

  result.notEligible = notEligible.size;
  return result;
}

// ---- one message -------------------------------------------------------------

/** Claim (insert the row), send, record. */
async function deliver(t: Target, to: Recipient, deps: TextRunDeps, at: Date, out: TextRunResult) {
  let id: string;
  try {
    id = await staffTransaction(async (tx, rec) => {
      const row = await tx.messageLog.create({
        data: {
          bookingId: t.bookingId, patientId: t.patientId, kind: t.kind, forStart: t.forStart,
          templateId: TEMPLATE[t.kind], attempts: 1, nextAttemptAt: new Date(at.getTime() + LEASE_MS),
        },
      });
      await rec({ action: 'CREATE', resourceType: 'message', resourceId: row.id, meta: { kind: t.kind, status: 'QUEUED' } });
      return row.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // another runner has it
    throw err;
  }
  await send(id, t, to, 1, deps, at, out);
}

async function retry(row: { id: string; bookingId: string; kind: Kind; forStart: Date; attempts: number; nextAttemptAt: Date | null }, deps: TextRunDeps, at: Date, out: TextRunResult) {
  // Compare-and-swap on (status, attempts): only one runner takes the retry.
  const claimed = await prisma.messageLog.updateMany({
    where: { id: row.id, status: 'QUEUED', attempts: row.attempts, nextAttemptAt: { lte: at } },
    data: { attempts: row.attempts + 1, nextAttemptAt: new Date(at.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return;

  const b = await prisma.booking.findUnique({
    where: { id: row.bookingId },
    include: {
      patient: { select: SELECT_PATIENT_FOR_TEXT },
      user: { select: { name: true, phone: true } },
      encounter: { select: { status: true } },
    },
  });
  const stale = !b || b.status !== 'CONFIRMED' || b.startTime.getTime() !== row.forStart.getTime() || b.startTime <= at
    || (b.encounter && b.encounter.status !== 'SCHEDULED');
  const to = stale ? null : resolveRecipient(b, await loadSuppressions(prisma, candidateDigits(b)));
  if (stale || !to) {
    await finish(row.id, { status: 'SKIPPED', failureCode: stale ? 'superseded' : 'no_consent', nextAttemptAt: null }, out, 'skipped');
    return;
  }
  const t: Target = { bookingId: row.bookingId, patientId: b.patientId, kind: row.kind, forStart: row.forStart };
  await send(row.id, t, to, row.attempts + 1, deps, at, out);
}

async function send(id: string, t: Target, to: Recipient, attempt: number, deps: TextRunDeps, at: Date, out: TextRunResult) {
  // Exactly the placeholders each text uses: renderTemplate() refuses any other.
  const first = to.first;
  const variables: Record<string, string> = t.kind === 'CONFIRMATION'
    ? { first, day: formatApptDate(t.forStart), time: formatApptTime(t.forStart) }
    : { first, time: formatApptTime(t.forStart) };
  try {
    const { providerMessageId } = await deps.messaging.sendSms({ to: to.to, templateId: TEMPLATE[t.kind], variables });
    await finish(id, { status: 'SENT', providerMessageId, sentAt: at, nextAttemptAt: null, failureCode: null }, out, 'sent');
  } catch (err) {
    const failure = err instanceof MessagingError ? err.failure : 'transient';
    if (!(err instanceof MessagingError)) logger.error('sms_send_unexpected_error', err, { messageLogId: id }); // class + sanitised message only
    if (failure === 'transient' && attempt < MAX_ATTEMPTS) {
      const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
      await finish(id, { nextAttemptAt: new Date(at.getTime() + wait), failureCode: 'transient' }, out, 'retry');
    } else {
      await finish(id, { status: 'FAILED', failureCode: failure === 'transient' ? 'transient_exhausted' : failure, nextAttemptAt: null }, out, 'failed');
      if (failure === 'opted_out') await recordOptOut(to, at);
    }
  }
}

type Outcome = 'sent' | 'retry' | 'failed' | 'skipped';

async function finish(id: string, data: Prisma.MessageLogUpdateInput, out: TextRunResult, outcome: Outcome) {
  await staffTransaction(async (tx, rec) => {
    await tx.messageLog.update({ where: { id }, data });
    await rec({ action: 'UPDATE', resourceType: 'message', resourceId: id, meta: { to: data.status ?? 'QUEUED', outcome, fields: Object.keys(data) } });
  });
  if (outcome === 'sent') out.sent++;
  else if (outcome === 'retry') out.retryScheduled++;
  else if (outcome === 'failed') out.failed++;
  else out.skipped++;
}

/** A row that records WHY we did not text, so the same decision is not remade every pass. */
async function recordSkip(t: Target, code: string, out: TextRunResult) {
  try {
    await staffTransaction(async (tx, rec) => {
      const row = await tx.messageLog.create({
        data: { bookingId: t.bookingId, patientId: t.patientId, kind: t.kind, forStart: t.forStart, templateId: TEMPLATE[t.kind], status: 'SKIPPED', failureCode: code },
      });
      await rec({ action: 'CREATE', resourceType: 'message', resourceId: row.id, meta: { kind: t.kind, status: 'SKIPPED', reason: code } });
    });
    out.skipped++;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/** The provider says this number has texted STOP: put it on the do-not-text list and take any patient's consent off. */
async function recordOptOut(to: Recipient, at: Date) {
  await staffTransaction(async (tx, rec) => {
    await suppressNumber(tx, rec, { phone: to.to, source: 'PROVIDER', at });
  });
}
