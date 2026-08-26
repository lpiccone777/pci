import { Body, Controller, Headers, HttpCode, Logger, Post } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';

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

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Headers('content-type') contentType: string,
    @Body() payload: GupshupWebhookPayload,
  ) {
    // TEMPORAL (debug entrega de webhook, 2026-08-26): loguea qué llega realmente antes de
    // cualquier early-return, para confirmar si Gupshup manda el Content-Type que esperamos
    // (`express.json()` en main.ts solo parsea el body si el header dice `application/json` —
    // si Gupshup manda otra cosa, `payload` llega vacío/undefined y esto se descarta en
    // silencio). Sacar esta línea una vez confirmado.
    this.logger.debug(`Webhook Gupshup — Content-Type: '${contentType}' — body: ${JSON.stringify(payload)}`);

    // Gupshup manda varios `type` de evento por el mismo webhook (entrega, plantilla, cuenta,
    // facturación) — solo nos importan los mensajes reales entrantes, el resto se descarta.
    // `payload` puede llegar undefined si el body no se pudo parsear (ver nota arriba).
    if (!payload || payload.type !== 'message') {
      return { status: 'ok' };
    }

    const tenantId = await this.resolveTenantId();
    if (!tenantId) {
      this.logger.error(
        'Mensaje de Gupshup recibido pero no hay tenant configurado ' +
          '(GUPSHUP_WHATSAPP_TENANT_ID en /settings, ni ningún tenant en el sistema).',
      );
      return { status: 'ignored' };
    }

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
      tenantId,
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

  /** A qué tenant se asignan los mensajes entrantes. Mismo criterio que `WhatsAppWebhookController.resolveTenantId`. */
  private async resolveTenantId(): Promise<string | null> {
    const configured = await this.appConfig.get('GUPSHUP_WHATSAPP_TENANT_ID');
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
