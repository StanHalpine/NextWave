-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('MONTHLY_GRANT', 'ADJUSTMENT', 'REDEMPTION', 'EXPIRATION');

-- CreateEnum
CREATE TYPE "PerkPeriod" AS ENUM ('MONTHLY', 'QUARTERLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('MEMBER', 'CASH');

-- CreateEnum
CREATE TYPE "MemberBenefit" AS ENUM ('CREDITS', 'PERK');

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "creditCost" INTEGER;

-- CreateTable
CREATE TABLE "MembershipPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "creditsPerMonth" INTEGER NOT NULL,
    "rolloverDays" INTEGER NOT NULL DEFAULT 90,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MembershipPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPerk" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "period" "PerkPeriod" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PlanPerk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPerkService" (
    "perkId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,

    CONSTRAINT "PlanPerkService_pkey" PRIMARY KEY ("perkId","serviceId")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedOn" DATE NOT NULL,
    "nextGrantOn" DATE NOT NULL,
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" BIGSERIAL NOT NULL,
    "patientId" TEXT NOT NULL,
    "membershipId" TEXT,
    "reason" "LedgerReason" NOT NULL,
    "delta" INTEGER NOT NULL,
    "lotExpiresOn" DATE,
    "periodStart" DATE,
    "encounterId" TEXT,
    "revenueEventId" TEXT,
    "actorAccountId" TEXT,
    "reasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditAllocation" (
    "id" BIGSERIAL NOT NULL,
    "ledgerId" BIGINT NOT NULL,
    "lotId" BIGINT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "CreditAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerkUsage" (
    "id" BIGSERIAL NOT NULL,
    "membershipId" TEXT NOT NULL,
    "perkId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "revenueEventId" TEXT,
    "actorAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerkUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueEvent" (
    "id" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "patientId" TEXT,
    "serviceId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "serviceCategory" TEXT NOT NULL,
    "subOption" TEXT,
    "priceCents" INTEGER,
    "paymentType" "PaymentType" NOT NULL,
    "memberBenefit" "MemberBenefit",
    "creditsRedeemed" INTEGER NOT NULL DEFAULT 0,
    "cashDueCents" INTEGER NOT NULL DEFAULT 0,
    "planCode" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipPlan_code_key" ON "MembershipPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PlanPerk_planId_key_key" ON "PlanPerk"("planId", "key");

-- CreateIndex
CREATE INDEX "Membership_patientId_idx" ON "Membership"("patientId");

-- CreateIndex
CREATE INDEX "Membership_status_nextGrantOn_idx" ON "Membership"("status", "nextGrantOn");

-- CreateIndex
CREATE INDEX "CreditLedger_patientId_createdAt_idx" ON "CreditLedger"("patientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_membershipId_periodStart_reason_key" ON "CreditLedger"("membershipId", "periodStart", "reason");

-- CreateIndex
CREATE INDEX "CreditAllocation_lotId_idx" ON "CreditAllocation"("lotId");

-- CreateIndex
CREATE INDEX "CreditAllocation_ledgerId_idx" ON "CreditAllocation"("ledgerId");

-- CreateIndex
CREATE INDEX "PerkUsage_membershipId_perkId_periodKey_idx" ON "PerkUsage"("membershipId", "perkId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueEvent_encounterId_key" ON "RevenueEvent"("encounterId");

-- CreateIndex
CREATE INDEX "RevenueEvent_occurredAt_idx" ON "RevenueEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "RevenueEvent_serviceId_occurredAt_idx" ON "RevenueEvent"("serviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "RevenueEvent_patientId_idx" ON "RevenueEvent"("patientId");

-- AddForeignKey
ALTER TABLE "PlanPerk" ADD CONSTRAINT "PlanPerk_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPerkService" ADD CONSTRAINT "PlanPerkService_perkId_fkey" FOREIGN KEY ("perkId") REFERENCES "PlanPerk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanPerkService" ADD CONSTRAINT "PlanPerkService_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MembershipPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "CreditLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "CreditLedger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerkUsage" ADD CONSTRAINT "PerkUsage_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerkUsage" ADD CONSTRAINT "PerkUsage_perkId_fkey" FOREIGN KEY ("perkId") REFERENCES "PlanPerk"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- HAND-WRITTEN: the ledger can never be edited, and cannot be overdrawn
-- =============================================================================
-- Credits are money-like. Row triggers reject UPDATE and DELETE and a statement trigger rejects
-- TRUNCATE on every append-only table below; corrections are new rows. (DROP TABLE is DDL and is
-- not blocked — the application's runtime role should not own the schema; see PHASE1_NOTES.)

CREATE OR REPLACE FUNCTION nw_reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CreditLedger_no_update_delete"     BEFORE UPDATE OR DELETE ON "CreditLedger"     FOR EACH ROW       EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "CreditLedger_no_truncate"          BEFORE TRUNCATE         ON "CreditLedger"     FOR EACH STATEMENT EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "CreditAllocation_no_update_delete" BEFORE UPDATE OR DELETE ON "CreditAllocation" FOR EACH ROW       EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "CreditAllocation_no_truncate"      BEFORE TRUNCATE         ON "CreditAllocation" FOR EACH STATEMENT EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "PerkUsage_no_update_delete"        BEFORE UPDATE OR DELETE ON "PerkUsage"        FOR EACH ROW       EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "PerkUsage_no_truncate"             BEFORE TRUNCATE         ON "PerkUsage"        FOR EACH STATEMENT EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "RevenueEvent_no_update_delete"     BEFORE UPDATE OR DELETE ON "RevenueEvent"     FOR EACH ROW       EXECUTE FUNCTION nw_reject_ledger_mutation();
CREATE TRIGGER "RevenueEvent_no_truncate"          BEFORE TRUNCATE         ON "RevenueEvent"     FOR EACH STATEMENT EXECUTE FUNCTION nw_reject_ledger_mutation();

-- Shape rules. A positive row is a LOT and must say when it expires; a negative row must not.
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_delta_nonzero" CHECK ("delta" <> 0);
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_lot_shape"
  CHECK (("delta" > 0 AND "lotExpiresOn" IS NOT NULL) OR ("delta" < 0 AND "lotExpiresOn" IS NULL));
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_grant_has_period"
  CHECK ("reason" <> 'MONTHLY_GRANT' OR ("periodStart" IS NOT NULL AND "membershipId" IS NOT NULL AND "delta" > 0));
ALTER TABLE "CreditAllocation" ADD CONSTRAINT "CreditAllocation_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "PerkUsage" ADD CONSTRAINT "PerkUsage_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "MembershipPlan" ADD CONSTRAINT "MembershipPlan_sane"
  CHECK ("creditsPerMonth" >= 0 AND "rolloverDays" >= 1 AND "priceCents" >= 0);
ALTER TABLE "PlanPerk" ADD CONSTRAINT "PlanPerk_quantity_nonneg" CHECK ("quantity" >= 0);
ALTER TABLE "Service" ADD CONSTRAINT "Service_creditCost_positive" CHECK ("creditCost" IS NULL OR "creditCost" > 0);
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_consistent" CHECK (
  "creditsRedeemed" >= 0 AND "cashDueCents" >= 0 AND ("priceCents" IS NULL OR "priceCents" >= 0)
  AND (("paymentType" = 'CASH'   AND "memberBenefit" IS NULL     AND "creditsRedeemed" = 0 AND "priceCents" IS NOT NULL)
    OR ("paymentType" = 'MEMBER' AND "memberBenefit" IS NOT NULL AND "cashDueCents" = 0
        AND ("memberBenefit" = 'CREDITS') = ("creditsRedeemed" > 0)))
);

-- One open (ACTIVE or PAUSED) membership per patient.
CREATE UNIQUE INDEX "Membership_one_open_per_patient" ON "Membership" ("patientId") WHERE "status" IN ('ACTIVE', 'PAUSED');

-- Overdraw guard, evaluated at COMMIT. After a negative row's allocations are written, the
-- lot must still hold ≥ 0, every allocation must come from a positive row, and a negative row's
-- allocations must total exactly what it removes. Deferred, so it sees what other transactions
-- committed meanwhile: two concurrent redemptions cannot both take the last credit even if
-- application code forgot to lock.
CREATE OR REPLACE FUNCTION nw_credit_guard() RETURNS trigger AS $$
DECLARE
  lot_delta integer;
  drawn integer;
  removes integer;
BEGIN
  IF TG_TABLE_NAME = 'CreditAllocation' THEN
    SELECT "delta" INTO lot_delta FROM "CreditLedger" WHERE "id" = NEW."lotId";
    IF lot_delta IS NULL OR lot_delta <= 0 THEN
      RAISE EXCEPTION 'credit allocation % must draw from a positive lot', NEW."id" USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM("amount"), 0) INTO drawn FROM "CreditAllocation" WHERE "lotId" = NEW."lotId";
    IF drawn > lot_delta THEN
      RAISE EXCEPTION 'credit lot % would be overdrawn', NEW."lotId" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."delta" < 0 THEN
      SELECT COALESCE(SUM("amount"), 0) INTO drawn FROM "CreditAllocation" WHERE "ledgerId" = NEW."id";
      IF drawn <> -NEW."delta" THEN
        RAISE EXCEPTION 'ledger row % removes % credits but its allocations total %', NEW."id", -NEW."delta", drawn USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "CreditAllocation_guard" AFTER INSERT ON "CreditAllocation"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nw_credit_guard();
CREATE CONSTRAINT TRIGGER "CreditLedger_guard" AFTER INSERT ON "CreditLedger"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nw_credit_guard();

-- =============================================================================
-- DATA: the three tiers, placeholder perks, and credit costs
-- =============================================================================
-- Tiers are rows, not code (editable on Admin → Memberships). Dues are the owner's
-- published prices; credits per month 4 / 6 / 8; credits roll over for 90 days.
INSERT INTO "MembershipPlan" ("id", "code", "name", "priceCents", "creditsPerMonth", "rolloverDays", "active", "sortOrder") VALUES
  ('9a4e0000-0000-4000-8000-000000000001', 'PREVENT',  'Prevent',   9900, 4, 90, true, 1),
  ('9a4e0000-0000-4000-8000-000000000002', 'RESTORE',  'Restore',  19900, 6, 90, true, 2),
  ('9a4e0000-0000-4000-8000-000000000003', 'OPTIMIZE', 'Optimize', 29900, 8, 90, true, 3)
ON CONFLICT ("code") DO NOTHING;

-- Perk counters PRE-FILLED FROM THE OWNER'S TIER COPY but INACTIVE: nothing offers them at
-- check-out until the owner confirms the exact mapping (Admin → Memberships).
INSERT INTO "PlanPerk" ("id", "planId", "key", "label", "period", "quantity", "active", "sortOrder") VALUES
  ('9a4e0001-0000-4000-8000-000000000011', '9a4e0000-0000-4000-8000-000000000001', 'monthly_shot_or_iv',          'Monthly vitamin shot',                'MONTHLY',   1, false, 1),
  ('9a4e0001-0000-4000-8000-000000000012', '9a4e0000-0000-4000-8000-000000000001', 'quarterly_body_composition', 'Quarterly body composition analysis', 'QUARTERLY', 1, false, 2),
  ('9a4e0001-0000-4000-8000-000000000013', '9a4e0000-0000-4000-8000-000000000001', 'guest_pass',                 'Guest passes',                        'QUARTERLY', 0, false, 3),
  ('9a4e0001-0000-4000-8000-000000000021', '9a4e0000-0000-4000-8000-000000000002', 'monthly_shot_or_iv',          'Monthly vitamin shot',                'MONTHLY',   1, false, 1),
  ('9a4e0001-0000-4000-8000-000000000022', '9a4e0000-0000-4000-8000-000000000002', 'quarterly_body_composition', 'Quarterly body composition analysis', 'QUARTERLY', 1, false, 2),
  ('9a4e0001-0000-4000-8000-000000000023', '9a4e0000-0000-4000-8000-000000000002', 'guest_pass',                 'Guest passes',                        'QUARTERLY', 1, false, 3),
  ('9a4e0001-0000-4000-8000-000000000031', '9a4e0000-0000-4000-8000-000000000003', 'monthly_shot_or_iv',          'Monthly IV drip',                     'MONTHLY',   1, false, 1),
  ('9a4e0001-0000-4000-8000-000000000032', '9a4e0000-0000-4000-8000-000000000003', 'quarterly_body_composition', 'Quarterly body composition analysis', 'QUARTERLY', 1, false, 2),
  ('9a4e0001-0000-4000-8000-000000000033', '9a4e0000-0000-4000-8000-000000000003', 'guest_pass',                 'Guest passes',                        'QUARTERLY', 2, false, 3)
ON CONFLICT ("planId", "key") DO NOTHING;

-- Which services redeem a perk. (On a fresh database the services do not exist yet when this
-- runs; prisma/seed.ts adds the same links after it creates them.)
INSERT INTO "PlanPerkService" ("perkId", "serviceId")
SELECT p."id", s."id" FROM "PlanPerk" p JOIN "Service" s ON (
     (p."key" = 'monthly_shot_or_iv' AND p."planId" IN ('9a4e0000-0000-4000-8000-000000000001', '9a4e0000-0000-4000-8000-000000000002') AND s."slug" = 'vitamin-shots')
  OR (p."key" = 'monthly_shot_or_iv' AND p."planId" = '9a4e0000-0000-4000-8000-000000000003' AND s."slug" = 'iv-therapy')
  OR (p."key" = 'quarterly_body_composition' AND s."slug" = 'body-composition'))
ON CONFLICT DO NOTHING;

-- What a service costs in credits (the owner's table). NULL = not credit-eligible.
UPDATE "Service" SET "creditCost" = 2 WHERE "slug" IN ('manual-adjustment', 'red-light-therapy', 'vitamin-shots');
UPDATE "Service" SET "creditCost" = 4 WHERE "slug" = 'hyperbaric-oxygen-therapy' AND "durationMin" = 60;
UPDATE "Service" SET "creditCost" = 6 WHERE "slug" = 'hyperbaric-oxygen-therapy' AND "durationMin" = 90;
UPDATE "Service" SET "creditCost" = 6 WHERE "slug" = 'iv-therapy';
