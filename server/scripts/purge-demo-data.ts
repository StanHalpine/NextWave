/**
 * Delete all booking activity, leaving the Resource / Service / Staff /
 * StaffSchedule configuration intact.
 *
 * Run this ONCE before the booking page goes public. The database currently
 * holds ~20 fabricated patients from development ("Rosa Lindqvist",
 * "Harriet Vance", …). If those are still present when real patients start
 * booking, the front desk queue mixes invented appointments with genuine ones
 * and staff have no way to tell them apart.
 *
 * Deletion order matters: VisitNote → Booking → User, because VisitNote
 * restricts deletion of its Booking and Staff, and Booking references User.
 *
 * Guarded: refuses to run unless CONFIRM_PURGE=yes is set, so it cannot be
 * triggered by a stray `npm run` against production.
 *
 *   CONFIRM_PURGE=yes npx tsx scripts/purge-demo-data.ts
 *
 * There is no undo.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (process.env.CONFIRM_PURGE !== 'yes') {
    console.error('Refusing to run. Set CONFIRM_PURGE=yes if you really mean it.');
    console.error('This permanently deletes every booking, patient and clinical note.');
    process.exit(1);
  }

  const before = {
    notes: await prisma.visitNote.count(),
    bookings: await prisma.booking.count(),
    users: await prisma.user.count(),
  };
  console.log('before:', before);

  // Amendments reference the note they supersede, so clear the chain links
  // before deleting or the self-relation restricts the delete.
  await prisma.visitNote.updateMany({ data: { amendsId: null } });
  await prisma.visitNote.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.user.deleteMany({});

  console.log('after :', {
    notes: await prisma.visitNote.count(),
    bookings: await prisma.booking.count(),
    users: await prisma.user.count(),
  });
  console.log('\nConfiguration left intact:');
  console.log('  services :', await prisma.service.count());
  console.log('  resources:', await prisma.resource.count());
  console.log('  staff    :', await prisma.staff.count());
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
