-- Add the column nullable first, backfill the 15 existing rows by their fixed
-- seed UUIDs (same UUIDs seed.ts has always used — this does not invent new
-- identifiers, only fills in a column that did not exist yet), then enforce
-- NOT NULL. A bare `ADD COLUMN ... NOT NULL` fails outright on a non-empty
-- table with no default.

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "slug" TEXT;

UPDATE "Service" SET slug = 'manual-adjustment' WHERE id = '5e401ce0-0000-4000-8000-000000000001';
UPDATE "Service" SET slug = 'spinal-postural-exam' WHERE id = '5e401ce0-0000-4000-8000-000000000002';
UPDATE "Service" SET slug = 'spinal-xrays' WHERE id = '5e401ce0-0000-4000-8000-000000000003';
UPDATE "Service" SET slug = 'functional-medicine-consult' WHERE id = '5e401ce0-0000-4000-8000-000000000004';
UPDATE "Service" SET slug = 'biomarker-testing' WHERE id = '5e401ce0-0000-4000-8000-000000000005';
UPDATE "Service" SET slug = 'hormone-optimization' WHERE id = '5e401ce0-0000-4000-8000-000000000006';
UPDATE "Service" SET slug = 'body-composition' WHERE id = '5e401ce0-0000-4000-8000-000000000007';
UPDATE "Service" SET slug = 'supplementation' WHERE id = '5e401ce0-0000-4000-8000-000000000008';
UPDATE "Service" SET slug = 'personal-wellness-planning' WHERE id = '5e401ce0-0000-4000-8000-000000000009';
UPDATE "Service" SET slug = 'iv-therapy' WHERE id = '5e401ce0-0000-4000-8000-000000000010';
UPDATE "Service" SET slug = 'vitamin-shots' WHERE id = '5e401ce0-0000-4000-8000-000000000011';
UPDATE "Service" SET slug = 'hyperbaric-oxygen-therapy' WHERE id = '5e401ce0-0000-4000-8000-000000000012';
UPDATE "Service" SET slug = 'hyperbaric-oxygen-therapy' WHERE id = '5e401ce0-0000-4000-8000-000000000013';
UPDATE "Service" SET slug = 'red-light-therapy' WHERE id = '5e401ce0-0000-4000-8000-000000000014';
UPDATE "Service" SET slug = 'peptide-therapy' WHERE id = '5e401ce0-0000-4000-8000-000000000015';

-- A row that isn't one of the 15 known seed rows (shouldn't exist yet, but
-- guards against a future hand-inserted row silently violating NOT NULL) gets
-- a slug derived from its name, so the ALTER below never fails.
UPDATE "Service" SET slug = lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))
WHERE slug IS NULL;

ALTER TABLE "Service" ALTER COLUMN "slug" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Service_slug_idx" ON "Service"("slug");
