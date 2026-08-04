/**
 * Seed the Resource / Staff / StaffSchedule / Service matrices.
 *
 * Idempotent: every row uses a fixed UUID and `upsert`, so re-running updates
 * in place rather than duplicating. Safe to run against a populated database.
 *
 * PROVENANCE — read before trusting these numbers:
 *
 *   Services      names, categories and the 60/90 hyperbaric split are taken
 *                 from the 14 pages in /services. Durations and buffers are
 *                 ESTIMATES except where a page states one (functional
 *                 medicine consult = 30 min, red light = 10 min, hyperbaric
 *                 = 60/90 min). Confirm the rest with the front desk.
 *
 *   Resources     room names and counts are ESTIMATES. Nobody has given us the
 *                 real room inventory — in particular how many IV chairs and
 *                 red light beds exist, which directly caps daily throughput.
 *
 *   Staff         ALL INVENTED — names, roles and shifts. Replace wholesale
 *                 before this touches production. Shifts are drawn to cover
 *                 the published clinic hours (Mon–Fri 7:00–19:00,
 *                 Sat 8:00–14:00, Sun closed) from contact.html.
 */

import { PrismaClient, StaffRole } from '@prisma/client';

const prisma = new PrismaClient();

/** Fixed UUIDs keep the seed idempotent and make fixtures referenceable. */
const id = (prefix: string, n: number) =>
  `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const R = (n: number) => id('re500u4c', n); // resources
const S = (n: number) => id('5e401ce0', n); // services
const T = (n: number) => id('57aff000', n); // staff

// --------------------------------------------------------------------------
// Resources — physical capacity. `maxCapacity` > 1 means the room genuinely
// runs concurrent patients (the lab draw station has two phlebotomy seats).
// --------------------------------------------------------------------------

const resources = [
  { id: R(1), name: 'Adjusting Room 1', type: 'ADJUSTING_ROOM', maxCapacity: 1 },
  { id: R(2), name: 'Adjusting Room 2', type: 'ADJUSTING_ROOM', maxCapacity: 1 },
  { id: R(3), name: 'X-Ray Suite', type: 'XRAY_SUITE', maxCapacity: 1 },
  { id: R(4), name: 'Consult Room 1', type: 'CONSULT_ROOM', maxCapacity: 1 },
  { id: R(5), name: 'Consult Room 2', type: 'CONSULT_ROOM', maxCapacity: 1 },
  { id: R(6), name: 'Lab Draw Station', type: 'LAB_DRAW', maxCapacity: 2 },
  { id: R(7), name: 'InBody Station', type: 'INBODY_STATION', maxCapacity: 1 },
  { id: R(8), name: 'IV Chair 1', type: 'IV_CHAIR', maxCapacity: 1 },
  { id: R(9), name: 'IV Chair 2', type: 'IV_CHAIR', maxCapacity: 1 },
  { id: R(10), name: 'IV Chair 3', type: 'IV_CHAIR', maxCapacity: 1 },
  { id: R(11), name: 'IV Chair 4', type: 'IV_CHAIR', maxCapacity: 1 },
  { id: R(12), name: 'Shot Room', type: 'SHOT_ROOM', maxCapacity: 1 },
  { id: R(13), name: 'Hyperbaric Chamber', type: 'CHAMBER', maxCapacity: 1 },
  { id: R(14), name: 'Red Light Bed 1', type: 'RED_LIGHT_BED', maxCapacity: 1 },
  { id: R(15), name: 'Red Light Bed 2', type: 'RED_LIGHT_BED', maxCapacity: 1 },
];

// --------------------------------------------------------------------------
// Services — one row per bookable thing. `name` matches the <h1> intent of the
// matching page in /services; hyperbaric is two rows because the site sells it
// as two durations at two prices.
//
// NOTE: the spec's Service model has no price field, so it is not stored
// here. See the handoff notes.
//
// `slug` matches the marketing site's page filename (minus .html) — same
// convention as the `?interest=<slug>` links on the contact form. It is what
// a "Book now" button on a service page uses to deep-link here. The two
// hyperbaric rows deliberately share one slug (one page, two durations); the
// client disambiguates by duration when both match.
// --------------------------------------------------------------------------

const services = [
  // Chiropractic
  { id: S(1), slug: 'manual-adjustment', category: 'Chiropractic', name: 'Manual Adjustment', durationMin: 30, bufferMin: 5, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'ADJUSTING_ROOM' },
  { id: S(2), slug: 'spinal-postural-exam', category: 'Chiropractic', name: 'Spinal & Postural Exam', durationMin: 45, bufferMin: 10, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'ADJUSTING_ROOM' },
  { id: S(3), slug: 'spinal-xrays', category: 'Chiropractic', name: 'Spinal X-Rays', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'XRAY_SUITE' },

  // Functional Medicine
  { id: S(4), slug: 'functional-medicine-consult', category: 'Functional Medicine', name: 'Functional Medicine Consult', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' },
  { id: S(5), slug: 'biomarker-testing', category: 'Functional Medicine', name: 'Biomarker Testing', durationMin: 20, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'LAB_DRAW' },
  { id: S(6), slug: 'hormone-optimization', category: 'Functional Medicine', name: 'Hormone Optimization', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' },
  { id: S(7), slug: 'body-composition', category: 'Functional Medicine', name: 'Body Composition', durationMin: 15, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'INBODY_STATION' },
  { id: S(8), slug: 'supplementation', category: 'Functional Medicine', name: 'Supplementation', durationMin: 20, bufferMin: 5, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' },
  { id: S(9), slug: 'personal-wellness-planning', category: 'Functional Medicine', name: 'Personal Wellness Planning', durationMin: 45, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' },

  // Longevity
  { id: S(10), slug: 'iv-therapy', category: 'Longevity', name: 'IV Therapy', durationMin: 60, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'IV_CHAIR' },
  { id: S(11), slug: 'vitamin-shots', category: 'Longevity', name: 'Vitamin Shots', durationMin: 15, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'SHOT_ROOM' },
  { id: S(12), slug: 'hyperbaric-oxygen-therapy', category: 'Longevity', name: 'Hyperbaric Oxygen Therapy (60 min)', durationMin: 60, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'CHAMBER' },
  { id: S(13), slug: 'hyperbaric-oxygen-therapy', category: 'Longevity', name: 'Hyperbaric Oxygen Therapy (90 min)', durationMin: 90, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'CHAMBER' },
  { id: S(14), slug: 'red-light-therapy', category: 'Longevity', name: 'Red Light Therapy', durationMin: 10, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'RED_LIGHT_BED' },
  { id: S(15), slug: 'peptide-therapy', category: 'Longevity', name: 'Peptide Therapy', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' },
];

// --------------------------------------------------------------------------
// Staff + shifts — ALL PLACEHOLDER DATA. dayOfWeek is 1=Mon … 7=Sun.
// Weekday openers cover 7:00–15:00, closers 11:00–19:00, so the published
// Mon–Fri 7:00–19:00 window always has one of each role on the floor.
// --------------------------------------------------------------------------

const MON_FRI = [1, 2, 3, 4, 5];

const staff: Array<{
  id: string;
  name: string;
  role: StaffRole;
  shifts: Array<{ days: number[]; startTime: string; endTime: string }>;
}> = [
  {
    id: T(1),
    name: 'Dr. Alan Reyes',
    role: StaffRole.CHIROPRACTOR,
    shifts: [{ days: MON_FRI, startTime: '07:00', endTime: '15:00' }],
  },
  {
    id: T(2),
    name: 'Dr. Nina Okafor',
    role: StaffRole.CHIROPRACTOR,
    shifts: [
      { days: MON_FRI, startTime: '11:00', endTime: '19:00' },
      { days: [6], startTime: '08:00', endTime: '14:00' },
    ],
  },
  {
    id: T(3),
    name: 'Priya Raman, NP',
    role: StaffRole.NURSE_PRACTITIONER,
    shifts: [{ days: [1, 2, 3, 4], startTime: '08:00', endTime: '17:00' }],
  },
  {
    id: T(4),
    name: 'Marcus Bell, NP',
    role: StaffRole.NURSE_PRACTITIONER,
    shifts: [
      { days: [2, 3, 4, 5], startTime: '10:00', endTime: '19:00' },
      { days: [6], startTime: '08:00', endTime: '14:00' },
    ],
  },
  {
    id: T(5),
    name: 'Sofia Marin, RN',
    role: StaffRole.REGISTERED_NURSE,
    shifts: [{ days: MON_FRI, startTime: '07:00', endTime: '15:00' }],
  },
  {
    id: T(6),
    name: 'Grace Liu, RN',
    role: StaffRole.REGISTERED_NURSE,
    shifts: [
      { days: MON_FRI, startTime: '11:00', endTime: '19:00' },
      { days: [6], startTime: '08:00', endTime: '14:00' },
    ],
  },
];

async function main() {
  for (const r of resources) {
    await prisma.resource.upsert({ where: { id: r.id }, create: r, update: r });
  }
  console.log(`  resources       ${resources.length}`);

  for (const s of services) {
    await prisma.service.upsert({ where: { id: s.id }, create: s, update: s });
  }
  console.log(`  services        ${services.length}`);

  let shiftCount = 0;
  for (const person of staff) {
    const { shifts, ...row } = person;
    await prisma.staff.upsert({ where: { id: row.id }, create: row, update: row });

    // Shifts have no natural key, so replace the set rather than upserting.
    await prisma.staffSchedule.deleteMany({ where: { staffId: row.id } });
    for (const shift of shifts) {
      for (const dayOfWeek of shift.days) {
        await prisma.staffSchedule.create({
          data: {
            staffId: row.id,
            dayOfWeek,
            startTime: shift.startTime,
            endTime: shift.endTime,
          },
        });
        shiftCount++;
      }
    }
  }
  console.log(`  staff           ${staff.length}`);
  console.log(`  staffSchedules  ${shiftCount}`);
}

main()
  .then(async () => {
    console.log('\nSeed complete.');
    console.log('Staff names/shifts and room counts are placeholders — see the');
    console.log('header comment in prisma/seed.ts before using in production.\n');
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
