import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';

interface TwilioSmsIncomingPayload {
  From?: string;
  Body?: string;
  NumMedia?: string;
}

/**
 * Webhook de SMS entrante de Twilio. Mismo criterio que `TwilioWebhookController` (WhatsApp):
 * sin handshake de verificación (la URL se pega directo en la consola de Twilio, en el número
 * de SMS, no en el sandbox de WhatsApp), y sin verificación de firma (`X-Twilio-Signature`)
 * todavía — mismo tipo de deuda técnica que el resto de los webhooks.
 *
 * A diferencia del de WhatsApp, `From` ya viene en E.164 plano — Twilio no le agrega ningún
 * prefijo de canal a los SMS, así que no hay nada que sacarle.
 */
@Controller('webhooks/twilio-sms')
export class TwilioSmsWebhookController {
  private readonly logger = new Logger(TwilioSmsWebhookController.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() payload: TwilioSmsIncomingPayload) {
    const tenantId = await this.resolveTenantId();
    if (!tenantId) {
      this.logger.error(
        'SMS recibido pero no hay tenant configurado (TWILIO_SMS_TENANT_ID en /settings, ' +
          'ni ningún tenant en el sistema).',
      );
      return { status: 'ignored' };
    }

    const from = payload.From?.trim();
    const body = (payload.Body ?? '').trim();

    if (!from || !body) {
      this.logger.warn(
        `SMS ignorado (sin From o sin Body; NumMedia=${payload.NumMedia ?? '0'}) — sin ` +
          'pipeline de MMS todavía.',
      );
      return { status: 'ok' };
    }

    await this.broker.publish('sms.incoming', {
      pattern: 'message.received',
      data: { from, body, channel: 'sms' },
      tenantId,
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  /** Mismo criterio que el resto de los webhooks: A qué tenant se asignan los mensajes entrantes por este número. */
  private async resolveTenantId(): Promise<string | null> {
    const configured = await this.appConfig.get('TWILIO_SMS_TENANT_ID');
    if (configured) return configured;

    const first = await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    return first?.id ?? null;
  }
}
