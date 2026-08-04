-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "newPatientSlug" TEXT,
ADD COLUMN     "priceCents" INTEGER,
ADD COLUMN     "priceNote" TEXT;

-- CreateTable
CREATE TABLE "ServiceOption" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServiceOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceOption_serviceId_idx" ON "ServiceOption"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceOption_serviceId_label_key" ON "ServiceOption"("serviceId", "label");

-- AddForeignKey
ALTER TABLE "ServiceOption" ADD CONSTRAINT "ServiceOption_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
