import { Body, Controller, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';

/**
 * Webhook de SMS ENTRANTE de Gupshup (API legacy "Enterprise SMS") — a diferencia del resto de
 * los webhooks de este proyecto (Meta, Twilio-WhatsApp, Twilio-SMS, Gupshup-WhatsApp), el shape
 * exacto de ESTE payload NO se pudo verificar contra documentación pública completa: Gupshup
 * documenta bien el callback de REPORTE DE ENTREGA (delivery report, con params `pcode`/`phno`)
 * pero no publica con la misma claridad el de RESPUESTA ENTRANTE de un usuario (two-way SMS).
 *
 * ⚠️ Sin confirmar contra tráfico real todavía. Acepta tanto query params como body (Gupshup
 * legacy suele mandar GET) y varios nombres de campo candidatos como mejor esfuerzo
 * (`phno`/`mobile`/`from`/`sender` para el remitente; `text`/`msg`/`message` para el cuerpo).
 * Cuando haya cuenta real, revisar la pestaña de configuración de "Two-Way SMS"/callback del
 * panel de Gupshup Enterprise — ahí muestran el formato exacto — y loguea los campos recibidos
 * en cada intento fallido para poder ajustar el mapeo rápido con tráfico real.
 */
@Controller('webhooks/gupshup-sms')
export class GupshupSmsWebhookController {
  private readonly logger = new Logger(GupshupSmsWebhookController.name);

  constructor(private readonly broker: BrokerService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: Record<string, string>, @Query() query: Record<string, string>) {
    const params = { ...query, ...body };

    // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
    // (ver InboundTenantRoutingService), no acá — por eso se publica sin `tenantId`.
    const rawFrom = (params.phno ?? params.mobile ?? params.from ?? params.sender ?? '').trim();
    // Gupshup manda el número SIN '+' inicial, pero `User.phone` se guarda en +E.164 y ahora es
    // la clave del ruteo por membresía: sin normalizar, ningún usuario registrado matcheaba y
    // todos caían al tenant de los desconocidos (mismo compensado que hace el webhook de
    // Gupshup WhatsApp con `+${from}`).
    const from = rawFrom && !rawFrom.startsWith('+') ? `+${rawFrom}` : rawFrom;
    const text = (params.text ?? params.msg ?? params.message ?? '').trim();

    if (!from || !text) {
      this.logger.warn(
        `SMS de Gupshup ignorado — payload sin From/Body reconocible (campos recibidos: ` +
          `${Object.keys(params).join(', ') || '(vacío)'}). Ver el comentario de esta clase: ` +
          'el shape de este webhook no está verificado todavía contra tráfico real.',
      );
      return { status: 'ok' };
    }

    await this.broker.publish('sms.incoming', {
      pattern: 'message.received',
      data: { from, body: text, channel: 'sms' },
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }
}
