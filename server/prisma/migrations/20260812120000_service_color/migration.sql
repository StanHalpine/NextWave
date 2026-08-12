-- Assigns each service a color from a fixed, discipline-grouped swatch
-- library (src/lib/serviceColors.ts) so the front desk dashboard can
-- color-code booking blocks by service type.
--
-- Added nullable, backfilled by slug, then locked to NOT NULL — there is no
-- service-create endpoint, so every row is accounted for here; nothing can
-- slip through with no color assigned.

ALTER TABLE "Service" ADD COLUMN "color" TEXT;

-- Chiropractic (browns)
UPDATE "Service" SET "color" = 'chiro_saddle'  WHERE "slug" = 'manual-adjustment';
UPDATE "Service" SET "color" = 'chiro_golden'  WHERE "slug" = 'spinal-postural-exam';
UPDATE "Service" SET "color" = 'chiro_peru'    WHERE "slug" = 'spinal-xrays';

-- Functional Medicine (greens)
UPDATE "Service" SET "color" = 'fm_hunter'     WHERE "slug" = 'functional-medicine-consult';
UPDATE "Service" SET "color" = 'fm_jade'       WHERE "slug" = 'biomarker-testing';
UPDATE "Service" SET "color" = 'fm_grass'      WHERE "slug" = 'hormone-optimization';
UPDATE "Service" SET "color" = 'fm_shamrock'   WHERE "slug" = 'personal-wellness-planning';
UPDATE "Service" SET "color" = 'fm_lime'       WHERE "slug" = 'supplementation';
UPDATE "Service" SET "color" = 'fm_forest'     WHERE "slug" = 'body-composition';

-- Longevity (blues). Both hyperbaric rows (60/90 min) share one slug and one
-- color — they are the same service at two durations, not two services.
UPDATE "Service" SET "color" = 'long_midnight' WHERE "slug" = 'red-light-therapy';
UPDATE "Service" SET "color" = 'long_cobalt'   WHERE "slug" = 'hyperbaric-oxygen-therapy';
UPDATE "Service" SET "color" = 'long_periwinkle' WHERE "slug" = 'vitamin-shots';
UPDATE "Service" SET "color" = 'long_sky'      WHERE "slug" = 'iv-therapy';
UPDATE "Service" SET "color" = 'long_ice'      WHERE "slug" = 'peptide-therapy';

ALTER TABLE "Service" ALTER COLUMN "color" SET NOT NULL;
