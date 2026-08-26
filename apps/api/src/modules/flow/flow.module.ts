import { Module } from '@nestjs/common';
import { FlowService } from './flow.service';
import { FlowController } from './flow.controller';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { ScheduleCalendarModule } from '../schedule-calendar/schedule-calendar.module';

@Module({
  // ScheduleCalendarModule exporta ScheduleCalendarService, que FlowService necesita para
  // resolver feriado/guardia en findActiveFlowForTenant. Dependencia unidireccional:
  // schedule-calendar no importa flow, así que no hay riesgo de ciclo.
  imports: [ScheduleCalendarModule],
  // SystemTenantGuard inyecta PrismaService + ConfigService, así que va como
  // provider para que Nest lo pueda instanciar en `GET /flows/all`.
  providers: [FlowService, SystemTenantGuard],
  controllers: [FlowController],
  exports: [FlowService],
})
export class FlowModule {}
