import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { WhatsAppInteractive } from '../whatsapp/whatsapp-interactive.types';

const TIMEOUT_MS = 10_000;

/**
 * Conector de SMS vía Twilio. A diferencia de `TwilioWhatsAppService`, este no es un
 * reemplazo intercambiable de otro canal — SMS es un canal propio, con sus propias
 * `Conversation` (ver `channel` en `ConversationsService.handleMessage`), así que siempre
 * está activo si está configurado (no hay equivalente a `WHATSAPP_PROVIDER` acá: no compite
 * con nadie por la cola `sms.outgoing`).
 *
 * Reusa `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` del grupo de WhatsApp (Twilio) — es la misma
 * cuenta, solo cambia el número (`TWILIO_SMS_FROM`) y el canal en el `To`/`From` de la API
 * (sin el prefijo `whatsapp:`).
 *
 * Sin plantillas ni interactivo: SMS no tiene noción de botones/listas en la API de Twilio —
 * un `interactive` que llegue se degrada siempre a texto numerado (mismo mecanismo que el
 * fallback de `TwilioWhatsAppService` ante un error de Content API, acá es el único camino).
 */
@Injectable()
export class TwilioSmsService implements OnModuleInit {
  private readonly logger = new Logger(TwilioSmsService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
  ) {}

  async onModuleInit() {
    await this.broker.subscribe('sms.outgoing', this.handleOutgoing.bind(this));
  }

  private async handleOutgoing(msg: BrokerMessage) {
    const { to, body, interactive } = msg.data as {
      to: string;
      body: string;
      interactive?: WhatsAppInteractive;
    };
    await this.sendText(to, body, interactive);
  }

  async sendText(to: string, body: string, interactive?: WhatsAppInteractive): Promise<void> {
    const [accountSid, authToken, from] = await Promise.all([
      this.appConfig.get('TWILIO_ACCOUNT_SID'),
      this.appConfig.get('TWILIO_AUTH_TOKEN'),
      this.appConfig.get('TWILIO_SMS_FROM'),
    ]);

    if (!accountSid || !authToken || !from) {
      this.logger.warn(
        `No se pudo enviar SMS a ${to}: falta TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN o ` +
          'TWILIO_SMS_FROM en /settings.',
      );
      return;
    }

    const fullBody = interactive ? this.appendInteractiveAsText(body, interactive) : body;

    const params = new URLSearchParams({
      To: this.normalizeRecipient(to),
      From: this.normalizeRecipient(from),
      Body: fullBody,
    });

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`No se pudo contactar la API de Twilio: ${(err as Error).message}`);
      throw err;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Twilio API respondió ${res.status} al mandarle SMS a ${to}: ${detail.slice(0, 500)}`);
      throw new Error(`Twilio API error ${res.status}`);
    }
  }

  /**
   * Mismo criterio que `TwilioWhatsAppService.appendInteractiveAsText`: reconstruye la lista
   * de opciones en el mismo orden con el que `ConversationsService` armó los botones/filas,
   * así el índice que el usuario tipea sigue matcheando en su `case 'menu'`.
   */
  private appendInteractiveAsText(body: string, interactive: WhatsAppInteractive): string {
    const options =
      interactive.type === 'button'
        ? interactive.buttons.map((b) => b.title)
        : interactive.rows.map((r) => (r.description ? `${r.title} - ${r.description}` : r.title));
    const numbered = options.map((label, idx) => `${idx + 1}. ${label}`).join('\n');
    return [body, numbered].filter(Boolean).join('\n');
  }

  /** E.164 con "+", sin prefijo de canal (a diferencia de WhatsApp, que necesita `whatsapp:`). */
  private normalizeRecipient(phone: string): string {
    return `+${phone.replace(/[^\d]/g, '')}`;
  }
}
