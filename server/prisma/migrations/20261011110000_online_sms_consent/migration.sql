-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "patientConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentLabel" TEXT;

-- CreateTable
CREATE TABLE "SmsSuppression" (
    "phoneDigits" TEXT NOT NULL,
    "suppressedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "SmsSuppression_pkey" PRIMARY KEY ("phoneDigits")
);

