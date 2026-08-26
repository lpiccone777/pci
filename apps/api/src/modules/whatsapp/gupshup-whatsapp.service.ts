import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { WhatsAppInteractive } from './whatsapp-interactive.types';
import { GupshupFileLoggerService } from './gupshup-file-logger.service';

const TIMEOUT_MS = 10_000;
const API_URL = 'https://api.gupshup.io/wa/api/v1/msg';

interface GupshupCredentials {
  apiKey: string;
  source: string;
  appName: string;
}

/**
 * Conector alternativo de WhatsApp vía Gupshup — mismo contrato de colas que `WhatsAppService`
 * (Meta) y `TwilioWhatsAppService` (`whatsapp.outgoing`/`whatsapp.incoming`), elegido con
 * `WHATSAPP_PROVIDER=gupshup`.
 *
 * A diferencia de Twilio (que exige un Content Template pre-registrado para mandar botones/
 * listas — ver `TwilioWhatsAppService.resolveContentSid`), la API de Gupshup manda el mensaje
 * interactivo INLINE en el mismo request, igual de simple que Meta: sin caché, sin BD, sin
 * llamada extra a una Content API.
 *
 * Spec verificado contra docs.gupshup.io (2026-08-14): `/reference/msg`, `/reference/quick-replies`
 * y `/reference/post_wa-api-v1-msg-1` (list). El shape del webhook entrante (`GupshupWebhookController`)
 * también sale de esas mismas páginas.
 */
@Injectable()
export class GupshupWhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(GupshupWhatsAppService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly fileLog: GupshupFileLoggerService,
  ) {}

  /**
   * Solo se suscribe si es el proveedor activo (`WHATSAPP_PROVIDER=gupshup`) — mismo chequeo,
   * invertido, en `WhatsAppService`/`TwilioWhatsAppService.onModuleInit`. Con los tres conectores
   * escuchando la misma cola a la vez, RabbitMQ los repartiría por competencia en vez de que uno
   * solo la maneje.
   */
  async onModuleInit() {
    const provider = (await this.appConfig.get('WHATSAPP_PROVIDER', 'meta'))?.toLowerCase() || 'meta';
    if (provider !== 'gupshup') {
      this.logger.log(
        `WHATSAPP_PROVIDER=${provider}: conector de Gupshup inactivo, no se suscribe a whatsapp.outgoing.`,
      );
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

  private async credentials(): Promise<GupshupCredentials | null> {
    const [apiKey, source, appName] = await Promise.all([
      this.appConfig.get('GUPSHUP_API_KEY'),
      this.appConfig.get('GUPSHUP_WHATSAPP_SOURCE'),
      this.appConfig.get('GUPSHUP_APP_NAME'),
    ]);
    if (!apiKey || !source || !appName) return null;
    return { apiKey, source, appName };
  }

  async sendText(to: string, body: string, interactive?: WhatsAppInteractive): Promise<void> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo enviar WhatsApp (Gupshup) a ${to}: falta GUPSHUP_API_KEY, ` +
          'GUPSHUP_WHATSAPP_SOURCE o GUPSHUP_APP_NAME en /settings.',
      );
      this.fileLog.log('send.missing_credentials', { to });
      return;
    }

    const message = interactive ? this.buildInteractiveMessage(body, interactive) : { type: 'text', text: body };

    const params = new URLSearchParams({
      channel: 'whatsapp',
      source: this.normalizeRecipient(creds.source),
      destination: this.normalizeRecipient(to),
      'src.name': creds.appName,
      message: JSON.stringify(message),
    });

    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          apikey: creds.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`No se pudo contactar la API de Gupshup: ${(err as Error).message}`);
      this.fileLog.log('send.network_error', { to, error: (err as Error).message });
      throw err;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Gupshup API respondió ${res.status} al mandarle a ${to}: ${detail.slice(0, 500)}`);
      this.fileLog.log('send.api_error', { to, status: res.status, detail: detail.slice(0, 500) });
      throw new Error(`Gupshup API error ${res.status}`);
    }

    this.fileLog.log('send.accepted', { to, body });
  }

  /**
   * Traduce `WhatsAppInteractive` al formato de mensaje interactivo de Gupshup. `postbackText`
   * es lo que Gupshup devuelve en el webhook cuando el usuario toca una opción (ver
   * `GupshupWebhookController.extractBody`) — ahí va el `id` de cada botón/fila, NUNCA el
   * título, para que el nodo `menu` la matchee igual que con Meta/Twilio.
   *
   * El campo `title` a nivel de la lista (requerido por el schema de Gupshup, es el header que
   * se muestra arriba del body) no tiene equivalente en `WhatsAppInteractive` — no hay concepto
   * de "header" separado del body en Meta/Twilio. Se reusa `buttonText` ahí; cosmético nada más
   * (puede leerse redundante con el botón de abajo), pero funcionalmente inofensivo. Confirmar
   * contra tráfico real del sandbox antes de depender de esto en producción.
   */
  private buildInteractiveMessage(body: string, interactive: WhatsAppInteractive) {
    if (interactive.type === 'button') {
      return {
        type: 'quick_reply',
        content: { type: 'text', text: body },
        options: interactive.buttons.map((b) => ({
          type: 'text',
          title: b.title.slice(0, 20),
          postbackText: b.id,
        })),
      };
    }
    return {
      type: 'list',
      title: interactive.buttonText,
      body,
      msgid: randomUUID(),
      globalButtons: [{ type: 'text', title: interactive.buttonText.slice(0, 20) }],
      items: [
        {
          title: 'Opciones',
          options: interactive.rows.map((r) => ({
            type: 'text',
            title: r.title.slice(0, 24),
            description: r.description ?? '',
            postbackText: r.id,
          })),
        },
      ],
    };
  }

  /** La API de Gupshup espera el número sin "+" ni separadores, igual que la Graph API de Meta. */
  private normalizeRecipient(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }
}
