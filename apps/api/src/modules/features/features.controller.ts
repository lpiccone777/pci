import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppConfigService } from '../../config/app-config.service';
import { InvgateService } from '../invgate/invgate.service';

/**
 * Qué funciones opcionales están prendidas o configuradas, legible por cualquier usuario autenticado (no solo
 * desde el tenant de sistema, como `/settings`). El frontend lo usa para mostrar u ocultar
 * secciones del menú; es solo cosmético: cada API sigue con su propio gate
 * (`VoicebotEnabledGuard` para lo de voz).
 */
@Controller('features')
@UseGuards(JwtAuthGuard)
export class FeaturesController {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly invgate: InvgateService,
  ) {}

  /** `invgate`: si hay URL, usuario y key efectivos (lo usa el editor del nodo de identificación por voz). */
  @Get()
  async features() {
    const [voicebot, invgate] = await Promise.all([
      this.appConfig.getBoolean('VOICEBOT_ENABLED', false),
      this.invgate.isConfigured(),
    ]);
    return { voicebot, invgate };
  }
}
