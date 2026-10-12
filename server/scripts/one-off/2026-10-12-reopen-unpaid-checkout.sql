-- ONE-OFF (2026-10-12). Paste into the Supabase SQL editor — no shell needed. Two steps; run them one at a time.
--
-- WHY. A staging visit sat in "Seen / checked out" labelled "Done" with nothing recorded and no way to check it out. Almost certainly it is
-- only SEEN (the provider signed; that is all signing does) — nothing is wrong with the row, and once this release is deployed it simply has
-- a Check out button. Step 2 is for the other case: a visit marked CHECKED_OUT that has NO payment recorded, which the app can no longer
-- produce. It puts such a visit back to SEEN so it can be checked out properly.

-- STEP 1 — LOOK (changes nothing). Shows no names, only ids and service.
--   status SEEN                              -> nothing to fix: deploy this release and use the Check out button.
--   status CHECKED_OUT, has_payment = false  -> run step 2 for that booking_id.
--   status CHECKED_OUT, has_payment = true   -> it was checked out properly; leave it.
SELECT b."id" AS booking_id, e."status", (r."id" IS NOT NULL) AS has_payment, e."checkedOutAt", s."name" AS service, b."startTime"
FROM "Encounter" e
JOIN "Booking" b ON b."id" = e."bookingId"
JOIN "Service" s ON s."id" = b."serviceId"
LEFT JOIN "RevenueEvent" r ON r."encounterId" = e."id"
WHERE e."deletedAt" IS NULL AND (e."status" = 'SEEN' OR (e."status" = 'CHECKED_OUT' AND r."id" IS NULL))
ORDER BY b."startTime" DESC
LIMIT 20;

-- STEP 2 — PUT ONE VISIT BACK TO SEEN. Replace PASTE-BOOKING-ID-HERE (inside the quotes) with the booking_id from step 1.
-- Left as it is, it matches nothing and changes nothing. It only ever touches a CHECKED_OUT visit with no payment recorded, so running it twice,
-- or on the wrong id, is harmless. It writes one audit row (actor "system:one-off-fix") naming the visit and no one else.
WITH reopened AS (
  UPDATE "Encounter" e
  SET "status" = 'SEEN'::"EncounterStatus", "checkedOutAt" = NULL, "checkedOutById" = NULL, "updatedAt" = now()
  WHERE e."bookingId" = 'PASTE-BOOKING-ID-HERE'
    AND e."status" = 'CHECKED_OUT'
    AND NOT EXISTS (SELECT 1 FROM "RevenueEvent" r WHERE r."encounterId" = e."id")
  RETURNING e."id"
)
INSERT INTO "AuditLog" ("action", "resourceType", "resourceId", "success", "actorRoles", "meta")
SELECT 'UPDATE'::"AuditAction", 'encounter', reopened."id", true, 'system:one-off-fix',
       '{"to":"SEEN","fields":["status","checkedOutAt"],"reason":"checked out with no payment recorded"}'::jsonb
FROM reopened;
