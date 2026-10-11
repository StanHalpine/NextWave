-- Audio retention: remember when a recording's raw audio was deleted by the retention job.

-- AlterTable
ALTER TABLE "ScribeSession" ADD COLUMN     "audioPurgedAt" TIMESTAMP(3);
-- CreateIndex
CREATE INDEX "ScribeSession_audioPurgedAt_idx" ON "ScribeSession"("audioPurgedAt");
