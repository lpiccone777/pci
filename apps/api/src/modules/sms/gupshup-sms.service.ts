import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { GupshupFileLoggerService } from '../whatsapp/gupshup-file-logger.service';

const TIMEOUT_MS = 10_000;
const API_BASE_URL = 'https://api.gupshup.io/sms/v1/message';

interface GupshupSmsCredentials {
  apiKey: string;
  appId: string;
  source?: string;
}

/**
 * Conector de SMS vía Gupshup — API de SMS (`api.gupshup.io/sms/v1/message/{appId}`).
 *
 * ⚠️ Este endpoint NO es el mismo que el de WhatsApp, y la diferencia importa:
 *
 * | | WhatsApp (`GupshupWhatsAppService`) | SMS (este archivo) |
 * |---|---|---|
 * | URL | `api.gupshup.io/wa/api/v1/msg` | `api.gupshup.io/sms/v1/message/{appId}` |
 * | Auth | header `apikey` | header `Authorization` |
 * | Cuerpo | `channel`/`source`/`destination`/`src.name`/`message` (JSON) | `destination`/`message` (texto plano)/`source` |
 * | App | `GUPSHUP_APP_NAME` (nombre, ej. "dasyBot") | `GUPSHUP_SMS_APP_ID` (UUID) |
 *
 * Historia (importante para no volver a romperlo):
 * - Hasta 2026-08-27 usaba la API legacy "Enterprise SMS" (`enterprise.smsgupshup.com`), que se
 *   dejó porque el alta de esa cuenta estaba rota del lado de Gupshup.
 * - Del 2026-08-27 al 2026-08-31 pegaba al endpoint de **WhatsApp** (`/wa/api/v1/msg`) con
 *   `channel: 'sms'` en el body, asumiendo que era un endpoint unificado. Gupshup responde
 *   `202 {"status":"submitted"}` a eso, así que parecía andar — pero ignora el `channel` y
 *   **entrega el mensaje por WhatsApp, no como SMS** (confirmado con tráfico real: el usuario
 *   recibió el "SMS" por WhatsApp). Eso también explica los 6 envíos de prueba que quedaron
 *   "submitted" sin llegar nunca y sin rastro en el panel de Gupshup.
 *
 * `GUPSHUP_API_KEY` sí se comparte con WhatsApp a propósito: la API key es de la cuenta de
 * Gupshup, no del canal. Lo que NO se comparte es la app (nombre vs UUID) ni el header de auth.
 *
 * ⚠️ Sin confirmar contra tráfico real todavía. Además, la documentación de Gupshup lista como
 * destinos permitidos de esta API solo Brasil, México, Colombia, Perú e India — Argentina no
 * figura. Si los envíos a números `+549` fallan o quedan sin entregar, es probable que sea por
 * eso y haya que confirmarlo con soporte de Gupshup, no un problema de esta integración.
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
    const [apiKey, appId, source] = await Promise.all([
      this.appConfig.get('GUPSHUP_API_KEY'),
      this.appConfig.get('GUPSHUP_SMS_APP_ID'),
      this.appConfig.get('GUPSHUP_SMS_SOURCE'),
    ]);
    if (!apiKey || !appId) return null;
    return { apiKey, appId, source: source || undefined };
  }

  async sendText(to: string, body: string): Promise<void> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo enviar SMS (Gupshup) a ${to}: falta GUPSHUP_API_KEY (grupo "Mensajería: ` +
          'WhatsApp (Gupshup)") o GUPSHUP_SMS_APP_ID (grupo "Mensajería: SMS (Gupshup)") en /settings.',
      );
      this.fileLog.log('sms.send.missing_credentials', { to });
      return;
    }

    const params = new URLSearchParams({
      destination: this.normalizeRecipient(to),
      message: body,
    });
    // Sender ID: solo aplica a India según la documentación de Gupshup, en el resto de los
    // países lo asigna Gupshup — se manda solo si está configurado, en vez de un valor vacío.
    if (creds.source) params.set('source', creds.source);

    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/${creds.appId}`, {
        method: 'POST',
        headers: {
          Authorization: creds.apiKey,
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
