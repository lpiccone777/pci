import { Body, Controller, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Webhook de SMS ENTRANTE de Gupshup — a diferencia del resto de los webhooks de este proyecto
 * (Meta, Twilio-WhatsApp, Twilio-SMS, Gupshup-WhatsApp), el shape exacto de ESTE payload NO se
 * pudo verificar contra documentación pública completa.
 *
 * `GupshupSmsService` manda el saliente por el endpoint unificado (`api.gupshup.io/wa/api/v1/msg`,
 * `channel: 'sms'`) — el mismo que usa `GupshupWhatsAppService` para WhatsApp. Es una posibilidad
 * real (sin confirmar todavía) que las respuestas entrantes de SMS lleguen por ESE MISMO webhook
 * (`GupshupWebhookController`, `/webhooks/gupshup`) en vez de acá, distinguidas por algún campo
 * tipo `type`/`channel` en el payload — recién se sabrá con tráfico real. Mientras tanto este
 * controller queda activo como fallback de mejor esfuerzo, con varios nombres de campo candidatos
 * (`phno`/`mobile`/`from`/`sender` para el remitente; `text`/`msg`/`message` para el cuerpo), y
 * logueando los campos recibidos en cada intento fallido para ajustar el mapeo rápido.
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

    // Sin esto, si la empresa más vieja se da de baja, los mensajes entrantes le siguen
    // resolviendo a ella y `ConversationsService.handleMessage` los descarta en silencio.
    const first = await this.prisma.tenant.findFirst({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return first?.id ?? null;
  }
}
