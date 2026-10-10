-- Member discount: a percentage per tier, applied at check-out when an ACTIVE member pays cash.
-- RevenueEvent now records list price, discount and net price as separate columns.
--
-- RevenueEvent is append-only (UPDATE/DELETE/TRUNCATE are rejected), but a column RENAME and
-- ADD COLUMN ... DEFAULT are DDL and fire no row triggers, so no row is ever rewritten here:
--   priceCents   -> listPriceCents   (same value: what the visit is worth at list price)
--   cashDueCents -> netPriceCents    (same value: what the patient owes in money)
-- and the new discount columns default to 0, which is exactly right for every row written
-- before discounts existed (list - 0 = net).

ALTER TABLE "MembershipPlan" ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MembershipPlan" DROP CONSTRAINT "MembershipPlan_sane";
ALTER TABLE "MembershipPlan" ADD CONSTRAINT "MembershipPlan_sane"
  CHECK ("creditsPerMonth" >= 0 AND "rolloverDays" >= 1 AND "priceCents" >= 0 AND "discountPercent" BETWEEN 0 AND 100);

ALTER TABLE "RevenueEvent" RENAME COLUMN "priceCents" TO "listPriceCents";
ALTER TABLE "RevenueEvent" RENAME COLUMN "cashDueCents" TO "netPriceCents";
ALTER TABLE "RevenueEvent" ADD COLUMN "discountPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RevenueEvent" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;

-- Re-state the consistency rule with the new columns. A cash visit: net = list - discount, and the
-- discount can never exceed the list price. A member visit (credits or a perk): nothing in money.
ALTER TABLE "RevenueEvent" DROP CONSTRAINT "RevenueEvent_consistent";
ALTER TABLE "RevenueEvent" ADD CONSTRAINT "RevenueEvent_consistent" CHECK (
  "creditsRedeemed" >= 0 AND "netPriceCents" >= 0 AND "discountCents" >= 0
  AND "discountPercent" BETWEEN 0 AND 100
  AND ("listPriceCents" IS NULL OR "listPriceCents" >= 0)
  AND (("paymentType" = 'CASH'   AND "memberBenefit" IS NULL AND "creditsRedeemed" = 0 AND "listPriceCents" IS NOT NULL
        AND "discountCents" <= "listPriceCents" AND "netPriceCents" = "listPriceCents" - "discountCents"
        AND ("discountPercent" > 0 OR "discountCents" = 0))
    OR ("paymentType" = 'MEMBER' AND "memberBenefit" IS NOT NULL AND "netPriceCents" = 0
        AND "discountPercent" = 0 AND "discountCents" = 0
        AND ("memberBenefit" = 'CREDITS') = ("creditsRedeemed" > 0)))
);
