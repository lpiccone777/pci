import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';

const TIMEOUT_MS = 10_000;
const BASE_URL = 'https://enterprise.smsgupshup.com/GatewayAPI/rest';

interface GupshupSmsCredentials {
  userId: string;
  password: string;
}

/**
 * Conector alternativo de SMS vía Gupshup — API LEGACY "Enterprise SMS"
 * (`enterprise.smsgupshup.com`), un producto y una CUENTA COMPLETAMENTE DISTINTOS de la API
 * de WhatsApp de Gupshup (`api.gupshup.io`, ver `GupshupWhatsAppService`): auth por
 * `userid`/`password` propios, no el `apikey` de WhatsApp. No confundir los dos al cargar
 * credenciales en `/settings` — son dos productos separados de la misma empresa.
 *
 * Elegido con `SMS_PROVIDER=gupshup` (setting nuevo — hasta ahora Twilio era el único
 * conector de SMS y no competía por `sms.outgoing` con nadie, ver `TwilioSmsService`).
 *
 * Query params y formato de respuesta ("success | numero | msgid" en texto plano, no JSON)
 * verificados contra documentación pública de Gupshup (2026-08-14). El shape del webhook de
 * SMS ENTRANTE (`GupshupSmsWebhookController`) NO pudo verificarse con la misma certeza — ver
 * el comentario ahí antes de confiar en el canal de recepción.
 */
@Injectable()
export class GupshupSmsService implements OnModuleInit {
  private readonly logger = new Logger(GupshupSmsService.name);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
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
    const [userId, password] = await Promise.all([
      this.appConfig.get('GUPSHUP_SMS_USERID'),
      this.appConfig.get('GUPSHUP_SMS_PASSWORD'),
    ]);
    if (!userId || !password) return null;
    return { userId, password };
  }

  async sendText(to: string, body: string): Promise<void> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo enviar SMS (Gupshup) a ${to}: falta GUPSHUP_SMS_USERID o GUPSHUP_SMS_PASSWORD en /settings.`,
      );
      return;
    }

    const params = new URLSearchParams({
      userid: creds.userId,
      password: creds.password,
      send_to: this.normalizeRecipient(to),
      msg: body,
      method: 'SendMessage',
      msg_type: 'text',
      format: 'text',
      auth_scheme: 'plain',
      v: '1.1',
    });

    let text: string;
    try {
      const res = await fetch(`${BASE_URL}?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      this.logger.error(`No se pudo contactar la API de Gupshup SMS: ${(err as Error).message}`);
      throw err;
    }

    // Respuesta en texto plano, no JSON: "success | numero | msgid" o "error | codigo | detalle".
    if (!text.trim().toLowerCase().startsWith('success')) {
      this.logger.error(`Gupshup SMS respondió con error al mandarle a ${to}: ${text.slice(0, 500)}`);
      throw new Error(`Gupshup SMS API error: ${text.slice(0, 200)}`);
    }
  }

  /** Mismo criterio que la respuesta de la API legacy: E.164 sin "+" ni separadores. */
  private normalizeRecipient(phone: string): string {
    return phone.replace(/[^\d]/g, '');
  }
}
