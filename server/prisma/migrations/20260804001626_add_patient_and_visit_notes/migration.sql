-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('SUBJECTIVE', 'OBJECTIVE', 'ASSESSMENT', 'PLAN', 'GENERAL');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "patientNote" TEXT;

-- CreateTable
CREATE TABLE "VisitNote" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL DEFAULT 'GENERAL',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amendsId" TEXT,
    "amendReason" TEXT,

    CONSTRAINT "VisitNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VisitNote_amendsId_key" ON "VisitNote"("amendsId");

-- CreateIndex
CREATE INDEX "VisitNote_bookingId_createdAt_idx" ON "VisitNote"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "VisitNote_authorId_idx" ON "VisitNote"("authorId");

-- AddForeignKey
ALTER TABLE "VisitNote" ADD CONSTRAINT "VisitNote_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitNote" ADD CONSTRAINT "VisitNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitNote" ADD CONSTRAINT "VisitNote_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "VisitNote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
