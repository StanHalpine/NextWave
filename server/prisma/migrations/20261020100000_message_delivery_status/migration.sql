-- Delivery status from the messaging provider's status callbacks, kept apart from our own send state (MessageLog.status).
-- A provider error code is a number; the provider's message text is never stored (it can echo the recipient).

-- AlterTable
ALTER TABLE "MessageLog" ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "providerErrorCode" INTEGER;

-- CreateIndex: a status callback finds its message by the provider's id.
CREATE INDEX "MessageLog_providerMessageId_idx" ON "MessageLog"("providerMessageId");
