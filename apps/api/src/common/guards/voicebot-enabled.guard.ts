import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Corta todo lo del canal de voz mientras el voicebot está apagado (`VOICEBOT_ENABLED`, /settings).
 * El sidebar esconde *Flujos de voz* con `GET /features`, pero eso es solo cosmético: este guard
 * es el gate real. Responde 404, no 403: con el voicebot apagado la sección no existe.
 */
@Injectable()
export class VoicebotEnabledGuard implements CanActivate {
  constructor(private readonly appConfig: AppConfigService) {}

  async canActivate(): Promise<boolean> {
    if (await this.appConfig.getBoolean('VOICEBOT_ENABLED', false)) return true;
    throw new NotFoundException('El voicebot no está habilitado');
  }
}
