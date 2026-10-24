import { Controller, Get, UseGuards } from '@nestjs/common';
import { RequireServiceToken, ServiceTokenGuard } from '../../common/guards/service-token.guard';
import { IntegrationsConfigService } from './integrations-config.service';

/**
 * Endpoints servicio → pci de la integración con el voicebot y el stt (contrato de
 * integración §3.1/§3.2). Los llaman servicios, no personas: van con `ServiceTokenGuard` y
 * fuera de `JwtAuthGuard`/`TenantGuard` (la configuración es infra global, no de un tenant).
 *
 * Las respuestas llevan secrets en claro [DA2]: no loguear nunca el cuerpo.
 */
@Controller('integrations')
@UseGuards(ServiceTokenGuard)
export class IntegrationsController {
  constructor(private readonly integrationsConfig: IntegrationsConfigService) {}

  @Get('voicebot/config')
  @RequireServiceToken('VOICEBOT_SERVICE_TOKEN')
  voicebotConfig() {
    return this.integrationsConfig.voicebotConfig();
  }

  @Get('stt/config')
  @RequireServiceToken('STT_SERVICE_TOKEN')
  sttConfig() {
    return this.integrationsConfig.sttConfig();
  }
}
