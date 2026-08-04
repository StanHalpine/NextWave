-- Non-clinical staff role. Safe inside Prisma's migration transaction on
-- PostgreSQL 12+ provided the new value is not USED in the same transaction,
-- which is why no rows are inserted here.
ALTER TYPE "StaffRole" ADD VALUE 'FRONT_DESK';
