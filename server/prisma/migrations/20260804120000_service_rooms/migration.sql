-- Service ↔ Room becomes many-to-many.
--
-- `Service.resourceType` allowed exactly one room type per service, so Vitamin
-- Shots queued for the single Shot Room while four IV chairs sat idle.
--
-- Backfill FIRST, then drop the column: every service ends up listing exactly
-- the rooms it could already use, so availability is bit-for-bit unchanged
-- until someone ticks a new box in the admin screen.

CREATE TABLE "ServiceRoom" (
    "serviceId"  TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    CONSTRAINT "ServiceRoom_pkey" PRIMARY KEY ("serviceId","resourceId")
);

CREATE INDEX "ServiceRoom_resourceId_idx" ON "ServiceRoom"("resourceId");

ALTER TABLE "ServiceRoom" ADD CONSTRAINT "ServiceRoom_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceRoom" ADD CONSTRAINT "ServiceRoom_resourceId_fkey"
    FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Inactive rooms are included deliberately: availability filters on `active`
-- anyway, and carrying the link means reactivating a room restores it to the
-- services it used to serve instead of silently coming back unassigned.
INSERT INTO "ServiceRoom" ("serviceId", "resourceId")
SELECT s."id", r."id"
FROM "Service" s
JOIN "Resource" r ON r."type" = s."resourceType";

ALTER TABLE "Service" DROP COLUMN "resourceType";
