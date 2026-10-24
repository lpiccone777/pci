import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';

const SERVICE_TOKEN_KEY = 'serviceTokenSettingKey';

/**
 * Clave del catálogo de settings que guarda el token que exige esta ruta (p. ej.
 * `VOICEBOT_SERVICE_TOKEN`). Va con `@UseGuards(ServiceTokenGuard)`.
 */
export const RequireServiceToken = (settingKey: string) => SetMetadata(SERVICE_TOKEN_KEY, settingKey);

/**
 * Autenticación servicio → pci (contrato de integración §2): `Authorization: Bearer <token>`,
 * comparado contra un secret del catálogo de settings. Va fuera de la cadena
 * `JwtAuthGuard`/`TenantGuard`: quien llama es un servicio, no una persona con tenant. Mismo
 * criterio que `TwilioSignatureGuard`, un guard propio por controlador.
 *
 * - Compara en tiempo constante (sobre el SHA-256 de los dos lados, para que el largo no se filtre).
 * - Token inválido, ausente o sin configurar en pci: 401 sin detalle.
 * - `Cache-Control: no-store` en toda respuesta, incluido el 401: estas rutas devuelven secrets.
 * - Nunca loguea el token recibido ni el esperado.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly logger = new Logger(ServiceTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');

    const settingKey = this.reflector.getAllAndOverride<string>(SERVICE_TOKEN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!settingKey) {
      // Error de armado del controlador, no del que llama: fallar cerrado.
      this.logger.error('ServiceTokenGuard sin @RequireServiceToken: se rechaza la request');
      throw new UnauthorizedException();
    }

    const header = http.getRequest<Request>().headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    let expected: string | undefined;
    try {
      expected = await this.appConfig.get(settingKey);
    } catch {
      this.logger.error(`No se pudo descifrar ${settingKey}: se rechaza la request`);
      throw new UnauthorizedException();
    }

    if (!provided || !expected || !sameToken(provided, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

function sameToken(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}
