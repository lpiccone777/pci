import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';
import { TwilioMediaService, StoredAttachment } from '../../common/twilio-media.service';

interface TwilioIncomingPayload {
  From?: string;
  Body?: string;
  /** Tap de un quick-reply (Content API): id de la opción — `Body` trae solo el TÍTULO visible. */
  ButtonPayload?: string;
  /** Tap de una fila de list-picker (Content API): id de la fila elegida. */
  ListId?: string;
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
    private readonly broker: BrokerService,
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
    // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
    // (ver InboundTenantRoutingService), no acá — por eso se publica sin `tenantId`.
    const from = this.extractFrom(payload.From);
    // Para una respuesta de botón/lista se publica el ID de la opción (`ButtonPayload`/`ListId`),
    // no el título visible que Twilio pone en `Body` — mismo criterio que Meta y Gupshup
    // (`extractBody` devuelve `reply.id`/`postbackText`): así el nodo `menu` y el selector de
    // empresa matchean por id sin depender del texto truncado del botón.
    const body = (payload.ButtonPayload ?? payload.ListId ?? payload.Body ?? '').trim();
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
}
