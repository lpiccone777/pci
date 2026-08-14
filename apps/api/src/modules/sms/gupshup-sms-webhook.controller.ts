import { Body, Controller, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';

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

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: Record<string, string>, @Query() query: Record<string, string>) {
    const params = { ...query, ...body };

    const tenantId = await this.resolveTenantId();
    if (!tenantId) {
      this.logger.error(
        'SMS de Gupshup recibido pero no hay tenant configurado (GUPSHUP_SMS_TENANT_ID en ' +
          '/settings, ni ningún tenant en el sistema).',
      );
      return { status: 'ignored' };
    }

    const from = (params.phno ?? params.mobile ?? params.from ?? params.sender ?? '').trim();
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
      tenantId,
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  private async resolveTenantId(): Promise<string | null> {
    const configured = await this.appConfig.get('GUPSHUP_SMS_TENANT_ID');
    if (configured) return configured;

    const first = await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    return first?.id ?? null;
  }
}
