import { Body, Controller, ForbiddenException, Get, HttpCode, Logger, Post, Query } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';

interface WhatsAppIncomingMessage {
  from: string;
  type: string;
  text?: { body: string };
  /** Respuesta a un mensaje `interactive` (botones o lista) enviado por el bot. */
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
}

interface WhatsAppWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppIncomingMessage[];
      };
    }>;
  }>;
}

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Handshake que hace Meta al guardar la URL del webhook en Meta for Developers.
   * Sin JwtAuthGuard a propósito — Meta no manda ningún token nuestro acá; la
   * única prueba de que somos el dueño del endpoint es devolver el challenge
   * sabiendo el verify token que configuramos nosotros mismos en /settings.
   */
  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): Promise<string> {
    const expected = await this.appConfig.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected) {
      this.logger.log('Webhook de WhatsApp verificado por Meta.');
      return challenge;
    }
    this.logger.warn('Verificación de webhook de WhatsApp rechazada: verify_token no coincide.');
    throw new ForbiddenException('verify_token inválido');
  }

  /**
   * Mensajes reales entrantes. Sin verificación de firma (`X-Hub-Signature-256`
   * con el App Secret de Meta) todavía — pendiente antes de exponerlo más allá de
   * una prueba acotada: hoy cualquiera que conozca la URL puede publicar mensajes
   * falsos en `whatsapp.incoming`, mismo tipo de deuda que `/conversations/simulate`.
   */
  @Post()
  @HttpCode(200)
  async receive(@Body() payload: WhatsAppWebhookPayload) {
    const tenantId = await this.resolveTenantId();
    if (!tenantId) {
      this.logger.error(
        'Mensaje de WhatsApp recibido pero no hay tenant configurado ' +
          '(WHATSAPP_TENANT_ID en /settings, ni ningún tenant en el sistema).',
      );
      return { status: 'ignored' };
    }

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) {
          const body = this.extractBody(message);
          if (body === null) {
            this.logger.warn(
              `Mensaje de WhatsApp tipo '${message.type}' ignorado (no es texto ni respuesta interactiva soportada).`,
            );
            continue;
          }

          await this.broker.publish('whatsapp.incoming', {
            pattern: 'message.received',
            data: { from: `+${message.from}`, body },
            tenantId,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // Meta reintenta si no devolvemos 200 rápido. Siempre 200, incluso para
    // payloads sin `messages` (ej. `statuses`: confirmaciones de entrega/lectura,
    // que no generan nada acá).
    return { status: 'ok' };
  }

  /**
   * Texto plano equivalente al mensaje entrante. Para una respuesta de botón/lista
   * es el `id` de la opción elegida (el mismo `value` con el que el nodo `menu`
   * armó los botones), así el motor de flujos la matchea sin cambios.
   */
  private extractBody(message: WhatsAppIncomingMessage): string | null {
    if (message.type === 'text' && message.text?.body) return message.text.body;
    if (message.type === 'interactive') {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) return reply.id;
    }
    return null;
  }

  /**
   * A qué tenant se asignan los mensajes entrantes. Limitación temporal: los
   * settings todavía son globales (no por tenant), así que un solo número de
   * WhatsApp sirve a un solo tenant. Sin `WHATSAPP_TENANT_ID`, cae al tenant más
   * antiguo para no romper en desarrollo con uno solo.
   */
  private async resolveTenantId(): Promise<string | null> {
    const configured = await this.appConfig.get('WHATSAPP_TENANT_ID');
    if (configured) return configured;

    const first = await this.prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    return first?.id ?? null;
  }
}
