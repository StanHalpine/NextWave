-- Phase 5 follow-up: membership dues as revenue. This migration only adds the enum values; a new enum value cannot be
-- used in the transaction that adds it, so the columns and constraints that use it are in the next migration.

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('BILLED');

-- AlterEnum
ALTER TYPE "PaymentType" ADD VALUE 'DUES';
