-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;
