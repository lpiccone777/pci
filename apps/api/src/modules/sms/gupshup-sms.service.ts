import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { GupshupFileLoggerService } from '../whatsapp/gupshup-file-logger.service';

const TIMEOUT_MS = 10_000;
const API_URL = 'https://api.gupshup.io/wa/api/v1/msg';

interface GupshupSmsCredentials {
  apiKey: string;
  source: string;
  appName: string;
}

/**
 * Conector de SMS vía Gupshup — API "unificada" (`api.gupshup.io/wa/api/v1/msg`, `channel: 'sms'`),
 * NO la legacy "Enterprise SMS" (`enterprise.smsgupshup.com`) que este archivo usaba antes.
 *
 * Reusa a propósito las MISMAS credenciales que `GupshupWhatsAppService`
 * (`GUPSHUP_API_KEY`/`GUPSHUP_WHATSAPP_SOURCE`/`GUPSHUP_APP_NAME`) en vez de un grupo de
 * settings propio: es el mismo endpoint, la misma cuenta/app de Gupshup, y la única diferencia
 * real es `channel: 'sms'` en el body en vez de `'whatsapp'`.
 *
 * Motivo del cambio (2026-08-27): la cuenta legacy de Enterprise SMS (`enterprise.smsgupshup.com`)
 * tiene el alta rota del lado de Gupshup — no se pudo crear, y contactar soporte no destrabó nada
 * en el momento. El cliente usa Gupshup igual, así que se probó en vivo esta ruta alternativa.
 *
 * ⚠️ **Sin confirmar entrega real todavía.** La API devuelve siempre `202 {"status":"submitted",
 * "messageId":...}` — 6 envíos de prueba contra 2 apps/API keys distintas de Gupshup, todos
 * "submitted", CERO entregados al celular de destino, y sin ningún rastro (ni éxito ni error) en
 * el dashboard de Gupshup para ninguno de los `messageId`. Se probó también el whitelist de
 * sandbox (mandar "Sandbox" a los números de Gupshup) sin confirmación de alta.
 *
 * Además, `docs.gupshup.io` documenta este endpoint **solo para WhatsApp** ("no SMS variants
 * shown") — usar `channel: 'sms'` acá es una superficie no documentada que la API acepta
 * (devuelve 202, no 400/404) pero que evidentemente no está resultando en un SMS real, al menos
 * con esta cuenta. Se integra igual porque es la única vía de Gupshup que la API valida, mientras
 * se espera confirmación de soporte de Gupshup sobre por qué no hay entrega ni rastro en su panel.
 */
@Injectable()
export class GupshupSmsService implements OnModuleInit {
  private readonly logger = new Logger(GupshupSmsService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly fileLog: GupshupFileLoggerService,
  ) {}

  /** Mismo chequeo que `TwilioSmsService.onModuleInit`, invertido. */
  async onModuleInit() {
    const provider = (await this.appConfig.get('SMS_PROVIDER', 'twilio'))?.toLowerCase() || 'twilio';
    if (provider !== 'gupshup') {
      this.logger.log(`SMS_PROVIDER=${provider}: conector de Gupshup inactivo, no se suscribe a sms.outgoing.`);
      return;
    }
    await this.broker.subscribe('sms.outgoing', this.handleOutgoing.bind(this));
  }

  private async handleOutgoing(msg: BrokerMessage) {
    const { to, body } = msg.data as { to: string; body: string };
    await this.sendText(to, body);
  }

  private async credentials(): Promise<GupshupSmsCredentials | null> {
    const [apiKey, source, appName] = await Promise.all([
      this.appConfig.get('GUPSHUP_API_KEY'),
      this.appConfig.get('GUPSHUP_WHATSAPP_SOURCE'),
      this.appConfig.get('GUPSHUP_APP_NAME'),
    ]);
    if (!apiKey || !source || !appName) return null;
    return { apiKey, source, appName };
  }

  async sendText(to: string, body: string): Promise<void> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo enviar SMS (Gupshup) a ${to}: falta GUPSHUP_API_KEY, GUPSHUP_WHATSAPP_SOURCE ` +
          'o GUPSHUP_APP_NAME en /settings (mismo grupo "Mensajería: WhatsApp (Gupshup)" que usa WhatsApp).',
      );
      this.fileLog.log('sms.send.missing_credentials', { to });
      return;
    }

    const params = new URLSearchParams({
      channel: 'sms',
      source: this.normalizeRecipient(creds.source),
      destination: this.normalizeRecipient(to),
      'src.name': creds.appName,
      message: JSON.stringify({ type: 'text', text: body }),
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
      this.logger.error(`No se pudo contactar la API de Gupshup SMS: ${(err as Error).message}`);
      this.fileLog.log('sms.send.network_error', { to, error: (err as Error).message });
      throw err;
    }

    const detail = await res.text().catch(() => '');
    if (!res.ok) {
      this.logger.error(`Gupshup SMS respondió ${res.status} al mandarle a ${to}: ${detail.slice(0, 500)}`);
      this.fileLog.log('sms.send.api_error', { to, status: res.status, detail: detail.slice(0, 500) });
      throw new Error(`Gupshup SMS API error ${res.status}`);
    }

    // `202 {"status":"submitted", ...}` NO confirma entrega real — ver el comentario de la
    // clase. Logueado igual para tener el `messageId` a mano si hay que cruzarlo con soporte.
    this.logger.log(`Gupshup SMS "submitted" (sin confirmar entrega) a ${to}: ${detail.slice(0, 300)}`);
    this.fileLog.log('sms.send.submitted_unconfirmed', { to, detail: detail.slice(0, 300) });
  }

  /** La API de Gupshup espera el número sin "+" ni separadores, igual que para WhatsApp. */
  private normalizeRecipient(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }
}
