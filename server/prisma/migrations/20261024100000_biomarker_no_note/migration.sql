-- Rev 2.2: biomarker testing needs no signed note (the owner, via Chase). Its results will be uploaded to the patient's profile in a
-- later phase; that is not part of 2b. Mirrored in prisma/seed.ts for a new database; an administrator changes it on
-- Configuration → Services.
--
-- Only the SERVICE changes. A visit's requirement was fixed when its patient was checked in (rev 2.0, the trigger
-- nw_encounter_note_required), so biomarker visits already checked in keep the requirement they were given, and the next check-in
-- takes the new value. No new table, so no Row Level Security to enable.
UPDATE "Service" SET "requiresNote" = false WHERE "slug" = 'biomarker-testing';
