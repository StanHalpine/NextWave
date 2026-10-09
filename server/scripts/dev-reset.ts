/**
 * DEV ONLY: delete all booking activity, patients, texts and clinical notes, leaving
 * configuration (services, rooms, staff, shifts) and ACCOUNTS intact.
 *
 *   CONFIRM_DEV_RESET=yes npm run dev:reset
 *
 * Replaces the old POST /api/admin/purge endpoint, which could be triggered over
 * HTTP by anyone holding the shared token. This can only be run by someone with
 * shell access to the machine AND the database credentials, and it refuses to
 * run at all against a production or live deployment:
 *
 *   • NODE_ENV=production                → refuses
 *   • BOOKING_MODE is beta or live       → refuses
 *   • CONFIRM_DEV_RESET=yes not set      → refuses (so a stray `npm run` does nothing)
 *
 * It does NOT touch AuditLog (append-only — the record of this very reset is
 * added to it). There is no undo.
 */

import 'dotenv/config';
import { basePrisma } from '../src/lib/prismaBase.js';

async function main(): Promise<number> {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. This script is for development databases only.');
    return 1;
  }
  const mode = (process.env.BOOKING_MODE ?? 'demo').toLowerCase();
  if (mode === 'beta' || mode === 'live') {
    console.error(`Refusing to run: BOOKING_MODE is "${mode}". Real patient records must never be bulk-deleted from a script.`);
    return 1;
  }
  if (process.env.CONFIRM_DEV_RESET !== 'yes') {
    console.error('Refusing to run: set CONFIRM_DEV_RESET=yes to confirm. There is no undo.');
    return 1;
  }

  const before = {
    messages: await basePrisma.messageLog.count(),
    encounters: await basePrisma.encounter.count(),
    visitNotes: await basePrisma.visitNote.count(),
    bookings: await basePrisma.booking.count(),
    bookingContacts: await basePrisma.user.count(),
    patients: await basePrisma.patient.count(),
    memberships: await basePrisma.membership.count(),
    creditLedgerRows: await basePrisma.creditLedger.count(),
    revenueEvents: await basePrisma.revenueEvent.count(),
  };

  // Order matters: MessageLog, Encounter and VisitNote RESTRICT deletion of their
  // Booking, and amendments reference the note they supersede — break that chain first.
  //
  // The credit tables are APPEND-ONLY (database triggers reject DELETE), which is the point of them
  // — so a development reset has to switch those triggers off for the length of this one
  // transaction (it needs to own the tables, which a dev database does) and back on after. If
  // anything fails the whole transaction rolls back, triggers included.
  const APPEND_ONLY = ['CreditAllocation', 'CreditLedger', 'PerkUsage', 'RevenueEvent'];
  await basePrisma.$transaction(async (tx) => {
    for (const t of APPEND_ONLY) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
    await tx.$executeRawUnsafe('DELETE FROM "CreditAllocation"');
    await tx.$executeRawUnsafe('DELETE FROM "CreditLedger"');
    await tx.$executeRawUnsafe('DELETE FROM "PerkUsage"');
    await tx.$executeRawUnsafe('DELETE FROM "RevenueEvent"');
    for (const t of APPEND_ONLY) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);

    await tx.membership.deleteMany({});
    await tx.smsSuppression.deleteMany({});
    await tx.messageLog.deleteMany({});
    await tx.encounter.deleteMany({});
    await tx.visitNote.updateMany({ data: { amendsId: null } });
    await tx.visitNote.deleteMany({});
    await tx.booking.deleteMany({});
    await tx.patient.deleteMany({});
    await tx.user.deleteMany({});
  });

  // The trail must show that this happened.
  await basePrisma.auditLog.create({
    data: { action: 'DELETE', resourceType: 'dev_reset', actorRoles: 'system:dev-reset', meta: before },
  });

  console.log('Deleted:', before);
  return 0;
}

main()
  .then(async (code) => { await basePrisma.$disconnect(); process.exit(code); })
  .catch(async (err) => {
    console.error('dev-reset failed:', err instanceof Error ? err.constructor.name : typeof err);
    await basePrisma.$disconnect();
    process.exit(1);
  });
