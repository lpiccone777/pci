import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Qué funciones opcionales están prendidas, legible por cualquier usuario autenticado (no solo
 * desde el tenant de sistema, como `/settings`). El frontend lo usa para mostrar u ocultar
 * secciones del menú; es solo cosmético: cada API sigue con su propio gate
 * (`VoicebotEnabledGuard` para lo de voz).
 */
@Controller('features')
@UseGuards(JwtAuthGuard)
export class FeaturesController {
  constructor(private readonly appConfig: AppConfigService) {}

  @Get()
  async features() {
    return { voicebot: await this.appConfig.getBoolean('VOICEBOT_ENABLED', false) };
  }
}
