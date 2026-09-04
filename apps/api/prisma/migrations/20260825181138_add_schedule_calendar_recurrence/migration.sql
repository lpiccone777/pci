-- AlterTable
ALTER TABLE "ScheduleCalendarEntry" ADD COLUMN     "recurrenceFreq" TEXT,
ADD COLUMN     "recurrenceUntil" TIMESTAMP(3);
