/**
 * Run by scripts/perf-reports.mjs inside a throwaway schema. Loads PERF_ENCOUNTERS (default 50,000) visits spread over
 * the three years to 31 Oct 2026, then times every Accounting and Reports query at three range sizes and prints the plan each one uses.
 * Refuses to run anywhere but a schema called nw_*.
 */
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { basePrisma as db } from '../src/lib/prismaBase.js';
import {
  attendedVisitsSql, demandSql, dimension, memberSplit, revenueSql, revenueTable, serviceDemand, signupsByMonth, signupsSql,
  walkIns, walkInsByDaySql, walkInsByHourSql, weekendSql, weekendVisits, type RevenueFilter,
} from '../src/lib/reports.js';
import type { DateRange } from '../src/lib/reportFormat.js';

const N = Number(process.env.PERF_ENCOUNTERS ?? 50_000);
const exec = (sql: string) => db.$executeRawUnsafe(sql);

async function assertScratch() {
  const rows = await db.$queryRaw<Array<{ s: string }>>`SELECT current_schema() AS s`;
  const s = rows[0]?.s ?? '';
  if (!/^nw_/.test(s)) throw new Error('Refusing to load test data outside a scratch schema (nw_*).');
  return s;
}

async function load() {
  const t0 = performance.now();
  await exec(`INSERT INTO "User" (id, name, email, phone) SELECT gen_random_uuid()::text, 'Perf ' || i, 'perf' || i || '@example.test', '6125550000' FROM generate_series(1, 2000) i`);
  await exec(`INSERT INTO "Patient" (id, "firstName", "lastName", phone, "phoneDigits", "createdById", "updatedAt")
              SELECT gen_random_uuid()::text, 'Perf', 'Patient' || i, '6125550000', '6125550000', 'perf', now() FROM generate_series(1, 5000) i`);
  // 700 memberships over the three years: 70% active, 10% paused, 20% cancelled (one open per patient is a unique index).
  await exec(`INSERT INTO "Membership" (id, "patientId", "planId", status, "startedOn", "nextGrantOn", "createdById", "updatedAt")
              SELECT gen_random_uuid()::text, p.id, (SELECT id FROM "MembershipPlan" ORDER BY "sortOrder" OFFSET (p.n % 3) LIMIT 1),
                     (CASE WHEN p.n % 10 < 7 THEN 'ACTIVE' WHEN p.n % 10 < 8 THEN 'PAUSED' ELSE 'CANCELLED' END)::"MembershipStatus",
                     DATE '2023-11-01' + (p.n * 37 % 1096)::int, DATE '2023-11-01' + (p.n * 37 % 1096)::int, 'perf', now()
              FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM "Patient") p WHERE p.n <= 700`);

  // One staging row per visit. Clinic-local wall times become UTC, as the app stores them.
  await exec(`
    CREATE UNLOGGED TABLE perf_visit AS
    WITH cfg AS (
      SELECT (SELECT array_agg(id ORDER BY id) FROM "Service") AS svc, (SELECT array_agg(id ORDER BY id) FROM "Resource") AS res,
             (SELECT array_agg(id ORDER BY id) FROM "Staff" WHERE role <> 'FRONT_DESK') AS stf,
             (SELECT array_agg(id ORDER BY id) FROM "User") AS usr, (SELECT array_agg(id ORDER BY id) FROM "Patient") AS pat
    ), g AS (
      SELECT i, DATE '2023-11-01' + floor(random() * 1096)::int AS d0, random() AS r_src, random() AS r_enc, random() AS r_pay, random() AS r_pat, random() AS r_stf FROM generate_series(1, ${N}) i
    ), g2 AS (
      -- mostly weekdays, some Saturdays, hardly any Sundays
      SELECT g.*, CASE WHEN extract(dow FROM d0) = 0 AND random() < 0.92 THEN d0 + 1 WHEN extract(dow FROM d0) = 6 AND random() < 0.5 THEN d0 - 1 ELSE d0 END AS d FROM g
    )
    SELECT i, gen_random_uuid()::text AS booking_id, gen_random_uuid()::text AS encounter_id,
           (((d + make_interval(hours => 8 + floor(random() * 10)::int, mins => (floor(random() * 4) * 15)::int)) AT TIME ZONE 'America/Chicago') AT TIME ZONE 'UTC') AS start_ts,
           cfg.svc[1 + floor(random() * cardinality(cfg.svc))::int] AS service_id,
           cfg.res[1 + floor(random() * cardinality(cfg.res))::int] AS resource_id,
           CASE WHEN r_stf < 0.8 THEN cfg.stf[1 + floor(random() * cardinality(cfg.stf))::int] END AS staff_id,
           cfg.usr[1 + floor(random() * cardinality(cfg.usr))::int] AS user_id,
           CASE WHEN r_pat < 0.7 THEN cfg.pat[1 + floor(random() * cardinality(cfg.pat))::int] END AS patient_id,
           CASE WHEN r_src < 0.15 THEN 'WALK_IN' WHEN r_src < 0.60 THEN 'ONLINE' WHEN r_src < 0.75 THEN 'PHONE' ELSE 'FRONT_DESK' END AS source,
           CASE WHEN r_enc < 0.80 THEN 'CHECKED_OUT' WHEN r_enc < 0.88 THEN 'NO_SHOW' WHEN r_enc < 0.91 THEN 'SEEN' WHEN r_enc < 0.94 THEN 'CHECKED_IN' ELSE 'SCHEDULED' END AS enc_status,
           r_pay
    FROM g2 CROSS JOIN cfg`);

  await exec(`INSERT INTO "Booking" (id, "userId", "serviceId", "resourceId", "staffId", "startTime", "endTime", status, source, "patientId")
              SELECT booking_id, user_id, service_id, resource_id, staff_id, start_ts, start_ts + interval '30 minutes', 'CONFIRMED'::"BookingStatus", source::"BookingSource", patient_id FROM perf_visit`);
  // Cancelled bookings carry no encounter: 8% extra, to make sure the reports leave them out.
  await exec(`INSERT INTO "Booking" (id, "userId", "serviceId", "resourceId", "startTime", "endTime", status, source)
              SELECT gen_random_uuid()::text, user_id, service_id, resource_id, start_ts, start_ts + interval '30 minutes', 'CANCELLED'::"BookingStatus", source::"BookingSource" FROM perf_visit WHERE i % 12 = 0`);
  await exec(`INSERT INTO "Encounter" (id, "bookingId", status, "checkedInAt", "updatedAt")
              SELECT encounter_id, booking_id, enc_status::"EncounterStatus", CASE WHEN enc_status <> 'SCHEDULED' THEN start_ts END, now() FROM perf_visit`);

  // Revenue for the checked-out visits: cash from non-members; members split between cash (15% off), credits and perks.
  await exec(`
    INSERT INTO "RevenueEvent" (id, "encounterId", "bookingId", "patientId", "serviceId", "serviceName", "serviceCategory", "listPriceCents", "paymentType", "memberBenefit",
                                "creditsRedeemed", "discountPercent", "discountCents", "netPriceCents", "discountCategory", "planCode", "staffId", "occurredAt", "recordedById")
    SELECT gen_random_uuid()::text, v.encounter_id, v.booking_id, v.patient_id, v.service_id, sv.name, sv.category, COALESCE(sv."priceCents", 7500),
           (CASE WHEN m.id IS NOT NULL AND v.r_pay < 0.45 THEN 'MEMBER' ELSE 'CASH' END)::"PaymentType",
           (CASE WHEN m.id IS NOT NULL AND v.r_pay < 0.35 THEN 'CREDITS' WHEN m.id IS NOT NULL AND v.r_pay < 0.45 THEN 'PERK' END)::"MemberBenefit",
           CASE WHEN m.id IS NOT NULL AND v.r_pay < 0.35 THEN 2 ELSE 0 END,
           CASE WHEN m.id IS NOT NULL AND v.r_pay >= 0.45 THEN 15 ELSE 0 END,
           CASE WHEN m.id IS NOT NULL AND v.r_pay >= 0.45 THEN round(COALESCE(sv."priceCents", 7500) * 0.15)::int ELSE 0 END,
           CASE WHEN m.id IS NOT NULL AND v.r_pay < 0.45 THEN 0
                WHEN m.id IS NOT NULL THEN COALESCE(sv."priceCents", 7500) - round(COALESCE(sv."priceCents", 7500) * 0.15)::int
                ELSE COALESCE(sv."priceCents", 7500) END,
           CASE WHEN m.id IS NOT NULL AND v.r_pay >= 0.45 THEN 'PERF_CATEGORY' END,
           pl.code, v.staff_id, v.start_ts + interval '30 minutes', 'perf'
    FROM perf_visit v JOIN "Service" sv ON sv.id = v.service_id
    LEFT JOIN "Membership" m ON m."patientId" = v.patient_id AND m.status = 'ACTIVE'
    LEFT JOIN "MembershipPlan" pl ON pl.id = m."planId"
    WHERE v.enc_status = 'CHECKED_OUT'`);
  await exec(`DROP TABLE perf_visit`);
  for (const t of ['User', 'Patient', 'Membership', 'Booking', 'Encounter', 'RevenueEvent', 'Service', 'MembershipPlan']) await exec(`ANALYZE "${t}"`);
  return (performance.now() - t0) / 1000;
}

// ---- timing --------------------------------------------------------------------------------------------------------

const RANGES: Array<[string, DateRange]> = [
  ['current month (Oct 2026)', { from: '2026-10-01', to: '2026-10-31' }],
  ['12 months', { from: '2025-11-01', to: '2026-10-31' }],
  ['all 3 years', { from: '2023-11-01', to: '2026-10-31' }],
];
const REPS = 7;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time(fn: () => Promise<unknown>) {
  await fn();                                                       // warm the plan cache and the buffers
  const ms: number[] = [];
  for (let i = 0; i < REPS; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return { median: median(ms), max: Math.max(...ms) };
}

const VIEWS: Array<[string, (r: DateRange) => Promise<unknown>]> = [
  ['Accounting — monthly by service', (range) => revenueTable({ range }, 'serviceMonth')],
  ['Accounting — daily', (range) => revenueTable({ range }, 'day')],
  ['Accounting — member vs non-member', (range) => memberSplit({ range })],
  ['Accounting — custom (service+payment+provider, by day)', async (range) => {
    const [svc] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Service" ORDER BY id LIMIT 1`;
    const [stf] = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Staff" WHERE role <> 'FRONT_DESK' ORDER BY id LIMIT 1`;
    return revenueTable({ range, serviceId: svc!.id, paymentType: 'CASH', providerId: stf!.id }, 'day');
  }],
  ['Accounting — by provider', (range) => revenueTable({ range }, 'provider')],
  ['Reports — new memberships per month', (range) => signupsByMonth(range)],
  ['Reports — walk-ins (by day, by hour, share)', (range) => walkIns(range)],
  ['Reports — weekend visits', (range) => weekendVisits(range)],
  ['Reports — service demand', (range) => serviceDemand(range)],
];

// ---- plans ---------------------------------------------------------------------------------------------------------

type Stmt = [string, (r: DateRange) => Prisma.Sql, string[]];
const f = (range: DateRange): RevenueFilter => ({ range });
let providerId = '';
const STATEMENTS: Stmt[] = [
  ['revenue by day', (r) => revenueSql(f(r), dimension('day')), ['RevenueEvent']],
  ['revenue by service+month', (r) => revenueSql(f(r), dimension('serviceMonth')), ['RevenueEvent']],
  ['revenue, provider filter', (r) => revenueSql({ range: r, providerId }, dimension('day')), ['RevenueEvent']],
  ['sign-ups', signupsSql, ['Membership']],
  ['walk-ins by day', walkInsByDaySql, ['Booking']],
  ['walk-ins by hour', walkInsByHourSql, ['Booking']],
  ['visits attended', attendedVisitsSql, ['Booking']],
  ['weekend', weekendSql, ['Booking']],
  ['service demand', demandSql, ['Booking']],
];
async function plan(sql: Prisma.Sql) {
  const rows = await db.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql.text}`, ...sql.values);
  const lines = rows.map((r) => r['QUERY PLAN']);
  const scans = lines.map((l) => l.trim()).filter((l) => /^(->\s*)?(Seq Scan|Index Scan|Index Only Scan|Bitmap Heap Scan|Bitmap Index Scan) /.test(l)).map((l) => l.replace(/^->\s*/, '').replace(/\s+\(cost=.*$/, '').replace(/ \(actual.*$/, ''));
  const exec = lines.find((l) => l.startsWith('Execution Time')) ?? '';
  return { scans, ms: Number(/([\d.]+) ms/.exec(exec)?.[1] ?? NaN) };
}

async function main() {
  const schema = await assertScratch();
  const loadSecs = await load();
  providerId = (await db.$queryRaw<Array<{ id: string }>>`SELECT "staffId" AS id FROM "RevenueEvent" WHERE "staffId" IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)[0]!.id;
  const counts = await db.$queryRaw<Array<{ t: string; n: number }>>`
    SELECT 'Encounter' AS t, count(*)::int AS n FROM "Encounter" UNION ALL SELECT 'Booking', count(*)::int FROM "Booking"
    UNION ALL SELECT 'RevenueEvent', count(*)::int FROM "RevenueEvent" UNION ALL SELECT 'Membership', count(*)::int FROM "Membership"`;
  console.log(`# Reports at ${N.toLocaleString('en-US')} encounters  (scratch schema ${schema}, loaded in ${loadSecs.toFixed(1)}s)\n`);
  console.log('rows: ' + counts.map((c) => `${c.t} ${c.n.toLocaleString('en-US')}`).join(' · '));
  console.log(`\n## Timings — median / worst of ${REPS} runs after one warm-up, milliseconds, including Node-side shaping\n`);
  console.log(['view', ...RANGES.map(([l]) => l)].join(' | '));
  console.log(['---', ...RANGES.map(() => '---')].join(' | '));
  let slowest = 0;
  for (const [label, run] of VIEWS) {
    const cells: string[] = [];
    for (const [, range] of RANGES) { const t = await time(() => run(range)); slowest = Math.max(slowest, t.max); cells.push(`${t.median.toFixed(0)} / ${t.max.toFixed(0)}`); }
    console.log([label, ...cells].join(' | '));
  }
  console.log(`\nslowest single run: ${slowest.toFixed(0)} ms`);

  console.log('\n## Plans (EXPLAIN ANALYZE) — scan nodes per statement\n');
  let seqScansOnMonth = 0;
  for (const [label, build, tables] of STATEMENTS) {
    for (const [rangeLabel, range] of [RANGES[0]!, RANGES[2]!]) {
      const p = await plan(build(range));
      const big = p.scans.filter((s) => /Bitmap Index Scan/.test(s) || tables.some((t) => s.includes(`on "${t}"`) || s.includes(` on ${t.toLowerCase()} `)));
      if (rangeLabel.startsWith('current') && big.some((s) => s.startsWith('Seq Scan'))) seqScansOnMonth++;
      console.log(`- ${label} · ${rangeLabel}: ${p.ms.toFixed(1)} ms · ${(big.length ? big : p.scans).join(' → ') || '(no scan nodes)'}`);
    }
  }
  console.log(`\nstatements that sequentially scanned a large table for the current month: ${seqScansOnMonth}`);
  if (seqScansOnMonth) process.exitCode = 1;
}

main().catch((e) => { console.error('perf failed:', e?.code ?? e?.constructor?.name, String(e?.message ?? e).split('\n')[0]); process.exitCode = 1; }).finally(() => db.$disconnect());
