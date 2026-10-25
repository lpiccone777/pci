import { Module } from '@nestjs/common';
import { FlowService } from './flow.service';
import { FlowController } from './flow.controller';
import { VoiceFlowController } from './voice-flow.controller';
import { VoicebotEnabledGuard } from '../../common/guards/voicebot-enabled.guard';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';
import { ScheduleCalendarModule } from '../schedule-calendar/schedule-calendar.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  // ScheduleCalendarModule exporta ScheduleCalendarService, que FlowService necesita para
  // resolver feriado/guardia en findActiveFlowForTenant. Dependencia unidireccional:
  // schedule-calendar no importa flow, así que no hay riesgo de ciclo.
  // IntegrationsModule: un flujo de voz guardado avisa al voicebot (`voiceLiterals`, C60).
  imports: [ScheduleCalendarModule, IntegrationsModule],
  // SystemTenantGuard inyecta PrismaService + ConfigService, así que va como
  // provider para que Nest lo pueda instanciar en `GET /flows/all`.
  providers: [FlowService, SystemTenantGuard, VoicebotEnabledGuard],
  controllers: [FlowController, VoiceFlowController],
  exports: [FlowService],
})
export class FlowModule {}
