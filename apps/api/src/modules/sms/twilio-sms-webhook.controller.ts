import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';
import { TwilioMediaService, StoredAttachment } from '../../common/twilio-media.service';

interface TwilioSmsIncomingPayload {
  From?: string;
  Body?: string;
  NumMedia?: string;
  /** `MediaUrl0`..`MediaUrl9`/`MediaContentType0`..`MediaContentType9` (MMS) — accedidos por índice, ver `extractMedia`. */
  [key: string]: string | undefined;
}

/** Twilio manda hasta 10 adjuntos por mensaje (`MediaUrl0`..`MediaUrl9`). */
const MAX_MEDIA_ITEMS = 10;

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
    private readonly broker: BrokerService,
    private readonly twilioMedia: TwilioMediaService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() payload: TwilioSmsIncomingPayload) {
    // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
    // (ver InboundTenantRoutingService), no acá — por eso se publica sin `tenantId`.
    const from = payload.From?.trim();
    const body = (payload.Body ?? '').trim();
    const attachments = await this.extractMedia(payload);

    // Solo se descarta si no hay ni texto ni adjuntos (MMS) — ver el mismo criterio
    // en TwilioWebhookController.
    if (!from || (!body && !attachments.length)) {
      this.logger.warn(`SMS ignorado (sin From, o sin Body ni adjuntos; NumMedia=${payload.NumMedia ?? '0'}).`);
      return { status: 'ok' };
    }

    await this.broker.publish('sms.incoming', {
      pattern: 'message.received',
      data: { from, body, channel: 'sms', attachments },
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  /** Mismo mecanismo que `TwilioWebhookController.extractMedia` — Twilio manda MMS con la misma forma que WhatsApp media. */
  private async extractMedia(payload: TwilioSmsIncomingPayload) {
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
}
