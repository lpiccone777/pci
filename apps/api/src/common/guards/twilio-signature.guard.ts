import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';

/**
 * Valida `X-Twilio-Signature` en los webhooks entrantes de Twilio (WhatsApp y SMS), según el
 * algoritmo que documenta Twilio: HMAC-SHA1 del Auth Token sobre "URL completa del webhook" +
 * cada parámetro del body `application/x-www-form-urlencoded` (ordenados por clave, cada uno
 * como `clave` + `valor` concatenados sin separador), codificado en base64.
 * https://www.twilio.com/docs/usage/webhooks/webhook-security
 *
 * Sin esto, cualquiera que conozca la URL puede publicar mensajes falsos — `From` con el
 * teléfono de un usuario real incluido — y el ruteo por membresía (`InboundTenantRoutingService`)
 * los mete en su conversación/tenant real: un tercero podría conversar como esa persona y llevar
 * el flujo hasta `ticket_create` con su identidad.
 *
 * Deliberadamente NO corta si `TWILIO_WEBHOOK_PUBLIC_URL` no está configurada: solo advierte
 * (deuda conocida, igual que la falta de verificación que reemplaza) — así un despliegue que
 * todavía no cargó el setting no deja de recibir mensajes de la noche a la mañana. Con el
 * setting cargado, una firma ausente o inválida SÍ corta con 200 silencioso (mismo criterio que
 * el resto de los payloads descartados en estos webhooks: nunca se le da a un atacante una señal
 * distinguible de "acá hay algo que validar").
 *
 * El cálculo depende de conocer la URL EXACTA que Twilio vio (protocolo + host + path, sin
 * query string acá — estos webhooks no usan ninguno): por eso se arma desde
 * `TWILIO_WEBHOOK_PUBLIC_URL` (configurada a mano con la URL pública real) + `req.path`, no
 * desde `req.protocol`/`req.get('host')` — esos dependen de headers que un proxy/balanceador
 * intermedio puede no reenviar tal cual, y confiar en ellos sin `trust proxy` configurado a
 * propósito rompería la validación en cualquier despliegue detrás de uno.
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const [authToken, publicUrl] = await Promise.all([
      this.appConfig.get('TWILIO_AUTH_TOKEN'),
      this.appConfig.get('TWILIO_WEBHOOK_PUBLIC_URL'),
    ]);

    if (!authToken || !publicUrl) {
      this.logger.warn(
        `${req.path}: verificación de firma de Twilio desactivada (falta TWILIO_AUTH_TOKEN o ` +
          'TWILIO_WEBHOOK_PUBLIC_URL en /settings) — cualquiera que conozca la URL puede publicar mensajes falsos.',
      );
      return true;
    }

    const signature = req.header('X-Twilio-Signature');
    if (!signature) {
      this.logger.warn(`${req.path}: request sin X-Twilio-Signature — rechazada.`);
      return false;
    }

    const fullUrl = `${publicUrl.replace(/\/+$/, '')}${req.path}`;
    const valid = this.validateSignature(
      authToken,
      fullUrl,
      (req.body ?? {}) as Record<string, string>,
      signature,
    );
    if (!valid) {
      this.logger.warn(`${req.path}: X-Twilio-Signature inválida — request rechazada.`);
    }
    return valid;
  }

  private validateSignature(
    authToken: string,
    fullUrl: string,
    params: Record<string, string>,
    signature: string,
  ): boolean {
    let data = fullUrl;
    for (const key of Object.keys(params).sort()) {
      data += key + params[key];
    }
    const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');

    // Largo distinto antes de `timingSafeEqual`: exige el mismo tamaño de buffer, y una
    // `X-Twilio-Signature` corta/larga a mano no debería tirar, solo dar por inválida.
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    return expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);
  }
}
