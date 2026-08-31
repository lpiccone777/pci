import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';

interface GupshupInnerPayload {
  /** 'text' | 'button_reply' | 'list_reply' | 'image' | ... */
  type?: string;
  /** Contenido real del mensaje — su forma varía según `type`, ver `extractBody`. */
  payload?: { text?: string; postbackText?: string };
  sender?: { phone?: string };
}

interface GupshupWebhookPayload {
  /** 'message' | 'message-event' | 'account-event' | 'user-event' | 'template-event' | 'billing-event' */
  type?: string;
  payload?: GupshupInnerPayload;
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

  constructor(private readonly broker: BrokerService) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() payload: GupshupWebhookPayload) {
    // Gupshup manda varios `type` de evento por el mismo webhook (entrega, plantilla, cuenta,
    // facturación) — solo nos importan los mensajes reales entrantes, el resto se descarta.
    if (payload.type !== 'message') {
      return { status: 'ok' };
    }

    // La empresa que atiende el mensaje se resuelve aguas abajo por la membresía del teléfono
    // (ver InboundTenantRoutingService), no acá — por eso se publica sin `tenantId`.
    const from = payload.payload?.sender?.phone;
    const body = this.extractBody(payload.payload);
    if (!from || body === null) {
      this.logger.warn(
        `Mensaje de Gupshup ignorado (tipo '${payload.payload?.type}' no soportado o sin remitente).`,
      );
      return { status: 'ok' };
    }

    await this.broker.publish('whatsapp.incoming', {
      pattern: 'message.received',
      data: { from: `+${from}`, body, channel: 'whatsapp' },
      timestamp: new Date().toISOString(),
    });

    return { status: 'ok' };
  }

  /**
   * Texto plano equivalente, mismo criterio que `WhatsAppWebhookController.extractBody`: para
   * una respuesta de botón/lista devuelve `postbackText` (el `id` con el que armamos la opción
   * al mandarla, ver `GupshupWhatsAppService.buildInteractiveMessage`), no el título visible —
   * así el nodo `menu` la matchea sin cambios.
   */
  private extractBody(inner?: GupshupInnerPayload): string | null {
    if (!inner) return null;
    if (inner.type === 'button_reply' || inner.type === 'list_reply') {
      return inner.payload?.postbackText ?? inner.payload?.text ?? null;
    }
    if (inner.type === 'text') return inner.payload?.text ?? null;
    return null;
  }
}
