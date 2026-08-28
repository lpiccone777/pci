import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { AppConfigService } from '../../config/app-config.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppInteractive } from './whatsapp-interactive.types';

const TIMEOUT_MS = 10_000;
const CONTENT_TIMEOUT_MS = 15_000;

interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  from: string;
}

/**
 * Conector alternativo de WhatsApp vía Twilio, pensado como reemplazo intercambiable de
 * `WhatsAppService` (Meta Cloud API directa) — mismo contrato de colas
 * (`whatsapp.outgoing`/`whatsapp.incoming`), así `ConversationsService` no sabe ni le
 * importa cuál de los dos está activo. Se elige con el setting `WHATSAPP_PROVIDER`.
 *
 * Sin plantillas HSM aprobadas para mensajes fuera de la ventana de 24hs todavía (deuda
 * técnica compartida con Meta, ver docs/plan-de-trabajo.md) — pero SÍ manda botones/listas
 * nativos dentro de la ventana, vía Twilio Content API (ver `sendInteractive`).
 */
@Injectable()
export class TwilioWhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(TwilioWhatsAppService.name);

  /**
   * `ContentSid` de Twilio por forma de menú, en memoria — solo un caché L1 delante de
   * `TwilioContentTemplate` (BD, fuente de verdad real): evita el roundtrip a la BD en cada
   * mensaje de un menú que ya se resolvió antes en este mismo proceso. Se repuebla sola desde
   * la BD ante un miss, así que perderla en un reinicio no tiene costo — a diferencia de antes
   * (2026-08-13), cuando esta era la única cache y un reinicio forzaba recrear el Content
   * Template entero.
   */
  private readonly contentSidCache = new Map<string, string>();

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly broker: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Solo se suscribe si es el proveedor activo (`WHATSAPP_PROVIDER=twilio`) — con
   * `WhatsAppService` también escuchando la misma cola, dos consumers activos a la vez se
   * la repartirían por competencia (round robin de RabbitMQ) en vez de que uno solo la
   * maneje. Ver el mismo chequeo, invertido, en `WhatsAppService.onModuleInit`.
   */
  async onModuleInit() {
    const provider = (await this.appConfig.get('WHATSAPP_PROVIDER', 'meta'))?.toLowerCase() || 'meta';
    if (provider !== 'twilio') {
      this.logger.log(
        `WHATSAPP_PROVIDER=${provider}: conector de Twilio inactivo, no se suscribe a whatsapp.outgoing.`,
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

  private async credentials(): Promise<TwilioCredentials | null> {
    const [accountSid, authToken, from] = await Promise.all([
      this.appConfig.get('TWILIO_ACCOUNT_SID'),
      this.appConfig.get('TWILIO_AUTH_TOKEN'),
      this.appConfig.get('TWILIO_WHATSAPP_FROM'),
    ]);
    if (!accountSid || !authToken || !from) return null;
    return { accountSid, authToken, from };
  }

  /**
   * Manda un mensaje de texto libre, o uno interactivo (botones/lista) si se pasa
   * `interactive` — vía `sendInteractive`. Si el Content Template falla por lo que sea
   * (Content API caída, error inesperado), degrada a texto numerado en vez de perder el
   * mensaje: mejor un menú como lista numerada que ningún mensaje.
   */
  async sendText(to: string, body: string, interactive?: WhatsAppInteractive): Promise<void> {
    const creds = await this.credentials();
    if (!creds) {
      this.logger.warn(
        `No se pudo enviar WhatsApp (Twilio) a ${to}: falta TWILIO_ACCOUNT_SID, ` +
          'TWILIO_AUTH_TOKEN o TWILIO_WHATSAPP_FROM en /settings.',
      );
      return;
    }

    if (interactive) {
      try {
        await this.sendInteractive(to, creds, body, interactive);
        return;
      } catch (err) {
        this.logger.warn(
          `No se pudo mandar el mensaje interactivo por Content API, degradando a texto: ${(err as Error).message}`,
        );
      }
    }

    await this.sendPlainText(to, creds, interactive ? this.appendInteractiveAsText(body, interactive) : body);
  }

  private async sendPlainText(to: string, creds: TwilioCredentials, body: string): Promise<void> {
    const params = new URLSearchParams({
      To: `whatsapp:${this.normalizeRecipient(to)}`,
      From: `whatsapp:${this.normalizeRecipient(creds.from)}`,
      Body: body,
    });
    await this.callMessagesApi(to, creds, params);
  }

  /**
   * Manda el menú como botones/lista reales de WhatsApp, vía Content API de Twilio.
   *
   * A diferencia de la Cloud API de Meta (payload inline en cada mensaje), Twilio exige un
   * Content Template pre-creado — y esos templates NO admiten variables en el título de los
   * botones/filas, solo en el body. Como nuestros menús son dinámicos (los arma el editor de
   * flujos), la forma de reconciliar esto es: cachear un template por CADA FORMA de menú
   * (mismos botones/filas, sin importar el body — ver `hashInteractiveShape`), con el body
   * como variable `{{1}}` del template en vez de texto fijo. Así "Hola {{userName}}, elegí:"
   * con el mismo menú de opciones reusa un único template para todos los usuarios.
   *
   * Confirmado (2026-08-13, docs de Twilio): un `twilio/quick-reply` (≤3 botones) o
   * `twilio/list-picker` (≤10 filas) se puede mandar dentro de la ventana de 24hs sin
   * aprobación de WhatsApp — alcanza con crearlo, nunca hace falta enviarlo a aprobación. Es
   * justo nuestro caso: `sendText` solo se llama respondiendo a un mensaje entrante.
   */
  private async sendInteractive(
    to: string,
    creds: TwilioCredentials,
    body: string,
    interactive: WhatsAppInteractive,
  ): Promise<void> {
    const contentSid = await this.resolveContentSid(creds, interactive);
    const variables: Record<string, string> = { '1': body || ' ' };
    // La URL del botón de link viaja como variable `{{2}}`: el template se cachea solo
    // por el título del botón (ver `hashInteractiveShape`), así que un mismo nodo con
    // URLs distintas por conversación (ej. un link con id de ticket) reusa un único
    // Content Template en vez de crear uno por URL.
    if (interactive.type === 'cta_url') variables['2'] = interactive.url;
    const params = new URLSearchParams({
      To: `whatsapp:${this.normalizeRecipient(to)}`,
      From: `whatsapp:${this.normalizeRecipient(creds.from)}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(variables),
    });
    await this.callMessagesApi(to, creds, params);
  }

  /**
   * `ContentSid` por forma de menú: memoria → BD (`TwilioContentTemplate`) → Twilio, en ese
   * orden — el primero que lo tenga gana, y cada nivel repuebla el de arriba. Crear el
   * Content Template en Twilio es lo único que cuesta de verdad (una llamada HTTP a una API
   * externa); memoria y BD son solo para no pagarlo dos veces.
   */
  private async resolveContentSid(creds: TwilioCredentials, interactive: WhatsAppInteractive): Promise<string> {
    const hash = this.hashInteractiveShape(interactive);

    const cached = this.contentSidCache.get(hash);
    if (cached) return cached;

    const stored = await this.prisma.twilioContentTemplate.findUnique({ where: { shapeHash: hash } });
    if (stored) {
      this.contentSidCache.set(hash, stored.contentSid);
      return stored.contentSid;
    }

    const sid = await this.createContentTemplate(creds, interactive, hash);
    await this.persistContentSid(hash, sid, interactive);
    this.contentSidCache.set(hash, sid);
    return sid;
  }

  /**
   * Guarda el `ContentSid` recién creado en `TwilioContentTemplate`. Si dos mensajes con el
   * mismo menú NUEVO llegan casi al mismo tiempo (dos usuarios distintos tocando el mismo
   * nodo `menu` por primera vez), ambos pueden pasar el chequeo de `resolveContentSid` antes
   * de que el primero llegue a guardar acá — el segundo `create` choca contra el `@unique` de
   * `shapeHash` (Prisma P2002). No es un error real: se descarta el Content Template que
   * "perdió la carrera" (queda huérfano en la cuenta de Twilio, sin uso — costo aceptable de
   * la baja probabilidad de la carrera) y se usa el que ya quedó guardado.
   */
  private async persistContentSid(hash: string, sid: string, interactive: WhatsAppInteractive): Promise<void> {
    try {
      await this.prisma.twilioContentTemplate.create({
        data: {
          shapeHash: hash,
          contentSid: sid,
          friendlyName: `pci_menu_${hash}`,
          label: this.describeInteractive(interactive),
        },
      });
    } catch (err) {
      const isUniqueViolation = (err as { code?: string }).code === 'P2002';
      if (!isUniqueViolation) throw err;
      this.logger.debug(`TwilioContentTemplate para ${hash} ya existía (carrera entre dos mensajes concurrentes).`);
    }
  }

  /** Resumen legible de las opciones del menú, solo para la columna `label` de debug en BD. */
  private describeInteractive(interactive: WhatsAppInteractive): string {
    const titles =
      interactive.type === 'button'
        ? interactive.buttons.map((b) => b.title)
        : interactive.type === 'cta_url'
          ? [interactive.buttonText]
          : interactive.rows.map((r) => r.title);
    return titles.join(' | ').slice(0, 200);
  }

  /**
   * Hash estable de la FORMA del menú (tipo + botones/filas), a propósito sin el body: el
   * body cambia por usuario/momento (interpolación de `{{variable}}` ya resuelta antes de
   * llegar acá) pero el conjunto de opciones de un mismo nodo `menu` es siempre el mismo, y
   * es lo único que de verdad necesita su propio Content Template.
   */
  private hashInteractiveShape(interactive: WhatsAppInteractive): string {
    const shape =
      interactive.type === 'button'
        ? { type: 'button', items: interactive.buttons.map((b) => [b.id, b.title]) }
        : interactive.type === 'cta_url'
          // Sin la URL a propósito, igual que el body de `button`/`list`: viaja como
          // variable `{{2}}` del template (ver `sendInteractive`), no como parte de la
          // forma — si no, cada URL distinta (ej. un link con id de ticket) crearía su
          // propio Content Template en la cuenta de Twilio en vez de reusar uno.
          ? { type: 'cta_url', buttonText: interactive.buttonText }
          : {
              type: 'list',
              buttonText: interactive.buttonText,
              items: interactive.rows.map((r) => [r.id, r.title, r.description ?? '']),
            };
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 20);
  }

  /**
   * Crea el Content Template en Twilio (`POST content.twilio.com/v1/Content`, JSON — a
   * diferencia del resto de los endpoints de Twilio que van form-encoded). Se crea "sin
   * aprobar" a propósito: no hace falta pedirle aprobación a WhatsApp para usarlo dentro de
   * la ventana de 24hs (ver el comentario de `sendInteractive`), y un `list-picker` ni
   * siquiera se puede enviar a aprobación.
   *
   * `friendly_name` sale del mismo hash que la clave de `TwilioContentTemplate`, así que es
   * determinístico y solo se llega acá cuando la BD todavía no tiene ese hash — un rechazo de
   * Twilio por nombre duplicado significaría que el Content Template se creó por fuera de este
   * flujo (a mano en la consola, por ejemplo). Ante ese error o cualquier otro, se tira para
   * que `sendText` degrade a texto en vez de perder el mensaje.
   */
  private async createContentTemplate(
    creds: TwilioCredentials,
    interactive: WhatsAppInteractive,
    hash: string,
  ): Promise<string> {
    const types =
      interactive.type === 'button'
        ? {
            'twilio/quick-reply': {
              body: '{{1}}',
              actions: interactive.buttons.map((b) => ({
                title: b.title.slice(0, 20),
                id: b.id.slice(0, 200),
              })),
            },
          }
        : interactive.type === 'cta_url'
          ? {
              // Schema verificado contra twilio.com/docs/content/twilio-call-to-action
              // (2026-08-27) — `body` + `actions[].{type:'URL', title, url}`. La URL real
              // va en `{{2}}` (ver `sendInteractive`), no acá: el título del botón es lo
              // único fijo de la forma, así el mismo template sirve para cualquier
              // destino. Ojo: la doc de Twilio dice "variables supported at the end of
              // the URL string" (pensado para templates aprobados con dominio fijo +
              // sufijo variable) — acá la URL entera es variable, y como estos templates
              // nunca se mandan a aprobar (van dentro de la ventana de 24hs, igual que
              // quick-reply/list-picker), no debería toparse con esa restricción, pero no
              // se confirmó contra tráfico real de Twilio.
              'twilio/call-to-action': {
                body: '{{1}}',
                actions: [{ type: 'URL', title: interactive.buttonText.slice(0, 20), url: '{{2}}' }],
              },
            }
          : {
              'twilio/list-picker': {
                body: '{{1}}',
                button: interactive.buttonText.slice(0, 20),
                items: interactive.rows.map((r) => ({
                  id: r.id.slice(0, 200),
                  item: r.title.slice(0, 24),
                  ...(r.description ? { description: r.description.slice(0, 72) } : {}),
                })),
              },
            };

    const payload = {
      friendly_name: `pci_menu_${hash}`,
      language: 'es',
      variables: interactive.type === 'cta_url' ? { '1': ' ', '2': ' ' } : { '1': ' ' },
      types,
    };

    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

    let res: Response;
    try {
      res = await fetch('https://content.twilio.com/v1/Content', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`No se pudo contactar la Content API de Twilio: ${(err as Error).message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Content API respondió ${res.status}: ${text.slice(0, 500)}`);
    }

    const created = JSON.parse(text) as { sid?: string };
    if (!created.sid) throw new Error(`Content API no devolvió sid: ${text.slice(0, 500)}`);
    return created.sid;
  }

  private async callMessagesApi(to: string, creds: TwilioCredentials, params: URLSearchParams): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`;
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

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
      this.logger.error(`Twilio API respondió ${res.status} al mandarle a ${to}: ${detail.slice(0, 500)}`);
      throw new Error(`Twilio API error ${res.status}`);
    }
  }

  /**
   * Reconstruye la lista de opciones a partir del mismo array y en el mismo orden con el
   * que `ConversationsService` armó los botones/filas, así el índice que el usuario tipea
   * sigue matcheando en su `case 'menu'` sin que este conector tenga que saber nada de flujos.
   * Fallback cuando `sendInteractive` falla — ver `sendText`.
   */
  private appendInteractiveAsText(body: string, interactive: WhatsAppInteractive): string {
    if (interactive.type === 'cta_url') {
      // No hay nada que numerar (no es una opción a elegir): el link plano alcanza.
      return [body, `${interactive.buttonText}: ${interactive.url}`].filter(Boolean).join('\n');
    }
    const options =
      interactive.type === 'button'
        ? interactive.buttons.map((b) => b.title)
        : interactive.rows.map((r) => (r.description ? `${r.title} - ${r.description}` : r.title));
    const numbered = options.map((label, idx) => `${idx + 1}. ${label}`).join('\n');
    return [body, numbered].filter(Boolean).join('\n');
  }

  /** Twilio espera E.164 con "+" (a diferencia de la Graph API de Meta, que lo quiere sin él). */
  private normalizeRecipient(phone: string): string {
    return `+${phone.replace(/[^\d]/g, '')}`;
  }
}
