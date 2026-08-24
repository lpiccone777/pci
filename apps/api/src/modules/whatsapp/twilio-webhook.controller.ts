import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TwilioMediaService, StoredAttachment } from '../../common/twilio-media.service';

interface TwilioIncomingPayload {
  From?: string;
  Body?: string;
  NumMedia?: string;
  /** `MediaUrl0`..`MediaUrl9`/`MediaContentType0`..`MediaContentType9` — accedidos por índice, ver `extractMedia`. */
  [key: string]: string | undefined;
}

/** Twilio manda hasta 10 adjuntos por mensaje (`MediaUrl0`..`MediaUrl9`). */
const MAX_MEDIA_ITEMS = 10;

/**
 * Webhook de Twilio — equivalente a `WhatsAppWebhookController` pero para el conector de
 * Twilio. A diferencia de Meta, Twilio no exige un handshake de verificación (`GET` con
 * `hub.challenge`): la URL se pega directo en la consola de Twilio (Messaging > Try it out /
 * WhatsApp Sandbox Settings, o el número de producción) y ya empieza a mandar `POST`s.
 */
@Controller('webhooks/twilio')
export class TwilioWebhookController {
  private readonly logger = new Logger(TwilioWebhookController.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
    private readonly twilioMedia: TwilioMediaService,
  ) {}

  /**
   * Mensajes reales entrantes. Twilio manda `application/x-www-form-urlencoded`, no JSON
   * (Nest ya lo parsea con el body parser default de Express, igual que el JSON de Meta).
   *
   * Sin verificación de firma (`X-Twilio-Signature`) todavía — mismo tipo de deuda que
   * `WhatsAppWebhookController`: hoy cualquiera que conozca la URL puede publicar mensajes
   * falsos en `whatsapp.incoming`.
   */
  @Post()
  @HttpCode(200)
  async receive(@Body() payload: TwilioIncomingPayload) {
    const tenantId = await this.resolveTenantId();
    if (!tenantId) {
      this.logger.error(
        'Mensaje de Twilio recibido pero no hay tenant configurado ' +
          '(TWILIO_TENANT_ID en /settings, ni ningún tenant en el sistema).',
      );
      return { status: 'ignored' };
    }

    const from = this.extractFrom(payload.From);
    const body = (payload.Body ?? '').trim();
    const attachments = await this.extractMedia(payload);

    // Solo se descarta si no hay ni texto ni adjuntos — un mensaje solo-imagen (sin
    // caption) ahora sí sigue de largo, para poder guardar la imagen igual (ver
    // ConversationsService.handleMessage, flowState.pendingAttachments).
    if (!from || (!body && !attachments.length)) {
      this.logger.warn(
        `Mensaje de Twilio ignorado (sin From, o sin Body ni adjuntos; NumMedia=${payload.NumMedia ?? '0'}).`,
      );
      return { status: 'ok' };
    }

    await this.broker.publish('whatsapp.incoming', {
      pattern: 'message.received',
      data: { from, body, channel: 'whatsapp', attachments },
      tenantId,
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  /**
   * Descarga cada `MediaUrl{i}` que Twilio haya mandado (hasta `NumMedia`, tope
   * `MAX_MEDIA_ITEMS`) y las guarda en disco — ver `TwilioMediaService`. Best-effort por
   * adjunto: uno que falle no tira abajo los demás ni el mensaje.
   */
  private async extractMedia(payload: TwilioIncomingPayload) {
    const count = Math.min(Number(payload.NumMedia) || 0, MAX_MEDIA_ITEMS);
    const stored: StoredAttachment[] = [];
    for (let i = 0; i < count; i++) {
      const url = payload[`MediaUrl${i}`];
      if (!url) continue;
      const contentType = payload[`MediaContentType${i}`];
      const result = await this.twilioMedia.downloadAndStore(url, contentType);
      if (result) stored.push(result);
    }
    return stored;
  }

  /** Twilio manda el remitente como `whatsapp:+549...` — le sacamos el prefijo de canal. */
  private extractFrom(from?: string): string | null {
    if (!from) return null;
    return from.replace(/^whatsapp:/, '') || null;
  }

  /** A qué tenant se asignan los mensajes entrantes. Mismo criterio que `WhatsAppWebhookController.resolveTenantId`. */
  private async resolveTenantId(): Promise<string | null> {
    const configured = await this.appConfig.get('TWILIO_TENANT_ID');
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
