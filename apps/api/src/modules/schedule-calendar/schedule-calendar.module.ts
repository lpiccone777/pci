import { Module } from '@nestjs/common';
import { ScheduleCalendarService } from './schedule-calendar.service';
import { ScheduleCalendarController } from './schedule-calendar.controller';

@Module({
  providers: [ScheduleCalendarService],
  controllers: [ScheduleCalendarController],
  exports: [ScheduleCalendarService],
})
export class ScheduleCalendarModule {}
