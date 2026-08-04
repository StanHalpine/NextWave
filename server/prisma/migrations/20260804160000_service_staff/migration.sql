-- Who may perform a service becomes explicit per person.
--
-- `Service.requiredRole` tied a service to a whole role, so a front desk
-- person qualified to give shots could not be authorised without making her a
-- nurse. Backfill FIRST, then drop the column: every service ends up listing
-- exactly the people who could already perform it, so availability is
-- unchanged until someone edits it.

CREATE TABLE "ServiceStaff" (
    "serviceId" TEXT NOT NULL,
    "staffId"   TEXT NOT NULL,
    CONSTRAINT "ServiceStaff_pkey" PRIMARY KEY ("serviceId","staffId")
);

CREATE INDEX "ServiceStaff_staffId_idx" ON "ServiceStaff"("staffId");

ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Inactive staff are linked too: availability filters on `active` anyway, and
-- carrying the link means reactivating someone restores what they used to do
-- rather than bringing them back able to perform nothing.
INSERT INTO "ServiceStaff" ("serviceId", "staffId")
SELECT s."id", st."id"
FROM "Service" s
JOIN "Staff" st ON st."role" = s."requiredRole";

ALTER TABLE "Service" DROP COLUMN "requiredRole";
