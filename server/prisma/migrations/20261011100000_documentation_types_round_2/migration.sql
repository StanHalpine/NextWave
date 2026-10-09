-- Owner's answer at Phase 2 approval: these four are charted as full SOAP notes.
-- (Spinal X-Rays stays a session log. Fresh databases get the same values from
-- prisma/seed.ts; this brings an existing database in line.)
UPDATE "Service" SET "documentationType" = 'SOAP' WHERE "slug" IN (
  'hormone-optimization',
  'peptide-therapy',
  'personal-wellness-planning',
  'supplementation'
);
