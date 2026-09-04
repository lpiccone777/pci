import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';
import { GupshupFileLoggerService } from './gupshup-file-logger.service';
import { GupshupMediaService } from '../../common/gupshup-media.service';
import { StoredAttachment } from '../../common/media-storage.util';

interface GupshupInnerPayload {
  /** 'text' | 'button_reply' | 'list_reply' | 'image' | ... */
  type?: string;
  /**
   * Contenido real del mensaje — su forma varía según `type`, ver `extractBody`/`extractMedia`.
   * `url`/`contentType`/`caption` solo están presentes cuando `type === 'image'` (Gupshup docs
   * "Media", verificado 2026-08-26) — `url` es pública con expiración (`urlExpiry`, no
   * validado acá: si ya venció, `GupshupMediaService.downloadAndStore` simplemente falla y
   * el adjunto se pierde best-effort, mismo criterio que el resto de las integraciones.
   */
  payload?: { text?: string; postbackText?: string; url?: string; contentType?: string; caption?: string };
  sender?: { phone?: string };
}

/** Evento de estado de un mensaje SALIENTE (enqueued/sent/delivered/read/failed) — no confundir con un mensaje entrante. */
interface GupshupMessageEventPayload {
  /** 'enqueued' | 'sent' | 'delivered' | 'read' | 'failed' | ... */
  type?: string;
  /** Número destino del mensaje saliente al que corresponde este evento. */
  destination?: string;
  /** Solo presente cuando `type === 'failed'`: motivo del rechazo (ej. WhatsApp Error Code 131037). */
  payload?: { code?: number; reason?: string };
}

interface GupshupWebhookPayload {
  /** 'message' | 'message-event' | 'account-event' | 'user-event' | 'template-event' | 'billing-event' */
  type?: string;
  payload?: GupshupInnerPayload | GupshupMessageEventPayload;
}

/**
 * Webhook de Gupshup — equivalente a `WhatsAppWebhookController` (Meta) y `TwilioWebhookController`,
 * para el conector de Gupshup. Sin handshake de verificación (como Twilio, a diferencia de Meta):
 * la URL se pega directo en la pestaña "Webhooks" del panel de Gupshup y ya empieza a mandar `POST`s.
 *
 * Shape verificado contra docs.gupshup.io (Understanding Inbound Message / Message Type: Inbound,
 * 2026-08-14) — sin firma que validar todavía, mismo tipo de deuda que el resto de los webhooks
 * de este proyecto.
 */
@Controller('webhooks/gupshup')
export class GupshupWebhookController {
  private readonly logger = new Logger(GupshupWebhookController.name);

  // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
  // (ver InboundTenantRoutingService), no acá — por eso `receive()` publica sin `tenantId`.
  // `AppConfigService`/`PrismaService` (para el viejo `GUPSHUP_WHATSAPP_TENANT_ID`/"empresa más
  // antigua") ya no hacen falta acá: los sacó el ruteo por membresía.
  constructor(
    private readonly broker: BrokerService,
    private readonly fileLog: GupshupFileLoggerService,
    private readonly gupshupMedia: GupshupMediaService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() payload: GupshupWebhookPayload) {
    this.fileLog.log('webhook.received', { type: payload?.type, raw: payload });

    // `payload` puede llegar undefined si el body no se pudo parsear (ej. Content-Type inesperado).
    if (!payload) return { status: 'ok' };

    // Evento de estado de un mensaje SALIENTE (el que nosotros mandamos como respuesta) — no es
    // un mensaje entrante. Solo nos interesa loguear los rechazos: son la única forma de enterarse
    // de que WhatsApp no entregó la respuesta del bot (ej. Error 131037, display name del número
    // sin aprobar todavía — ver commit 2026-08-26). El resto (enqueued/sent/delivered/read) se ignora.
    if (payload.type === 'message-event') {
      const event = payload.payload as GupshupMessageEventPayload | undefined;
      if (event?.type === 'failed') {
        const reason = event.payload?.reason ?? `código ${event.payload?.code ?? 'desconocido'}`;
        this.logger.warn(`Envío de WhatsApp (Gupshup) rechazado para ${event.destination ?? '(destino desconocido)'}: ${reason}`);
        this.fileLog.log('delivery.failed', { destination: event.destination, code: event.payload?.code, reason });
      }
      return { status: 'ok' };
    }

    // Gupshup manda otros `type` de evento por el mismo webhook (plantilla, cuenta, facturación)
    // aparte de 'message' (entrante) y 'message-event' (ya manejado arriba) — el resto se descarta.
    if (payload.type !== 'message') {
      return { status: 'ok' };
    }

    // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
    // (ver InboundTenantRoutingService), no acá — por eso se publica sin `tenantId`.
    const inbound = payload.payload as GupshupInnerPayload | undefined;
    const from = inbound?.sender?.phone;
    const body = this.extractBody(inbound);
    const attachments = await this.extractMedia(inbound);

    // Solo se descarta si no hay remitente, o si no hay ni texto ni adjuntos — un mensaje
    // solo-imagen (sin caption) sigue de largo igual, mismo criterio que
    // `TwilioWebhookController.receive` (ver `ConversationsService.handleMessage`,
    // `flowState.pendingAttachments`).
    if (!from || (body === null && !attachments.length)) {
      this.logger.warn(
        `Mensaje de Gupshup ignorado (tipo '${inbound?.type}' no soportado o sin remitente).`,
      );
      this.fileLog.log('inbound.ignored', { innerType: inbound?.type, hasFrom: !!from });
      return { status: 'ok' };
    }

    this.fileLog.log('inbound.processed', { from, body, attachments: attachments.length });

    await this.broker.publish('whatsapp.incoming', {
      pattern: 'message.received',
      data: { from: `+${from}`, body: body ?? '', channel: 'whatsapp', attachments },
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  /**
   * Texto plano equivalente, mismo criterio que `WhatsAppWebhookController.extractBody`: para
   * una respuesta de botón/lista devuelve `postbackText` (el `id` con el que armamos la opción
   * al mandarla, ver `GupshupWhatsAppService.buildInteractiveMessage`), no el título visible —
   * así el nodo `menu` la matchea sin cambios. Para una imagen, el `caption` (puede ser `''` si
   * no tiene — no confundir con `null`, que significa "tipo no soportado, descartar").
   */
  private extractBody(inner?: GupshupInnerPayload): string | null {
    if (!inner) return null;
    if (inner.type === 'button_reply' || inner.type === 'list_reply') {
      return inner.payload?.postbackText ?? inner.payload?.text ?? null;
    }
    if (inner.type === 'text') return inner.payload?.text ?? null;
    if (inner.type === 'image') return inner.payload?.caption ?? '';
    return null;
  }

  /** Descarga la imagen adjunta, si el mensaje es de tipo `image` — ver `GupshupMediaService`. */
  private async extractMedia(inner?: GupshupInnerPayload): Promise<StoredAttachment[]> {
    if (inner?.type !== 'image' || !inner.payload?.url) return [];
    const stored = await this.gupshupMedia.downloadAndStore(inner.payload.url, inner.payload.contentType);
    return stored ? [stored] : [];
  }
}
