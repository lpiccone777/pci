-- AlterTable
ALTER TABLE "ScheduleCalendarEntry" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "ScheduleCalendarEntry_tenantId_source_idx" ON "ScheduleCalendarEntry"("tenantId", "source");
