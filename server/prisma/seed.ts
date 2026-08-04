/**
 * Seed the Resource / Staff / StaffSchedule / Service matrices.
 *
 * RUNS ONCE, ON AN EMPTY DATABASE ONLY.
 *
 * This executes on every deploy (see render.yaml), so it must not fight the
 * admin screen. Two earlier attempts were not enough:
 *
 *   `update: <row>`  overwrote edits on every deploy.
 *   `update: {}`     stopped overwrites, but `upsert` still RECREATED rows the
 *                    admin had deleted, and shifts were re-added to anyone
 *                    whose roster had been deliberately cleared.
 *
 * Deleting a provider and having them reappear after the next deploy is the
 * same bug wearing a different hat. The only safe rule is: if the practice has
 * configured anything at all, leave the database alone.
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
// `priceCents` / `priceNote` are taken verbatim from each service page. Null
// price means the page shows none, or the price depends on the chosen option
// (see serviceOptions below).
//
// `slug` matches the marketing site's page filename (minus .html) — same
// convention as the `?interest=<slug>` links on the contact form. It is what
// a "Book now" button on a service page uses to deep-link here. The two
// hyperbaric rows deliberately share one slug (one page, two durations); the
// client disambiguates by duration when both match.
// --------------------------------------------------------------------------

const services = [
  // Chiropractic
  { id: S(1), slug: 'manual-adjustment', category: 'Chiropractic', name: 'Manual Adjustment', durationMin: 30, bufferMin: 5, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'ADJUSTING_ROOM' , priceCents: 5500, newPatientSlug: 'spinal-postural-exam' },
  { id: S(2), slug: 'spinal-postural-exam', category: 'Chiropractic', name: 'Spinal & Postural Exam', durationMin: 45, bufferMin: 10, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'ADJUSTING_ROOM' , priceCents: null },
  { id: S(3), slug: 'spinal-xrays', category: 'Chiropractic', name: 'Spinal X-Rays', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.CHIROPRACTOR, resourceType: 'XRAY_SUITE' , priceCents: 25000, priceNote: 'Exam & full spine X-rays' },

  // Functional Medicine
  { id: S(4), slug: 'functional-medicine-consult', category: 'Functional Medicine', name: 'Functional Medicine Consult', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' , priceCents: 15000, priceNote: '30 minute consult — includes InBody body composition measuring' },
  { id: S(5), slug: 'biomarker-testing', category: 'Functional Medicine', name: 'Biomarker Testing', durationMin: 20, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'LAB_DRAW' , priceCents: null, priceNote: 'Price varies by panel' },
  { id: S(6), slug: 'hormone-optimization', category: 'Functional Medicine', name: 'Hormone Optimization', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' , priceCents: 35000, priceNote: 'Walk-in — includes DUTCH testing and 30 minute consult' },
  { id: S(7), slug: 'body-composition', category: 'Functional Medicine', name: 'Body Composition', durationMin: 15, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'INBODY_STATION' , priceCents: 5500, priceNote: 'Walk-in rate' },
  { id: S(8), slug: 'supplementation', category: 'Functional Medicine', name: 'Supplementation', durationMin: 20, bufferMin: 5, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' , priceCents: null },
  { id: S(9), slug: 'personal-wellness-planning', category: 'Functional Medicine', name: 'Personal Wellness Planning', durationMin: 45, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' , priceCents: null },

  // Longevity
  { id: S(10), slug: 'iv-therapy', category: 'Longevity', name: 'IV Therapy', durationMin: 60, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'IV_CHAIR' , priceCents: 18500, priceNote: 'Members save 25%. Two per month included with Optimize.' },
  { id: S(11), slug: 'vitamin-shots', category: 'Longevity', name: 'Vitamin Shots', durationMin: 15, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'SHOT_ROOM' , priceCents: null, priceNote: 'Price varies by shot' },
  { id: S(12), slug: 'hyperbaric-oxygen-therapy', category: 'Longevity', name: 'Hyperbaric Oxygen Therapy (60 min)', durationMin: 60, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'CHAMBER' , priceCents: 11000 },
  { id: S(13), slug: 'hyperbaric-oxygen-therapy', category: 'Longevity', name: 'Hyperbaric Oxygen Therapy (90 min)', durationMin: 90, bufferMin: 15, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'CHAMBER' , priceCents: 16500 },
  { id: S(14), slug: 'red-light-therapy', category: 'Longevity', name: 'Red Light Therapy', durationMin: 10, bufferMin: 5, requiredRole: StaffRole.REGISTERED_NURSE, resourceType: 'RED_LIGHT_BED' , priceCents: 5500, priceNote: 'Full-dose 10 minute session — 3 credits' },
  { id: S(15), slug: 'peptide-therapy', category: 'Longevity', name: 'Peptide Therapy', durationMin: 30, bufferMin: 10, requiredRole: StaffRole.NURSE_PRACTITIONER, resourceType: 'CONSULT_ROOM' , priceCents: null, priceNote: 'Pricing varies by prescription — reviewed with you during your consultation.' },
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

// --------------------------------------------------------------------------
// Service options — the specific shot or panel a patient picks on a card.
// Each carries its own price, which is why these are rows rather than a plain
// string. Storing them also makes Booking.subOption verifiable: the API now
// rejects an option that does not belong to the service.
//
// Prices are read from the cards on vitamin-shots.html / biomarker-testing.html.
// --------------------------------------------------------------------------

const serviceOptions: Array<{ serviceId: string; label: string; priceCents: number; sortOrder: number }> = [
  // Vitamin shots
  { serviceId: S(11), label: 'Vitamin B12',              priceCents: 3500, sortOrder: 1 },
  { serviceId: S(11), label: 'Glutathione',              priceCents: 4500, sortOrder: 2 },
  { serviceId: S(11), label: 'NAD (25 mg)',              priceCents: 4500, sortOrder: 3 },
  { serviceId: S(11), label: 'Vitamin D3 (12,500 IU)',   priceCents: 4500, sortOrder: 4 },
  { serviceId: S(11), label: 'NAD (50 mg)',              priceCents: 5500, sortOrder: 5 },
  { serviceId: S(11), label: 'Vitamin D3 (50,000 IU)',   priceCents: 5500, sortOrder: 6 },

  // Biomarker panels
  { serviceId: S(5), label: 'Baseline',            priceCents: 22500,  sortOrder: 1 },
  { serviceId: S(5), label: 'Food Sensitivity',    priceCents: 35000,  sortOrder: 2 },
  { serviceId: S(5), label: 'Total Toxin Testing', priceCents: 90000,  sortOrder: 3 },
  { serviceId: S(5), label: 'Gut Health',          priceCents: 90000,  sortOrder: 4 },
  { serviceId: S(5), label: 'Galleri Cancer Test', priceCents: 105000, sortOrder: 5 },
];

async function main() {
  // The presence of ANY service means this database has been set up already —
  // either by a previous seed or by hand. Adding to it from here would undo
  // deletions and resurrect placeholders.
  const alreadyConfigured = await prisma.service.count();
  if (alreadyConfigured > 0) {
    console.log(`  skipped — database already has ${alreadyConfigured} service(s).`);
    console.log('  Seeding only ever populates an empty database, so admin edits');
    console.log('  and deletions survive every deploy. To re-seed from scratch,');
    console.log('  clear the Service table first.');
    return;
  }

  for (const r of resources) {
    // update:{} — never clobber a room the admin screen has edited.
    await prisma.resource.upsert({ where: { id: r.id }, create: r, update: {} });
  }
  console.log(`  resources       ${resources.length}`);

  for (const s of services) {
    await prisma.service.upsert({ where: { id: s.id }, create: s, update: {} });
  }
  console.log(`  services        ${services.length}`);

  for (const o of serviceOptions) {
    await prisma.serviceOption.upsert({
      where: { serviceId_label: { serviceId: o.serviceId, label: o.label } },
      create: o,
      update: {},
    });
  }
  console.log(`  serviceOptions  ${serviceOptions.length}`);

  let shiftCount = 0;
  for (const person of staff) {
    const { shifts, ...row } = person;
    await prisma.staff.upsert({ where: { id: row.id }, create: row, update: {} });

    // Only seed shifts for a member who has none. Replacing the set here
    // would destroy a roster edited through the admin screen on every deploy.
    const existingShifts = await prisma.staffSchedule.count({ where: { staffId: row.id } });
    if (existingShifts > 0) continue;

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
