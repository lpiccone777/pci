import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { WhatsAppInteractive } from './whatsapp-interactive.types';

const TIMEOUT_MS = 10_000;

/**
 * Conector real de WhatsApp Business (Cloud API de Meta). Consume `whatsapp.outgoing`
 * (hasta ahora nadie lo hacía: `ChannelsService`/`ConversationsService` publicaban ahí
 * y los mensajes se perdían) y llama a `graph.facebook.com/{version}/{phoneNumberId}/messages`.
 */
@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
  ) {}

  /**
   * Solo se suscribe si es el proveedor activo (`WHATSAPP_PROVIDER`, default 'meta') — con
   * `TwilioWhatsAppService` también escuchando la misma cola, dos consumers activos a la vez
   * se la repartirían por competencia (round robin de RabbitMQ) en vez de que uno solo la
   * maneje. Ver el mismo chequeo, invertido, en `TwilioWhatsAppService.onModuleInit`.
   */
  async onModuleInit() {
    const provider = (await this.appConfig.get('WHATSAPP_PROVIDER', 'meta'))?.toLowerCase() || 'meta';
    if (provider !== 'meta') {
      this.logger.log(`WHATSAPP_PROVIDER=${provider}: conector de Meta inactivo, no se suscribe a whatsapp.outgoing.`);
      return;
    }
    await this.broker.subscribe('whatsapp.outgoing', this.handleOutgoing.bind(this));
  }

  private async handleOutgoing(msg: BrokerMessage) {
    const { to, body, interactive } = msg.data as {
      to: string;
      body: string;
      interactive?: WhatsAppInteractive;
    };
    await this.sendText(to, body, interactive);
  }

  /**
   * Manda un mensaje de texto libre, o uno interactivo (botones/lista) si se pasa
   * `interactive`. Solo funciona dentro de la ventana de 24hs desde el último
   * mensaje del usuario (política de Meta) — para mensajes iniciados por el
   * negocio fuera de esa ventana hace falta un `template` aprobado, no soportado
   * acá todavía.
   */
  async sendText(to: string, body: string, interactive?: WhatsAppInteractive): Promise<void> {
    const [token, phoneNumberId, version] = await Promise.all([
      this.appConfig.get('WHATSAPP_API_TOKEN'),
      this.appConfig.get('WHATSAPP_PHONE_NUMBER_ID'),
      this.appConfig.get('WHATSAPP_API_VERSION', 'v26.0'),
    ]);

    if (!token || !phoneNumberId) {
      // `error`, no `warn`: acá se pierde la respuesta del bot para este consultante — no hay
      // forma de avisarle por el mismo canal que está roto, así que lo mínimo es que esta falla
      // sea tan visible como cualquier otra de entrega (mismo nivel que el error de red/API de
      // abajo), no un warning fácil de pasar por alto en un log ruidoso.
      this.logger.error(
        `No se pudo enviar WhatsApp a ${to}: falta WHATSAPP_API_TOKEN o ` +
          'WHATSAPP_PHONE_NUMBER_ID en /settings. El consultante se queda sin la respuesta del bot.',
      );
      return;
    }

    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
    const recipient = await this.resolveRecipient(to);

    const payload = interactive
      ? {
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'interactive',
          interactive: this.buildInteractivePayload(interactive),
        }
      : {
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { body },
        };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`No se pudo contactar la API de WhatsApp: ${(err as Error).message}`);
      throw err;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // DEUDA TÉCNICA (no crítico hoy): un 429 de Meta (rate limit) cae acá igual que cualquier
      // otro error — se loguea y el mensaje se pierde (el broker lo nackea sin reintentar, ver
      // `BrokerService.safeNack`), sin backoff ni respetar el header `Retry-After` que manda la
      // Cloud API. Bajo volumen esto no importa; si el envío escala, hace falta un manejo
      // específico de 429 (reintento con backoff, o encolar para reenviar más tarde).
      this.logger.error(
        `WhatsApp API respondió ${res.status} al mandarle a ${to}: ${detail.slice(0, 500)}`,
      );
      throw new Error(`WhatsApp API error ${res.status}`);
    }
  }

  /** Traduce nuestro payload interno al formato `interactive` de la Cloud API. */
  private buildInteractivePayload(interactive: WhatsAppInteractive) {
    if (interactive.type === 'button') {
      return {
        type: 'button',
        body: { text: interactive.body },
        action: {
          buttons: interactive.buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      };
    }
    return {
      type: 'list',
      body: { text: interactive.body },
      action: {
        button: interactive.buttonText,
        sections: [
          {
            rows: interactive.rows.map((r) => ({
              id: r.id,
              title: r.title,
              description: r.description,
            })),
          },
        ],
      },
    };
  }

  /** La Cloud API espera el número en formato E.164 sin "+" ni separadores. */
  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }

  /**
   * Excepción puntual de testing: algunos números de sandbox quedan registrados
   * en Meta con un formato distinto al E.164 estándar que llega por el webhook
   * (visto con un número AR: WhatsApp lo identifica con el "9" móvil, pero la
   * lista de destinatarios de prueba lo tiene guardado sin el "9" y con "15"
   * insertado — `/messages` rechaza el formato con "9" con error 131030).
   * `WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES` en `.env` mapea el número normalizado
   * que llega del webhook al que realmente acepta el envío, ej:
   * "5491158855098:54111558855098". No es una regla general de Argentina —
   * cada número de sandbox puede necesitar su propio override, o ninguno.
   */
  private async resolveRecipient(phone: string): Promise<string> {
    const normalized = this.normalizePhone(phone);
    const overrides = (await this.appConfig.get('WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES')) ?? '';
    for (const pair of overrides.split(',').filter(Boolean)) {
      const [from, to] = pair.split(':').map((s) => s.trim());
      if (from === normalized && to) return to;
    }
    return normalized;
  }
}
