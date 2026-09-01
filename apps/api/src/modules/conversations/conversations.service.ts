import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { UsersService } from '../users/users.service';
import { FlowService } from '../flow/flow.service';
import { LlmMessage } from '../llm/llm-provider.interface';
import { WhatsAppInteractive } from '../whatsapp/whatsapp-interactive.types';
import { AppConfigService } from '../../config/app-config.service';
import { EmailService } from '../auth/email.service';
import { ContextSourcesService } from '../context-sources/context-sources.service';
import { InboundTenantRoutingService, InboundRoutingResult } from './inbound-tenant-routing.service';
import { InvgateService, IncidentAttachment } from '../invgate/invgate.service';
import { stripArgentinaMobileNine } from '../../common/phone.util';
import { TwilioMediaService, StoredAttachment } from '../../common/twilio-media.service';
import { UnknownSenderLogService } from './unknown-sender-log.service';
import { createHash } from 'crypto';

/**
 * Cola propia para /conversations/simulate, separada de `whatsapp.incoming`. El
 * mensaje pasa por RabbitMQ igual que uno real (publish → consume → handleMessage
 * → publish de la respuesta), pero aislado del tráfico del canal real: no compite
 * por esa cola ni ensucia sus métricas, y el día que exista un conector real de
 * WhatsApp escuchando `whatsapp.outgoing`, las respuestas de simulate no se cruzan
 * con las suyas.
 */
const SIMULATE_QUEUE = 'whatsapp.simulate.incoming';

/**
 * Timeout del request/reply de simulate. Generoso a propósito, y tiene que cubrir
 * el peor caso real, no solo el típico: `interpretMenuChoice` y el `llmService.chat`
 * final de `orchestratorLlm` son dos llamadas LLM separadas que pueden caer cada una
 * en el timeout interno de 120s de OpenCode Go (ver `REQUEST_TIMEOUT_MS` en
 * `OpenCodeGoProvider`), más hasta ~32s si `orchestratorLlm` además consulta una
 * fuente de verdad (`ContextSourcesService.queryKnowledge`). Estaba en 90s — menos
 * que el propio timeout interno de OpenCode Go que el comentario de al lado ya
 * advertía — así que expiraba antes de que la llamada real pudiera siquiera
 * terminar (bien o mal).
 */
const SIMULATE_TIMEOUT_MS = 300_000;

/** Corte de seguridad ante flujos con ciclos entre nodos no interactivos. */
const MAX_FLOW_STEPS = 25;

/**
 * Ventana para retomar una charla cerrada (nodo `end`, cancelación del usuario o
 * fin del flujo) como la misma Conversation en vez de abrir una nueva. Pasada la
 * ventana, el próximo mensaje del usuario arranca una charla nueva.
 */
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Inactividad máxima de una charla `active` antes de cerrarla sola (pedido
 * 2026-08-10). El próximo mensaje del usuario, si llega dentro de
 * RESUME_WINDOW_MS, retoma la misma Conversation pero con el flujo reseteado
 * (closeConversation ya deja currentNodeId/flowState en null) — "empieza de
 * nuevo" sin perder el historial de Message.
 */
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;

/** Tope del nodo `delay`: encadenando, un delay largo colgaría la request entera. */
const MAX_DELAY_SECONDS = 10;
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Nodo `llm_query` en modo extracción: cuántas veces se le pregunta al usuario un
 * dato antes de darlo por "no definido" y seguir. Default cuando el nodo no trae
 * `data.maxAttempts` — ver ConversationsService.executeLlmQueryExtraction.
 */
const DEFAULT_LLM_QUERY_MAX_ATTEMPTS = 2;

/** Valor que `llm_query` en modo extracción guarda cuando el usuario se niega (o agota los intentos) a dar un dato. */
const LLM_QUERY_UNDEFINED_VALUE = 'no definido';

/**
 * System prompt de arranque cuando no hay nada configurado en /settings
 * (`LLM_SYSTEM_PROMPT`) — ver `ConversationsService.buildBasePrompt`. Mismo texto
 * que ya se usaba como fallback hardcodeado del nodo `llm_query`: se conserva acá
 * para que una instalación sin ese setting cargado no cambie de comportamiento.
 */
const DEFAULT_SYSTEM_PROMPT = 'Eres un asistente de soporte técnico amable y conciso. Responde en español.';

/**
 * `maxTokens` de los clasificadores binarios/de opción (`confirmEndChatIntent`,
 * `confirmCancelIntent`, `interpretMenuChoice`) — piden una sola palabra de respuesta, así
 * que 10-20 tokens alcanzaban de sobra... hasta que un modelo de razonamiento obligatorio
 * (MiniMax M2.x, no se puede apagar el "pensamiento") se volvió el proveedor activo
 * (2026-08-14): el razonamiento interno consume el `maxTokens` ANTES de llegar a la
 * palabra pedida, así que con un tope de 10 el modelo se queda sin presupuesto pensando y
 * nunca llega a responder — `content` vuelve vacío, y los tres clasificadores devuelven
 * su default "no" en silencio (nunca cierran la charla ni cancelan ni matchean una opción,
 * pase lo que pase). 300 le da lugar al razonamiento sin ser un costo real para un
 * proveedor no-razonador, que igual corta apenas emite la palabra.
 */
const CLASSIFIER_MAX_TOKENS = 300;

/**
 * `maxTokens` del extractor de variables de `llm_query` (`extractLlmQueryValues`) — MISMO
 * problema de los clasificadores de arriba, pero acá 300 NO alcanza: esta tarea no responde
 * una sola palabra, tiene que razonar sobre la conversación reciente entera (hasta
 * `contextMessages` mensajes) Y emitir una línea `clave: valor` por cada variable. Con un
 * modelo de razonamiento obligatorio (MiniMax M2.x), el pensamiento interno consume el
 * presupuesto ANTES de emitir las líneas: `content` vuelve vacío o cortado, el parser
 * convierte todo a NONE en silencio, y el nodo vuelve a preguntar datos que el usuario YA
 * dio — visto en producción (2026-08-28) como "recopiló todo pero no avanza, sigue
 * preguntando". Generoso a propósito: un proveedor no-razonador corta solo al terminar las
 * líneas, así que el costo real no cambia.
 */
const LLM_QUERY_EXTRACT_MAX_TOKENS = 2000;

interface NodeExecutionResult {
  responseText?: string;
  nextNodeId?: string;
  sourceHandle?: string;
  /** Corta la cadena y devuelve el turno al usuario, parando en este nodo. */
  waitForInput?: boolean;
  /** El usuario canceló la gestión en curso: termina el flujo, no sigue ninguna arista. */
  cancelFlow?: boolean;
  /** Nodo `end`: cierre explícito y deliberado de la charla. */
  endConversation?: boolean;
  /** Botones o lista de WhatsApp para un `menu`, en vez del texto numerado. */
  interactive?: WhatsAppInteractive;
  flowState?: any;
}

/** Un menú apilado en `flowState.__menuStack` — ver `navigateMenuBack`. */
interface MenuStackEntry {
  nodeId: string;
  flowId: string;
}

/** Valor reservado de la opción "Volver" sintética — no puede colisionar con
 * un `opt.value` real porque el editor de flujos genera esos valores como
 * índices numéricos o slugs simples, nunca con este prefijo. */
const BACK_OPTION_VALUE = '__volver';

/** Tope duro de WhatsApp para un mensaje interactivo de lista: no admite más de
 * 10 filas (ver `buildMenuInteractive` y `TwilioWhatsAppService`). */
const MAX_TICKET_LIST_ROWS = 10;

/** Nombres de estado de InvGate que cuentan como "cerrado" para el nodo
 * `ticket_query`. InvGate no expone un flag booleano de cerrado/abierto — el
 * catálogo de estados es texto libre configurable por cada instancia — así
 * que se excluye por nombre conocido, case-insensitive. */
const CLOSED_TICKET_STATUS_NAMES = new Set([
  'cerrado',
  'cerrada',
  'closed',
  'resuelto',
  'resuelta',
  'resolved',
  'solucionado',
  'solucionada',
  'solved',
  'cancelado',
  'cancelada',
  'cancelled',
  'canceled',
  'rechazado',
  'rechazada',
  'rejected',
]);

function isOpenTicketStatus(status: string): boolean {
  return !CLOSED_TICKET_STATUS_NAMES.has(status.trim().toLowerCase());
}

@Injectable()
export class ConversationsService implements OnModuleInit {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly broker: BrokerService,
    private readonly usersService: UsersService,
    private readonly flowService: FlowService,
    private readonly appConfig: AppConfigService,
    private readonly emailService: EmailService,
    private readonly contextSourcesService: ContextSourcesService,
    private readonly invgateService: InvgateService,
    private readonly twilioMedia: TwilioMediaService,
    private readonly unknownSenderLog: UnknownSenderLogService,
    private readonly inboundTenantRouting: InboundTenantRoutingService,
  ) {}

  async onModuleInit() {
    await this.broker.subscribe('whatsapp.incoming', this.handleMessage.bind(this));
    // SMS es 100% saliente (avisos, ver el nodo `sms` del editor) — no hay `sms.incoming`
    // ni webhook de entrada para ningún proveedor (Twilio/Gupshup), a propósito: no vamos
    // a soportar conversación bidireccional por ese canal.
    await this.broker.subscribe(SIMULATE_QUEUE, this.handleMessage.bind(this));
    this.logger.log(`Subscribed to whatsapp.incoming and ${SIMULATE_QUEUE}`);
  }

  /**
   * Para /conversations/simulate. Publica el mensaje en `SIMULATE_QUEUE` y espera
   * —a través del broker, no en memoria— la respuesta que `handleMessage` publica
   * de vuelta. Simula el funcionamiento real: RabbitMQ de punta a punta, no una
   * llamada directa que se salte la cola.
   *
   * `tenantId` opcional: con valor, `handleMessage` usa esa empresa y corta el ruteo
   * (probar el flujo de un tenant puntual); sin valor, pasa por el ruteo por membresía
   * como un canal real (incluido el selector de empresa, que vuelve como texto acá).
   */
  async simulateIncomingMessage(from: string, body: string, tenantId?: string): Promise<string> {
    const reply = await this.broker.request(
      SIMULATE_QUEUE,
      {
        pattern: 'message.received',
        data: { from, body },
        tenantId,
        timestamp: new Date().toISOString(),
      },
      { timeoutMs: SIMULATE_TIMEOUT_MS },
    );

    // `interactive` viaja en la respuesta real (ver el publish de `handleMessage`),
    // pero Postman no tiene forma de renderizar botones/lista de WhatsApp — sin esto
    // `/simulate` devolvía solo el header del menú (el texto numerado completo se arma
    // a propósito nada más que como fallback cuando NO hay interactivo, ver el case
    // `'menu'` de `executeNode`) y las opciones quedaban "cortadas" para quien prueba
    // por acá. Se agrega como texto plano nada más que para esta respuesta HTTP; el
    // pipeline real de WhatsApp no se toca.
    const { body: replyText, interactive } = reply.data as {
      to: string;
      body: string;
      interactive?: WhatsAppInteractive;
    };
    return interactive ? `${replyText}\n\n${this.formatInteractiveAsText(interactive)}` : replyText;
  }

  /** Ver el comentario de `simulateIncomingMessage`. */
  private formatInteractiveAsText(interactive: WhatsAppInteractive): string {
    if (interactive.type === 'cta_url') return `${interactive.buttonText}: ${interactive.url}`;
    const items = interactive.type === 'button' ? interactive.buttons : interactive.rows;
    return items.map((item, i) => `${i + 1}. ${item.title}`).join('\n');
  }

  /** Devuelve el texto con el que respondió el bot, para que `simulate` pueda mostrarlo. */
  private async handleMessage(msg: BrokerMessage): Promise<string> {
    // `channel` lo fija cada webhook al publicar (`whatsapp` para Meta/Twilio-WhatsApp,
    // `sms` para Twilio SMS) — default 'whatsapp' para /simulate y cualquier publisher
    // viejo que todavía no lo mande. Determina de qué `Conversation` se habla (un mismo
    // usuario puede tener una charla activa por WhatsApp y otra por SMS al mismo tiempo,
    // son independientes) y a qué cola de salida (`${channel}.outgoing`) va la respuesta.
    const { from, channel = 'whatsapp' } = msg.data as {
      from: string;
      body: string;
      channel?: string;
      attachments?: StoredAttachment[];
    };
    // `body` y `attachments` son `let`: si el usuario venía respondiendo el selector de
    // empresa, se reemplazan por los del mensaje original que disparó la pregunta, para
    // reprocesarlo (texto Y adjuntos) en la empresa elegida.
    let body = (msg.data as { body: string }).body;
    let attachments: StoredAttachment[] =
      (msg.data as { attachments?: StoredAttachment[] }).attachments ?? [];
    const outgoingQueue = `${channel}.outgoing`;

    // Resolución de la empresa. `/simulate` y el RPC mandan `tenantId` explícito y cortan acá;
    // los mensajes reales de canal llegan SIN tenant y se rutean por la membresía del teléfono
    // (una empresa → directo; varias → se pregunta; ninguna → tenant de sistema). Ver
    // InboundTenantRoutingService.
    let tenantId = msg.tenantId;
    if (!tenantId) {
      let routing: InboundRoutingResult;
      try {
        routing = await this.inboundTenantRouting.resolve(from, channel, body, attachments);
      } catch (err) {
        this.logger.error(
          `No se pudo resolver la empresa para ${from} (${channel}): ${err instanceof Error ? err.message : err}`,
        );
        // Falló la resolución de empresa (p. ej. un choque transitorio al registrar la selección
        // pendiente). En vez de descartar el mensaje en silencio, se avisa al usuario para que
        // reintente. Mismo patrón de publicación que el path del selector: por RPC (/simulate, con
        // `replyTo`) se responde por esa cola para no dejar al llamador colgado hasta el timeout;
        // por canal real, al `${channel}.outgoing`, para que el usuario reciba el aviso.
        const notice =
          'Tuvimos un problema para procesar tu mensaje. Por favor, probá de nuevo en unos instantes.';
        await this.broker.publish(
          msg.replyTo ?? outgoingQueue,
          {
            pattern: 'message.send',
            data: { to: from, body: notice },
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: !msg.replyTo },
        );
        return notice;
      }
      if (routing.status === 'ignored') {
        // No hablamos con desconocidos (pedido 2026-08-27): el teléfono no pertenece a
        // ninguna empresa — silencio hacia el usuario, sin crear `User` ni `Conversation` ni
        // gastar LLM (mismo criterio que el rechazo de la línea "1. Identificar al usuario"
        // más abajo, que cubre el caso de `/simulate` contra un tenant puntual). El intento
        // queda igual registrado en archivo. Por RPC (/simulate sin tenantId) sí se responde,
        // para no dejar al llamador colgado hasta el timeout.
        this.unknownSenderLog.log({ channel, from, bodyPreview: body.slice(0, 200) });
        this.logger.warn(`Mensaje de ${from} (${channel}) ignorado: no pertenece a ninguna empresa.`);
        if (msg.replyTo) {
          const notice = 'Este número no está registrado: el bot no atiende mensajes de desconocidos.';
          await this.broker.publish(
            msg.replyTo,
            {
              pattern: 'message.send',
              data: { to: from, body: notice },
              timestamp: new Date().toISOString(),
              correlationId: msg.correlationId,
            },
            { assert: false },
          );
          return notice;
        }
        return '';
      }
      if (routing.status === 'notice') {
        // Aviso por cambio administrativo (empresa dada de baja, membresía revocada a mitad
        // de charla): se informa y se corta — el próximo mensaje re-rutea de cero.
        await this.broker.publish(
          msg.replyTo ?? outgoingQueue,
          {
            pattern: 'message.send',
            data: { to: from, body: routing.body },
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: !msg.replyTo },
        );
        return routing.body;
      }
      if (routing.status === 'ask') {
        // Todavía no hay empresa (ni conversación): se le pregunta y se corta. La respuesta del
        // usuario entrará como un mensaje nuevo y la matcheará el propio InboundTenantRoutingService.
        await this.broker.publish(
          msg.replyTo ?? outgoingQueue,
          {
            pattern: 'message.send',
            data: { to: from, body: routing.body, interactive: routing.interactive },
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: !msg.replyTo },
        );
        this.logger.log(`[selector] Empresa preguntada a ${from} (${channel}).`);
        return routing.interactive
          ? `${routing.body}\n\n${this.formatInteractiveAsText(routing.interactive)}`
          : routing.body;
      }
      tenantId = routing.tenantId;
      if (routing.replayBody !== undefined) body = routing.replayBody;
      if (routing.replayAttachments?.length) attachments = routing.replayAttachments;
    }
    if (!tenantId) return '';

    this.logger.log(`[${tenantId}] Mensaje de ${from}: ${body.substring(0, 50)}...`);

    // 0. Baja lógica de la empresa: si está dada de baja, el bot no la atiende. La baja la
    // saca del panel (listado, selector, acceso al backoffice), pero los mensajes reales
    // entran por el broker sin pasar por `TenantGuard`, así que el corte hay que hacerlo
    // acá — antes de crear el usuario placeholder, la conversación o gastar el LLM. A un
    // mensaje real no se le responde nada (silencio); si viene por RPC (/simulate, con
    // `replyTo`), se contesta para no dejar al llamador esperando hasta el timeout.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) {
      this.logger.warn(
        `[${tenantId}] Mensaje de ${from} ignorado: la empresa está dada de baja o no existe.`,
      );
      if (msg.replyTo) {
        const notice = 'La empresa está dada de baja: el bot no atiende sus mensajes.';
        await this.broker.publish(
          msg.replyTo,
          {
            pattern: 'message.send',
            data: { to: from, body: notice },
            tenantId,
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: false },
        );
        return notice;
      }
      return '';
    }

    // 1. Identificar al usuario por teléfono, consultando el registro de usuarios.
    // "Conocido" = está registrado en este tenant, con rol (`UserTenant` + `Role`) —
    // no simplemente "existe un User con este teléfono".
    //
    // No hablamos con desconocidos (pedido 2026-08-27): un número sin membresía en
    // este tenant se rechaza acá mismo, antes de tocar la base para nada — no se crea
    // ningún `User` placeholder, no se abre `Conversation`, no se gasta LLM. Antes se
    // creaba una fila fantasma en `User` con `findOrCreateByPhone` solo para tener a
    // quién asignarle la conversación; quedó eliminado (ver `UsersService`) porque
    // ensuciaba la tabla real de usuarios con contactos que nunca fueron dados de alta.
    // El intento queda igual registrado — pero en archivo (`UnknownSenderLogService`,
    // un mes de retención), no en la BD: hoy es solo para poder mirar quién escribió
    // sin estar registrado; el día que haya rate limiting por número ahí sí va a hacer
    // falta un conteo persistente, no antes. Mismo criterio de silencio/aviso por RPC
    // que la baja de empresa, arriba.
    const membership = await this.usersService.findMembershipByPhone(from, tenantId);
    if (!membership) {
      this.unknownSenderLog.log({ tenantId, channel, from, bodyPreview: body.slice(0, 200) });
      this.logger.warn(`[${tenantId}] Mensaje de ${from} ignorado: no está registrado en este tenant.`);
      if (msg.replyTo) {
        const notice = 'Este número no está registrado: el bot no atiende mensajes de desconocidos.';
        await this.broker.publish(
          msg.replyTo,
          {
            pattern: 'message.send',
            data: { to: from, body: notice },
            tenantId,
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: false },
        );
        return notice;
      }
      return '';
    }
    const user = membership.user;
    const identity = {
      isKnown: true,
      roleId: membership.role.id,
      roleName: membership.role.name,
    };

    // 2. Buscar conversación activa, retomar una cerrada reciente, o crear una nueva
    let conversation = await this.prisma.conversation.findFirst({
      where: { userId: user.id, tenantId, channel, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!conversation) {
      // La última charla cerrada (nodo `end`, cancelación o fin de flujo) sigue
      // dentro de la ventana de reanudación: se reabre la misma Conversation —
      // mismo id — en vez de perder el flujo/ticket en curso. Los `Message` de
      // la charla anterior quedan igual en la fila (auditoría), pero
      // `sessionStartedAt` se resetea acá: es lo que usa `orchestratorLlm` para
      // no mandarle al LLM historial de antes del cierre como si fuera la
      // charla actual (ver ese método).
      const resumable = await this.prisma.conversation.findFirst({
        where: {
          userId: user.id,
          tenantId,
          channel,
          status: 'closed',
          closedAt: { gte: new Date(Date.now() - RESUME_WINDOW_MS) },
        },
        orderBy: { closedAt: 'desc' },
      });

      conversation = resumable
        ? await this.prisma.conversation.update({
            where: { id: resumable.id },
            data: { status: 'active', closedAt: null, sessionStartedAt: new Date() },
          })
        : await this.prisma.conversation.create({
            data: {
              userId: user.id,
              tenantId,
              channel,
              externalId: from,
              sessionStartedAt: new Date(),
            },
          });
    }

    // 2.5 Adjuntos (imágenes de WhatsApp vía Twilio, ver TwilioWebhookController): se
    // acumulan en flowState.pendingAttachments hasta que
    // el flujo llegue a un nodo `ticket_create` — pueden ser varios mensajes después de
    // este, así que no alcanza con tenerlos en memoria acá: hay que persistirlos ya mismo
    // (no esperar al persist de fin de turno de executeFlow, que ni corre si todavía no
    // hay flujo activo — ver el fallback al orquestador LLM más abajo).
    if (attachments.length) {
      const currentState = (conversation.flowState as Record<string, any>) || {};
      const pending: StoredAttachment[] = Array.isArray(currentState.pendingAttachments)
        ? currentState.pendingAttachments
        : [];
      conversation = await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          flowState: JSON.parse(
            JSON.stringify({ ...currentState, pendingAttachments: [...pending, ...attachments] }),
          ),
        },
      });
      this.logger.log(
        `[${tenantId}] ${attachments.length} adjunto(s) de ${from} guardados (pendingAttachments: ${pending.length + attachments.length}).`,
      );
    }

    // 3. Guardar mensaje del usuario. Un mensaje solo-imagen (sin texto) llega con `body`
    // vacío — placeholder legible en vez de una fila en blanco en el historial.
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'user',
        content: body || (attachments.length ? `[${attachments.length} imagen(es) adjunta(s)]` : ''),
      },
    });

    // 3.5 ¿Quiere cerrar/reiniciar la charla? Corre en cualquier punto de la
    // conversación (parado en un nodo, en el fallback libre del LLM, o sin
    // flujo activo) — a diferencia del "cancelar" de un nodo `input`, que solo
    // corta el dato puntual que se estaba pidiendo.
    if (this.looksLikeCancelAttempt(body) && (await this.confirmEndChatIntent(body))) {
      await this.closeConversation(conversation.id);
      const closingText = 'Listo, cerré la charla. Escribime cuando necesites algo más.';

      await this.prisma.message.create({
        data: { conversationId: conversation.id, senderType: 'assistant', content: closingText },
      });

      await this.broker.publish(
        msg.replyTo ?? outgoingQueue,
        {
          pattern: 'message.send',
          data: { to: from, body: closingText },
          tenantId,
          timestamp: new Date().toISOString(),
          correlationId: msg.correlationId,
        },
        { assert: !msg.replyTo },
      );

      this.logger.log(`[${tenantId}] Charla cerrada a pedido de ${from}`);
      return closingText;
    }

    // 4. EJECUTAR FLUJO IVR o ORQUESTADOR LLM
    let responseText: string;
    let interactive: WhatsAppInteractive | undefined;

    const flowResult = await this.executeFlow(conversation, user, body, tenantId, from, identity);
    if (flowResult) {
      responseText = flowResult.text;
      interactive = flowResult.interactive;
    } else {
      // `null` acá significa que no hay ningún flujo activo para este tenant/rol —
      // conversación libre, la toma el orquestador LLM. Un flujo que SÍ corrió pero no tuvo
      // nada que decir (ej. `notification` en modo link avanzando en silencio hacia un `end`
      // sin texto de cierre) llega con `flowResult.text === ''`, no acá — ver `toFlowResult`.
      responseText = await this.orchestratorLlm(conversation, body, tenantId, null, null);
    }

    // Turno silencioso a propósito (un flujo avanzó de nodo sin nada que mostrar todavía,
    // ej. justo el caso de arriba): no hay nada que guardar ni mandar por un canal real — sin
    // este corte, se guardaba un `Message` vacío y se publicaba un mensaje de WhatsApp en
    // blanco. Pero por RPC (`/simulate`, con `replyTo`) SÍ hay que publicar algo: `simulate()`
    // espera una respuesta con `broker.request()`, y sin este publish la request quedaba
    // colgada hasta SIMULATE_TIMEOUT_MS (5 min) en vez de devolver la respuesta vacía de una.
    if (!responseText && !interactive) {
      this.logger.log(`[${tenantId}] Turno silencioso para ${from} (el flujo avanzó sin responder).`);
      if (msg.replyTo) {
        await this.broker.publish(
          msg.replyTo,
          {
            pattern: 'message.send',
            data: { to: from, body: '' },
            tenantId,
            timestamp: new Date().toISOString(),
            correlationId: msg.correlationId,
          },
          { assert: false },
        );
      }
      return '';
    }

    // 6. Guardar respuesta del asistente
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'assistant',
        content: responseText,
      },
    });

    // 7. Publicar la respuesta.
    // Si el mensaje entrante traía `replyTo` (patrón RPC, usado por /simulate), la
    // respuesta va ahí en vez de a la cola real de salida — así el llamador que
    // está esperando la recibe, sin mezclarse con el tráfico de WhatsApp real.
    // Sin `replyTo` (mensajes reales entrando por whatsapp.incoming), se comporta
    // exactamente igual que antes.
    //
    // `assert: false` cuando es una respuesta RPC: esa cola ya la declaró
    // `ensureReplyConsumer()` como exclusiva, y reafirmarla acá sin esa propiedad
    // hace que RabbitMQ la rechace (ver el comentario en BrokerService.publish()).
    await this.broker.publish(
      msg.replyTo ?? outgoingQueue,
      {
        pattern: 'message.send',
        data: { to: from, body: responseText, interactive },
        tenantId,
        timestamp: new Date().toISOString(),
        correlationId: msg.correlationId,
      },
      { assert: !msg.replyTo },
    );

    this.logger.log(`[${tenantId}] Respuesta enviada a ${from}`);

    return responseText;
  }

  /**
   * Ejecuta un flujo IVR para la conversación actual.
   * Retorna la respuesta a enviar al usuario, o null si no hay flujo activo.
   *
   * Encadena nodos automáticamente hasta llegar a uno que espere input del usuario
   * (`menu`, `input`) o al final del flujo. Antes se ejecutaba **un nodo por mensaje
   * entrante**, así que un flujo `start → message → llm_query` necesitaba tres
   * mensajes del usuario para llegar a consultar al LLM.
   */
  private async executeFlow(
    conversation: any,
    user: any,
    body: string,
    tenantId: string,
    from: string,
    identity: { isKnown: boolean; roleId: string | null; roleName: string | null },
  ): Promise<{ text: string; interactive?: WhatsAppInteractive } | null> {
    // Buscar flujo activo. `null` de acá en adelante significa EXCLUSIVAMENTE "no hay flujo
    // activo para este tenant/rol" — las dos salidas de esta sección son las únicas; una vez
    // que el flujo arranca, todo retorno de esta función pasa por `toFlowResult`, que ya no
    // devuelve `null` (ver su comentario).
    let flowId = conversation.currentFlowId;
    let currentNodeId = conversation.currentNodeId;

    if (!flowId) {
      // El flujo de inicio se elige por (empresa + rol del usuario): `identity.roleId`
      // ya viene resuelto desde handleMessage contra el registro real de usuarios.
      // `new Date()` habilita la resolución de feriado/guardia (ver
      // FlowService.findActiveFlowForTenant) — se calcula una sola vez acá, nunca se
      // re-evalúa a mitad de conversación.
      const flow = await this.flowService.findActiveFlowForTenant(tenantId, identity.roleId, new Date());
      if (!flow) return null;
      flowId = flow.id;
      currentNodeId = this.findStartNodeId(flow.nodes as any[]);
      if (!currentNodeId) return null;
    }

    let flow = await this.flowService.findById(flowId);
    let nodes = flow.nodes as any[];
    let edges = flow.edges as any[];

    let flowState: Record<string, any> = (conversation.flowState as Record<string, any>) || {};
    const responses: string[] = [];
    let interactive: WhatsAppInteractive | undefined;
    let nodeId: string | null = currentNodeId;
    let steps = 0;

    while (nodeId && steps < MAX_FLOW_STEPS) {
      steps++;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) {
        // Nodo no encontrado (flujo editado bajo los pies, o un *TargetNodeId tipeado a
        // mano que no corresponde a ningún nodo real): resetear. WARN explícito — este
        // reset era completamente silencioso y del lado del usuario se ve como un turno
        // mudo seguido del flujo arrancando de cero (2026-08-28: un foundTargetNodeId
        // con un ID inexistente costó una tarde de debugging por este silencio).
        this.logger.warn(
          `Flujo ${flowId}: el nodo destino '${nodeId}' no existe en el flujo — se resetea ` +
            'la conversación. Si ese ID vino de foundTargetNodeId/missingTargetNodeId u otro ' +
            'campo de destino, corregilo en el editor (o dejalo vacío para usar la arista dibujada).',
        );
        await this.resetFlow(conversation.id);
        return this.toFlowResult(responses, interactive);
      }

      const result = await this.executeNode(
        node,
        body,
        conversation,
        user,
        tenantId,
        from,
        edges,
        flowState,
        identity,
        flowId,
        flow.contextSourceId,
        (flow as any).skill?.promptText ?? null,
      );

      // Actualizar flowState ANTES de interpolar: si este mismo nodo acaba de
      // setear una variable (ej. `start` con userName), el mensaje que devuelve
      // ya tiene que poder usarla.
      if (result.flowState) flowState = result.flowState;
      if (result.responseText) responses.push(this.interpolate(result.responseText, flowState));
      if (result.interactive) {
        interactive = this.interpolateInteractive(result.interactive, flowState);
        // WhatsApp solo admite un texto junto a los botones/lista: si antes de
        // este nodo se acumuló texto (saludo, mensajes previos encadenados),
        // tiene que ir todo junto en el body real — si no, se pierde apenas el
        // mensaje final resulta interactivo (justo lo que pasaba antes).
        interactive = { ...interactive, body: responses.join('\n\n') || interactive.body };
      }

      // Nodo `end`: cierre explícito y deliberado de la charla, retomable dentro
      // de RESUME_WINDOW_MS (ver búsqueda de conversación en `handleMessage`).
      if (result.endConversation) {
        await this.closeConversation(conversation.id);
        return this.toFlowResult(responses, interactive);
      }

      // El usuario canceló la gestión en curso (colloquial, detectado por LLM en
      // `menu`/`input`): termina el flujo igual que si hubiera llegado a su fin,
      // no sigue ninguna arista del nodo donde se quedó parado. Se cierra la
      // charla (retomable) en vez de solo resetear el flujo: si no, `status`
      // nunca deja de ser `active` y la conversación queda abierta para siempre.
      if (result.cancelFlow) {
        await this.closeConversation(conversation.id);
        return this.toFlowResult(responses, interactive);
      }

      // Transición a sub-flujo: cambia el flujo entero, no solo el nodo.
      if (flowState.__subflow) {
        const sub = flowState.__subflow;
        delete flowState.__subflow;
        flowId = sub.flowId;
        flow = await this.flowService.findById(flowId);
        nodes = flow.nodes as any[];
        edges = flow.edges as any[];
        nodeId = sub.entryNodeId;
        continue;
      }

      // El nodo pide esperar: se acumuló la respuesta y hay que devolver el turno.
      // Queda parado en sí mismo, así el próximo mensaje lo vuelve a ejecutar.
      if (result.waitForInput) {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return this.toFlowResult(responses, interactive);
      }

      let nextNodeId = this.resolveNextNode(node, edges, result);

      // Destino explícito roto (ej. un foundTargetNodeId tipeado a mano con un ID que no
      // corresponde a ningún nodo del flujo): antes esto seguía de largo y caía en el
      // reset silencioso del arranque del loop ("nodo no encontrado"), IGNORANDO la
      // arista que sí estaba bien dibujada en el canvas — el ID manual le ganaba a la
      // conexión real. Ahora, si el destino devuelto no existe, se reintenta la
      // resolución sin él (cae a sourceHandle/primera arista, ver resolveNextNode) y se
      // avisa por log. Solo aplica al destino que devuelve el nodo — un ID roto en una
      // ARISTA (edge.target) sigue yendo al reset de arriba, ahí no hay fallback posible.
      if (result.nextNodeId && nextNodeId === result.nextNodeId && !nodes.find((n) => n.id === nextNodeId)) {
        const fallback = this.resolveNextNode(node, edges, { ...result, nextNodeId: undefined });
        this.logger.warn(
          `Flujo ${flowId}: el nodo '${node.id}' devolvió el destino '${nextNodeId}', que no ` +
            `existe en el flujo (¿ID tipeado a mano en el editor?). ` +
            (fallback
              ? `Se sigue por la arista dibujada hacia '${fallback}'.`
              : 'No hay arista dibujada para caer — el flujo se cierra acá.'),
        );
        nextNodeId = fallback;
      }

      // Un nodo que apunta a sí mismo no es un bucle a ejecutar: es "quedate acá
      // esperando el próximo mensaje". Sin esto daría MAX_FLOW_STEPS vueltas, y en
      // un llm_query eso son 25 llamadas al modelo por cada mensaje entrante.
      if (nextNodeId === node.id) {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return this.toFlowResult(responses, interactive);
      }

      // `llm_query` SIN `extractVariables` (modo charla libre, no extracción) sin salida
      // es un punto final conversacional a propósito, no el fin del flujo: la
      // conversación queda parada ahí y los mensajes siguientes van derecho al modelo,
      // sin repetir el saludo ni los nodos previos.
      //
      // En modo EXTRACCIÓN, en cambio, este mismo chequeo era el bug reportado
      // (2026-08-28): un flujo sin arista dibujada desde el nodo (o sin
      // `foundTargetNodeId`/`missingTargetNodeId` configurado) quedaba parado ACÁ para
      // siempre apenas resolvía las variables — aunque ya tuviera sede/interno/lo que
      // sea con valor real (o "no definido", que es un resultado válido y esperado, no
      // uno pendiente). "No tengo a dónde ir configurado" no debería equivaler a "quedate
      // charlando acá indefinidamente": una vez que la extracción terminó (con o sin
      // éxito), lo correcto es seguir cualquier arista real que exista (ya lo intenta
      // `resolveNextNode` arriba) o, si de verdad no hay ninguna, cerrar el flujo como
      // cualquier otro nodo sin salida — no inventar un estado de "conversación libre"
      // que después termina en el LLM alucinando una respuesta sin que el flujo haya
      // hecho nada real (ej. "confirmar" un ticket que nunca se creó).
      if (!nextNodeId && node.type === 'llm_query' && !node.data?.extractVariables?.length) {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return this.toFlowResult(responses, interactive);
      }

      // `llm_query` en modo extracción que resolvió sus variables pero no tiene A DÓNDE
      // ir: es un problema de armado del flujo (falta la arista de salida en el editor,
      // o `foundTargetNodeId`/`missingTargetNodeId`), no del motor — el flujo va a
      // cerrar unos pasos más abajo como cualquier nodo sin salida. Se loguea fuerte
      // porque del lado del usuario esto se ve como un "turno silencioso" seguido de un
      // reinicio del flujo, y sin este WARN es indistinguible de un bug del motor
      // (2026-08-28: costó una tarde entera de debugging llegar hasta acá).
      if (!nextNodeId && node.type === 'llm_query' && node.data?.extractVariables?.length) {
        this.logger.warn(
          `Flujo ${flowId}: el nodo llm_query '${node.id}' resolvió sus variables pero no ` +
            'tiene arista de salida ni foundTargetNodeId/missingTargetNodeId — no hay a ' +
            'dónde avanzar, el flujo se cierra acá. Conectá la salida del nodo en el editor.',
        );
      }

      nodeId = nextNodeId;
    }

    if (steps >= MAX_FLOW_STEPS) {
      // Ciclo entre nodos no interactivos: cortamos para no colgar la request.
      this.logger.error(
        `Flujo ${flowId} superó ${MAX_FLOW_STEPS} pasos sin esperar input. ¿Hay un ciclo?`,
      );
      await this.resetFlow(conversation.id);
      responses.push('Se interrumpió el flujo por un problema de configuración.');
      return { text: responses.join('\n\n') };
    }

    // Fin del flujo: se acabaron los nodos. Sin un nodo `end` explícito, esto
    // igual cierra la charla (retomable) — antes quedaba `active` para siempre.
    await this.closeConversation(conversation.id);
    return this.toFlowResult(responses, interactive);
  }

  /**
   * Junta las respuestas acumuladas de `executeFlow` en el resultado final. Siempre devuelve
   * un objeto —nunca `null`— porque para cuando se llama, el flujo YA corrió: `null` en
   * `executeFlow` significa exclusivamente "no hay ningún flujo activo para este tenant/rol"
   * (las dos salidas tempranas, antes de este punto). Confundir "el flujo corrió pero no tuvo
   * nada que decir" (ej. `notification` en modo link avanzando en silencio hacia un `end` sin
   * texto de cierre) con "no hay flujo" era el bug: `handleMessage` trataba el primer caso
   * como charla libre y le pasaba el turno al LLM orquestador sin que nadie lo pidiera.
   */
  private toFlowResult(
    responses: string[],
    interactive?: WhatsAppInteractive,
  ): { text: string; interactive?: WhatsAppInteractive } {
    return { text: responses.join('\n\n'), interactive };
  }

  /** Guarda en qué punto del flujo quedó la conversación. */
  private async persistFlowPosition(
    conversationId: string,
    flowId: string,
    nodeId: string | null,
    flowState: Record<string, any>,
  ) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        currentFlowId: flowId,
        currentNodeId: nodeId,
        flowState: JSON.parse(JSON.stringify(flowState ?? {})),
      },
    });
  }

  /**
   * Decide el siguiente nodo. Prioridad:
   *  1. target explícito devuelto por el nodo (menús, condiciones)
   *  2. arista que sale del handle correspondiente (`sourceHandle`), que es lo que
   *     dibuja el editor visual
   *  3. primera arista que salga del nodo
   */
  private resolveNextNode(
    node: any,
    edges: any[],
    result: { nextNodeId?: string; sourceHandle?: string },
  ): string | null {
    if (result.nextNodeId) return result.nextNodeId;

    const outgoing = edges.filter((e) => e.source === node.id);

    if (result.sourceHandle) {
      const byHandle = outgoing.find((e) => e.sourceHandle === result.sourceHandle);
      if (byHandle) return byHandle.target;
    }

    return outgoing[0]?.target ?? null;
  }

  /** Palabras que activan el chequeo (por LLM) de si un `input` es en realidad un pedido de cancelación. */
  private static readonly CANCEL_HINT_WORDS = [
    'cancel',
    'olvid',
    'dejalo',
    'déjalo',
    'dejemoslo',
    'dejémoslo',
    'mejor no',
    'no quiero',
    'no importa',
    'da igual',
    'nada',
    'chau',
    'salir',
    'volver',
    'basta',
    'no sigas',
    'no sigo',
    'no continu',
    'ya no',
    'despues',
    'después',
    // Raíces en vez de la palabra completa: así matchean también las formas
    // conjugadas ("cerremos", "termina", "reiniciemos") que un `.includes()`
    // con el infinitivo se perdía.
    'cerr',
    'termin',
    'reinici',
    'adios',
    'adiós',
    'hasta luego',
    'nos vemos',
  ];

  private looksLikeCancelAttempt(body: string): boolean {
    const normalized = body.trim().toLowerCase();
    if (!normalized) return false;
    // El id sintético del botón "Volver" (`BACK_OPTION_VALUE`) contiene la palabra
    // "volver" y matchearía por substring contra CANCEL_HINT_WORDS — pero es una
    // navegación de menú, nunca un pedido de cancelar/cerrar la charla. Se excluye
    // por igualdad exacta antes de aplicar la heurística de texto libre.
    if (normalized === BACK_OPTION_VALUE) return false;
    return ConversationsService.CANCEL_HINT_WORDS.some((w) => normalized.includes(w));
  }

  /** Corta el nodo actual y termina el flujo, como si hubiera llegado a su fin normalmente. */
  private cancelInteraction(flowState: Record<string, any>): {
    responseText: string;
    flowState: any;
    cancelFlow: true;
  } {
    delete flowState.__awaiting;
    return {
      responseText: 'Listo, cancelé la gestión. Decime si necesitás otra cosa.',
      flowState,
      cancelFlow: true,
    };
  }

  /**
   * Vuelve al menú que quedó en el tope de `menuStack` (ver `case 'menu'`).
   * Si ese menú pertenece a otro `Flow` (submenú entrado vía nodo `subflow`),
   * reusa el mismo mecanismo de cambio de flujo que `case 'subflow'`
   * (`flowState.__subflow`, leído por el loop principal de `executeFlow`) en
   * vez de duplicar esa lógica acá.
   */
  private navigateMenuBack(
    flowState: Record<string, any>,
    menuStack: MenuStackEntry[],
    currentFlowId: string,
  ): NodeExecutionResult {
    const stack = [...menuStack];
    const target = stack.pop();
    flowState.__menuStack = stack;

    // No debería pasar — "Volver" solo se ofrece cuando la pila no está vacía —
    // pero ante un flowState corrupto de una sesión vieja, mejor no romper nada.
    if (!target) {
      return { flowState };
    }

    if (target.flowId !== currentFlowId) {
      return { flowState: { ...flowState, __subflow: { flowId: target.flowId, entryNodeId: target.nodeId } } };
    }
    return { nextNodeId: target.nodeId, flowState };
  }

  /**
   * Le pregunta al LLM si un mensaje que ya activó `looksLikeCancelAttempt` es
   * un pedido de cerrar o reiniciar la charla entera (despedida, "cerrá esto",
   * "quiero reiniciar"), a diferencia de `confirmCancelIntent` que evalúa si es
   * una cancelación del dato puntual que pedía un nodo `input`. Ante cualquier
   * error del proveedor, no cierra — mejor seguir la charla de más que cortarla
   * de golpe por una falla transitoria del LLM.
   */
  private async confirmEndChatIntent(body: string): Promise<boolean> {
    try {
      const raw = await this.llmService.chat(
        [
          {
            role: 'system',
            content:
              'Sos un clasificador de intención para un chatbot de soporte. Respondé EXCLUSIVAMENTE con ' +
              'la palabra CERRAR si el mensaje del usuario pide terminar, cerrar o reiniciar la charla ' +
              'completa (despedidas como "chau", "gracias, eso es todo", o pedidos explícitos como "cerrá ' +
              'la charla", "quiero reiniciar", "terminemos acá"), o con la palabra SEGUIR si el mensaje es ' +
              'cualquier otra cosa (una pregunta, un dato que se le pidió, o parte normal de la charla en ' +
              'curso). Una sola palabra, sin nada más.',
          },
          { role: 'user', content: `Mensaje del usuario: "${body}"` },
        ],
        { temperature: 0, maxTokens: CLASSIFIER_MAX_TOKENS },
      );
      return raw.trim().toUpperCase().startsWith('CERRAR');
    } catch (err) {
      this.logger.warn(`No se pudo evaluar intención de cierre de charla: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Le pregunta al LLM si un mensaje que ya activó `looksLikeCancelAttempt` es
   * realmente una cancelación o una respuesta válida al dato pedido. Ante
   * cualquier error del proveedor, no cancela — el peor caso es que el `input`
   * guarde un texto raro, no que se pierda una gestión en curso por una falla
   * transitoria del LLM.
   */
  private async confirmCancelIntent(body: string, question: string | undefined): Promise<boolean> {
    try {
      const raw = await this.llmService.chat(
        [
          {
            role: 'system',
            content:
              'Sos un clasificador de intención para un chatbot de soporte. El bot le pidió un dato al ' +
              'usuario y esa es la pregunta pendiente. Respondé EXCLUSIVAMENTE con la palabra CANCELAR ' +
              'si el mensaje del usuario indica que quiere abandonar, cancelar o no continuar con lo que ' +
              'se le pidió (en cualquier forma coloquial: "dejalo", "mejor no", "no quiero seguir", "da ' +
              'igual", etc.), o con la palabra CONTINUAR si el mensaje es simplemente su respuesta al ' +
              'dato pedido (aunque no sepas si es correcta). Una sola palabra, sin nada más.',
          },
          {
            role: 'user',
            content: `Se le pidió: "${question || 'un dato'}"\nMensaje del usuario: "${body}"`,
          },
        ],
        { temperature: 0, maxTokens: CLASSIFIER_MAX_TOKENS },
      );
      return raw.trim().toUpperCase().startsWith('CANCEL');
    } catch (err) {
      this.logger.warn(`No se pudo evaluar intención de cancelación: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Interpreta una respuesta de menú que no matcheó literalmente ninguna opción:
   * puede ser una cancelación coloquial, o el usuario describiendo en lenguaje
   * natural lo que quiere sin usar el texto exacto de la opción. Ante cualquier
   * error del proveedor, no matchea nada — cae al mensaje de "no entendí" en
   * vez de arriesgar una ruta equivocada.
   */
  private async interpretMenuChoice(
    body: string,
    options: any[],
  ): Promise<{ cancel: boolean; optionValue?: string }> {
    if (!options.length) return { cancel: false };

    const listado = options
      .map((opt: any) => `- ${opt.label} (valor: ${opt.value})`)
      .join('\n');

    try {
      const raw = await this.llmService.chat(
        [
          {
            role: 'system',
            content:
              'Sos un clasificador de intención para un menú de opciones de un chatbot de soporte. Te ' +
              'paso las opciones disponibles y un mensaje del usuario que no coincidió literalmente con ' +
              'ninguna. Respondé EXCLUSIVAMENTE con una de estas tres cosas, sin texto adicional:\n' +
              '- el "valor" exacto (tal cual aparece entre paréntesis) de la opción, si el mensaje del ' +
              'usuario se corresponde claramente con esa opción aunque no la haya escrito literal (ej: ' +
              '"se me rompió la impresora" corresponde a una opción de soporte técnico)\n' +
              '- CANCELAR, si el usuario quiere abandonar o cancelar la gestión actual, en cualquier ' +
              'forma coloquial ("dejalo", "mejor no", "no quiero seguir", etc.)\n' +
              '- NINGUNA, si el mensaje no se corresponde con ninguna opción ni es una cancelación',
          },
          {
            role: 'user',
            content: `Opciones:\n${listado}\n\nMensaje del usuario: "${body}"`,
          },
        ],
        { temperature: 0, maxTokens: CLASSIFIER_MAX_TOKENS },
      );

      const answer = raw.trim();
      if (answer.toUpperCase().startsWith('CANCEL')) return { cancel: true };
      const matched = options.find((opt: any) => String(opt.value) === answer);
      return matched ? { cancel: false, optionValue: String(matched.value) } : { cancel: false };
    } catch (err) {
      this.logger.warn(`No se pudo interpretar la opción de menú: ${(err as Error).message}`);
      return { cancel: false };
    }
  }

  /**
   * Arma botones (≤3 opciones) o una lista (≤10) para un nodo `menu`, cuando la
   * cantidad de opciones lo permite — WhatsApp no soporta más de 10 filas en un
   * mensaje interactivo. Con más opciones (o ninguna), se sigue usando el texto
   * numerado de siempre.
   */
  private buildMenuInteractive(headerText: string | undefined, options: any[]): WhatsAppInteractive | undefined {
    if (!options.length || options.length > 10) return undefined;
    const body = (headerText ?? '').trim() || 'Elegí una opción:';

    if (options.length <= 3) {
      return {
        type: 'button',
        body,
        buttons: options.map((opt: any) => ({
          id: String(opt.value),
          title: String(opt.label).slice(0, 20),
        })),
      };
    }

    return {
      type: 'list',
      body,
      buttonText: 'Elegir opción',
      rows: options.map((opt: any) => ({
        id: String(opt.value),
        title: String(opt.label).slice(0, 24),
      })),
    };
  }

  /** Botón de link para el nodo `notification` en modo `link` — ver ese `case`. */
  private buildCtaInteractive(
    headerText: string | undefined,
    buttonLabel: string,
    url: string,
  ): WhatsAppInteractive {
    return {
      type: 'cta_url',
      body: (headerText ?? '').trim() || 'Ver más:',
      buttonText: buttonLabel.slice(0, 20),
      url,
    };
  }

  /**
   * Los campos de config que declaran un nombre de variable (`input.variableName`,
   * `variable.name`, `ticket_query.ticketIdVariable`, `llm_query.extractVariable`)
   * a veces se cargan con el placeholder completo (`{{descripcion}}`) en vez del
   * nombre pelado (`descripcion`) — error fácil de cometer copiando desde el texto
   * de otro nodo. Sin esto, `flowState["{{descripcion}}"]` queda guardado bajo una
   * clave que `interpolate()` nunca busca (busca `flowState["descripcion"]`), y el
   * placeholder se ve tal cual en la respuesta al usuario en vez de reemplazarse.
   */
  private stripVariableBraces(name: string): string {
    return name.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
  }

  /**
   * Reemplaza `{{variable}}` por `flowState[variable]` en el texto de un nodo
   * (ej. `Hola {{userName}}`, con `userName` seteado por el nodo `start`). Si la
   * variable no existe en `flowState`, deja el placeholder tal cual — mejor que
   * un mensaje incompleto en silencio, así se nota el typo en el flujo.
   */
  private interpolate(text: string, flowState: Record<string, any>): string {
    return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (placeholder, key) => {
      const value = flowState[key];
      return value === undefined || value === null ? placeholder : String(value);
    });
  }

  /** Mismo reemplazo de `{{variable}}` que `interpolate`, aplicado a un mensaje interactivo (botones/lista/CTA). */
  private interpolateInteractive(
    interactive: WhatsAppInteractive,
    flowState: Record<string, any>,
  ): WhatsAppInteractive {
    if (interactive.type === 'button') {
      return {
        ...interactive,
        body: this.interpolate(interactive.body, flowState),
        buttons: interactive.buttons.map((b) => ({ ...b, title: this.interpolate(b.title, flowState) })),
      };
    }
    if (interactive.type === 'cta_url') {
      return {
        ...interactive,
        body: this.interpolate(interactive.body, flowState),
        buttonText: this.interpolate(interactive.buttonText, flowState),
        // La URL también admite variables (ej. un link con el id de ticket recién creado).
        url: this.interpolate(interactive.url, flowState),
      };
    }
    return {
      ...interactive,
      body: this.interpolate(interactive.body, flowState),
      buttonText: this.interpolate(interactive.buttonText, flowState),
      rows: interactive.rows.map((r) => ({
        ...r,
        title: this.interpolate(r.title, flowState),
        description: r.description ? this.interpolate(r.description, flowState) : r.description,
      })),
    };
  }

  private findStartNodeId(nodes: any[]): string | null {
    // Buscar nodo de tipo 'start' o el primer nodo sin aristas entrantes
    const startNode = nodes.find((n) => n.type === 'start');
    if (startNode) return startNode.id;
    return nodes[0]?.id ?? null;
  }

  private async resetFlow(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { currentFlowId: null, currentNodeId: null, flowState: Prisma.JsonNull },
    });
  }

  /**
   * Cierra sola toda charla `active` sin mensajes en los últimos
   * INACTIVITY_TIMEOUT_MS. `messages: { none: { createdAt: { gte: cutoff } } }`
   * — sin mensaje propio, no hay `Conversation.updatedAt` ni ningún otro campo
   * de "última actividad" confiable: `persistFlowPosition` solo toca la fila en
   * pasos que avanzan el flujo, no en cada mensaje entrante (ej. un `menu` que
   * espera input no la vuelve a tocar).
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  private async closeInactiveConversations() {
    const cutoff = new Date(Date.now() - INACTIVITY_TIMEOUT_MS);
    const stale = await this.prisma.conversation.findMany({
      where: { status: 'active', messages: { none: { createdAt: { gte: cutoff } } } },
      select: { id: true },
    });

    if (stale.length === 0) return;

    await Promise.all(stale.map((c) => this.closeConversation(c.id)));
    this.logger.log(`Cerradas ${stale.length} charla(s) por inactividad (>${INACTIVITY_TIMEOUT_MS / 60_000}min)`);
  }

  /** Cierra la charla (nodo `end`, cancelación del usuario o fin del flujo). Queda retomable dentro de RESUME_WINDOW_MS. */
  private async closeConversation(conversationId: string) {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'closed',
        closedAt: new Date(),
        currentFlowId: null,
        currentNodeId: null,
        flowState: Prisma.JsonNull,
      },
    });
  }

  /**
   * Nodo `device_validation`: valida que este número de WhatsApp + el email del
   * usuario ya pasaron por un código de verificación, dentro de la vigencia
   * definida por `DEVICE_FINGERPRINT_TTL_DAYS`.
   *
   * - Dispositivo ya validado y vigente → nodo transparente, sigue de largo sin
   *   mensaje ni espera (como `variable` o `delay`).
   * - No validado o vencido → avisa que mandó un código al email registrado y
   *   queda esperando que el usuario lo escriba.
   */
  private async executeDeviceValidationNode(
    node: any,
    body: string,
    user: any,
    from: string,
    flowState: Record<string, any>,
    customText: string | undefined,
  ): Promise<NodeExecutionResult> {
    const email: string | undefined = user?.email;

    // Sin email real no hay a dónde mandar el código — el email autogenerado
    // para usuarios que solo existen por WhatsApp (ver UsersService) no sirve.
    if (!email || email.endsWith('@local.pci')) {
      return {
        responseText:
          'No podemos validar este dispositivo porque no tenés un email registrado. ' +
          'Contactate con soporte para que te lo carguen.',
        endConversation: true,
      };
    }

    const fingerprint = this.computeDeviceFingerprint(from, email);

    // Primera llegada a este nodo (no esperando código todavía): revisar si ya
    // hay un dispositivo validado y vigente para este teléfono + email.
    if (flowState.__awaiting !== node.id) {
      const existing = await this.prisma.deviceValidation.findUnique({ where: { fingerprint } });
      const isValid = !!existing && existing.userId === user.id && existing.expiresAt > new Date();

      if (isValid) {
        return {}; // Transparente: no hay nada que decir, sigue al próximo nodo.
      }

      return this.sendDeviceValidationCode(node.id, email, fingerprint, flowState, customText);
    }

    // Esperando el código: ¿venció mientras tanto? Mandamos uno nuevo en vez de
    // dejar al usuario tipeando un código que ya no sirve.
    const expiresAt = flowState.__deviceValidationExpiresAt;
    if (!expiresAt || Date.now() > expiresAt) {
      return this.sendDeviceValidationCode(node.id, email, fingerprint, flowState, customText, true);
    }

    if (body.trim() !== flowState.__deviceValidationCode) {
      return {
        responseText: 'Ese código no es correcto. Fijate bien y volvé a escribirlo.',
        waitForInput: true,
        flowState,
      };
    }

    // Código correcto: registrar el dispositivo como validado por
    // DEVICE_FINGERPRINT_TTL_DAYS y limpiar el estado transitorio del nodo.
    delete flowState.__awaiting;
    delete flowState.__deviceValidationCode;
    delete flowState.__deviceValidationExpiresAt;

    const ttlDays = await this.appConfig.deviceFingerprintTtlDays();
    const expiresAtNew = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    await this.prisma.deviceValidation.upsert({
      where: { fingerprint },
      update: { userId: user.id, phone: from, email, expiresAt: expiresAtNew },
      create: { userId: user.id, phone: from, email, fingerprint, expiresAt: expiresAtNew },
    });

    return { flowState };
  }

  /** Genera y manda un código nuevo, y deja el nodo esperando que lo escriban. */
  private async sendDeviceValidationCode(
    nodeId: string,
    email: string,
    fingerprint: string,
    flowState: Record<string, any>,
    customText: string | undefined,
    isRenewal = false,
  ): Promise<NodeExecutionResult> {
    const ttlSeconds = await this.appConfig.otpTtlSeconds();
    const code = await this.generateOtpCode();

    flowState.__awaiting = nodeId;
    flowState.__deviceValidationCode = code;
    flowState.__deviceValidationExpiresAt = Date.now() + ttlSeconds * 1000;

    const defaultSubject = 'Código de validación de dispositivo - Plataforma Conversacional Inteligente';
    const subject =
      (await this.appConfig.get('DEVICE_VALIDATION_EMAIL_SUBJECT', defaultSubject)) || defaultSubject;

    await this.emailService.send({
      to: email,
      subject,
      text: `Tu código de validación es: ${code}. Válido por ${Math.round(ttlSeconds / 60)} minutos.`,
    });

    const message =
      customText?.trim() || `Te mandamos un código de validación a ${email}. Escribime el código para continuar.`;

    return {
      responseText: (isRenewal ? 'Ese código venció, te mandamos uno nuevo. ' : '') + message,
      waitForInput: true,
      flowState,
    };
  }

  /** hash(teléfono + email) — identifica el dispositivo sin guardar el email en claro dos veces. */
  private computeDeviceFingerprint(phone: string, email: string): string {
    return createHash('sha256').update(`${phone}:${email.toLowerCase()}`).digest('hex');
  }

  /** Código numérico de `OTP_CODE_LENGTH` dígitos, mismo esquema que `AuthService.sendOtp`. */
  private async generateOtpCode(): Promise<string> {
    const length = await this.appConfig.otpCodeLength();
    const min = 10 ** (length - 1);
    return Math.floor(min + Math.random() * (min * 9)).toString();
  }

  /**
   * `customer_id` de InvGate para el `User` local dado. Usa `invgateUserId` si ya está
   * cargado (alta manual desde el backoffice); si no, lo resuelve por teléfono contra
   * InvGate y lo deja guardado ahí mismo para no repetir la búsqueda la próxima vez —
   * mismo campo que ya usa el CRUD de usuarios (`UsersService`), esto es lo primero que
   * lo completa automáticamente en vez de a mano.
   */
  private async resolveInvgateCustomerId(userId: string, phone: string): Promise<number | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { invgateUserId: true } });
    if (user?.invgateUserId) {
      const parsed = Number(user.invgateUserId);
      if (Number.isFinite(parsed)) return parsed;
    }

    const normalizedPhone = stripArgentinaMobileNine(phone);
    const found = await this.invgateService.findUserByPhone(normalizedPhone).catch((err) => {
      this.logger.warn(`No se pudo buscar el usuario de InvGate por teléfono ${normalizedPhone}: ${err.message}`);
      return null;
    });
    if (!found) {
      this.logger.warn(`Ningún usuario de InvGate matchea el teléfono ${normalizedPhone} — el ticket no se sincroniza.`);
      return null;
    }

    await this.prisma.user.update({ where: { id: userId }, data: { invgateUserId: String(found.id) } }).catch(() => {
      // No debería fallar (el id de InvGate recién resuelto no puede colisionar con
      // otro ya guardado salvo carrera rarísima) — si pasa, seguimos igual: el ticket
      // ya tiene el customerId resuelto en memoria, solo no queda cacheado para la próxima.
    });
    return found.id;
  }

  /**
   * Empuja un `Ticket` recién creado a InvGate y guarda el id remoto en `Ticket.invgateId`.
   * Best-effort a propósito: si InvGate está mal configurado, caído, o el usuario no
   * matchea ningún `customer_id`, el ticket local ya existe igual — nunca se corta la
   * charla ni se le muestra un error al usuario por esto. Mismo criterio que
   * `confirmCancelIntent`/`confirmEndChatIntent`: ante una falla del proveedor externo,
   * seguir con el camino local en vez de romper la conversación.
   *
   * `fields` son NOMBRES (no IDs) de categoría/prioridad/tipo recolectados durante la
   * charla — típicamente `flowState.category`/`flowState.priority`/`flowState.ticketType`,
   * seteados por un nodo `input`/`menu` del flujo. `InvgateService.createTicketForChat`
   * los resuelve contra el catálogo real de esta instancia; sin match (o sin que la
   * charla haya seteado nada) cae al default configurado en `/settings`.
   */
  /**
   * Devuelve el número de incidente de InvGate (`incident.id` — mismo número que su
   * `pretty_id`, ej. 33 → "#33") cuando sincroniza, o `null` si no (InvGate sin
   * configurar, customer_id sin resolver, o cualquier error) — así el que llama puede
   * mostrarle al usuario el ticket REAL de InvGate en vez del id interno (cuid, sin
   * sentido para quien lo recibe) cuando está disponible, y caer al id local si no.
   */
  private async syncTicketToInvgate(
    ticket: { id: string; userId: string; subject: string; description: string | null },
    from: string,
    fields: { categoryName?: string; priorityName?: string; typeName?: string } = {},
    attachments: IncidentAttachment[] = [],
  ): Promise<number | null> {
    if (!(await this.invgateService.isConfigured())) return null;

    try {
      const customerId = await this.resolveInvgateCustomerId(ticket.userId, from);
      if (!customerId) return null;

      const incident = await this.invgateService.createTicketForChat(
        customerId,
        ticket.subject,
        ticket.description ?? undefined,
        fields,
        attachments,
      );
      if (!incident) return null;

      await this.prisma.ticket.update({ where: { id: ticket.id }, data: { invgateId: String(incident.id) } });
      this.logger.log(`Ticket local ${ticket.id} sincronizado con InvGate #${incident.id}`);
      return incident.id;
    } catch (err) {
      this.logger.warn(`No se pudo sincronizar el ticket ${ticket.id} con InvGate: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Lee en memoria los adjuntos pendientes de la charla (ver flowState.pendingAttachments,
   * llenado en handleMessage) para mandarlos con el ticket, y borra el archivo temporal de
   * cada uno apenas se lee — con o sin éxito en InvGate no tiene sentido conservarlos en
   * disco después de este punto, los tickets acá son best-effort y sin reintento.
   */
  private async loadAttachments(pending: StoredAttachment[]): Promise<IncidentAttachment[]> {
    const loaded: IncidentAttachment[] = [];
    for (const att of pending) {
      const data = await this.twilioMedia.read(att);
      await this.twilioMedia.delete(att);
      if (data) loaded.push({ filename: att.filename, contentType: att.contentType, data });
    }
    return loaded;
  }

  /**
   * Convierte el HTML de InvGate (editor WYSIWYG — ver `InvgateService.toInvgateHtml`)
   * de vuelta a texto plano para WhatsApp. Best-effort, no un parser HTML real: alcanza
   * para lo que InvGate genera (`<br>`, `<p>`, entidades).
   */
  private stripInvgateHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) =>
        this.decodeHtmlEntity(match, entity),
      )
      .trim();
  }

  /**
   * Una entidad HTML a su carácter. Se resuelven todas en UNA sola pasada (ver el `replace` de
   * `stripInvgateHtml`) a propósito: encadenando un `.replace` por entidad, `&amp;nbsp;` termina
   * convertido en un espacio en vez de en el texto literal "&nbsp;", porque el `&amp;` se decodifica
   * primero y lo que queda vuelve a matchear.
   *
   * Incluye las NUMÉRICAS (`&#160;`, `&#xA0;`), que antes no se tocaban: InvGate manda el espacio
   * duro en hexa y quedaba visible como "&#xA0;" al final de cada línea del comentario (2026-08-31,
   * visto en un ticket real). Ante una entidad desconocida devuelve el texto original tal cual, que
   * es más honesto que comerse el contenido.
   */
  private decodeHtmlEntity(match: string, entity: string): string {
    const NAMED: Record<string, string> = {
      nbsp: ' ',
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };

    if (!entity.startsWith('#')) return NAMED[entity.toLowerCase()] ?? match;

    const isHex = entity[1] === 'x' || entity[1] === 'X';
    const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
    // Espacios "duros" (NBSP y narrow NBSP) a espacio común: en WhatsApp no se distinguen de uno
    // normal, pero sí se escapan del `trim`/de cualquier colapso de espacios posterior.
    if (code === 0xa0 || code === 0x202f) return ' ';
    // Fuera de rango o surrogate suelto: `String.fromCodePoint` tiraría RangeError.
    const invalid = !Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
    return invalid ? match : String.fromCodePoint(code);
  }

  /**
   * Nodo `ticket_query`, paso "elegir ticket": arma la lista interactiva con los
   * tickets abiertos del usuario, más recientes primero, tope `MAX_TICKET_LIST_ROWS`
   * por el límite de WhatsApp.
   *
   * Consulta InvGate EN VIVO (`incidents.by.customer`) en vez de la tabla local
   * `Ticket` — la local solo tiene los tickets que el propio bot creó y su estado
   * cacheado puede estar desactualizado (no hay webhook de InvGate). `incidents.by.customer`
   * es el único endpoint de esta API que lista por cliente (no aparece en la doc
   * pública que uso de referencia para el resto del cliente — confirmado contra la
   * instancia real 2026-08-24; `incident.by.customer`, singular, no existe, 404).
   *
   * `customerId` ya viene resuelto (ver `resolveInvgateCustomerId`, llamado por
   * quien invoca esto) — así se resuelve una sola vez por turno aunque este paso y
   * el de detalle lo necesiten los dos. `interactive: null` significa que el
   * cliente no tiene ningún ticket abierto.
   */
  private async buildOpenTicketsList(
    customerId: number,
  ): Promise<{ interactive: WhatsAppInteractive | null; truncated: boolean }> {
    const incidents = await this.invgateService.listCustomerIncidents(customerId).catch((err) => {
      this.logger.warn(`No se pudo listar los tickets de InvGate del cliente ${customerId}: ${err.message}`);
      return [];
    });

    // `status_id` → nombre: `getStatusName` cachea el catálogo completo en memoria
    // (una sola llamada real), así que resolver el de cada incidente acá es un
    // lookup en un Map, no N llamadas a la API.
    const withStatus = await Promise.all(
      incidents.map(async (inc) => ({
        inc,
        statusName: inc.status_id !== undefined ? await this.invgateService.getStatusName(inc.status_id) : '',
      })),
    );
    const open = withStatus
      .filter((x) => isOpenTicketStatus(x.statusName))
      .sort((a, b) => Number(b.inc.created_at ?? 0) - Number(a.inc.created_at ?? 0));
    const shown = open.slice(0, MAX_TICKET_LIST_ROWS);
    if (!shown.length) return { interactive: null, truncated: false };

    const rows = shown.map(({ inc, statusName }) => {
      const ref = (inc.pretty_id as string | undefined) ?? `#${inc.id}`;
      return {
        id: String(inc.id),
        title: `${ref} ${inc.title ?? ''}`.trim().slice(0, 24),
        description: statusName.slice(0, 72),
      };
    });

    return {
      interactive: { type: 'list', body: 'Elegí un ticket:', buttonText: 'Ver tickets', rows },
      truncated: open.length > shown.length,
    };
  }

  /**
   * Nodo `ticket_query`, paso "ver detalle": trae el incidente puntual por id
   * (`GET incident`, siempre en vivo, con `comments=true`) y arma el texto con
   * estado, prioridad, fecha, agente asignado y el ÚLTIMO comentario (no la
   * descripción original del ticket, que es lo que el usuario ya sabe porque la
   * escribió él mismo — lo útil acá es la última novedad). `customerId` es el
   * cliente de InvGate del USUARIO que está preguntando — si el incidente
   * encontrado le pertenece a otro cliente, se considera "no encontrado" (mismo
   * criterio que el filtro por `tenantId` en el resto de los accesos a `Ticket`:
   * `body` puede ser cualquier texto tipeado a mano, no solo el id de una fila
   * que se le mostró, así que sin este chequeo cualquiera podría ver el ticket
   * de otra persona adivinando un id bajo).
   */
  private async buildTicketDetailText(incidentId: string, customerId: number): Promise<string | null> {
    const incident = await this.invgateService.getIncident(incidentId, { includeComments: true }).catch(() => null);
    if (!incident || Number(incident.user_id) !== customerId) return null;

    const [statusName, priorityName, assignedName, lastComment] = await Promise.all([
      incident.status_id !== undefined ? this.invgateService.getStatusName(incident.status_id) : Promise.resolve('sin definir'),
      incident.priority_id !== undefined
        ? this.invgateService.getPriorityName(Number(incident.priority_id))
        : Promise.resolve('sin definir'),
      this.resolveAssignedAgentName(incident.assigned_id),
      this.resolveLastCustomerVisibleComment(incident.comments),
    ]);

    const ref = (incident.pretty_id as string | undefined) ?? `#${incident.id}`;
    const created = incident.created_at ? new Date(String(incident.created_at)).toLocaleDateString('es-AR') : 'sin dato';

    const lines = [
      `Ticket ${ref}: ${incident.title ?? ''}`,
      `Estado: ${statusName}`,
      `Prioridad: ${priorityName}`,
      `Creado: ${created}`,
      `Asignado a: ${assignedName ?? 'sin asignar'}`,
    ];
    lines.push(
      lastComment
        ? lastComment.authorName
          ? `Último comentario (${lastComment.authorName}): ${lastComment.text}`
          : `Último comentario: ${lastComment.text}`
        : 'Sin comentarios aún.',
    );
    return lines.join('\n');
  }

  /**
   * Último comentario VISIBLE PARA EL CLIENTE de un incidente (`incident.comments`, viene de
   * `GET incident?comments=true`) — nunca uno interno (`customer_visible: false`): sería una
   * nota privada del equipo, no algo para mostrarle al usuario que está consultando su ticket.
   *
   * ⚠️ Forma de cada comentario sin confirmar contra tráfico real todavía (misma deuda que el
   * resto de esta integración, ver el comentario de cabecera de `InvgateService`) — relevada
   * contra la documentación pública (`message`/`author_id`/`created_at`/`customer_visible`),
   * no contra una respuesta real capturada. Devuelve `null` ante cualquier forma inesperada
   * (campo con otro nombre, no es array, etc.) en vez de romper el detalle del ticket por esto.
   */
  private async resolveLastCustomerVisibleComment(
    rawComments: unknown,
  ): Promise<{ text: string; authorName: string | null } | null> {
    if (!Array.isArray(rawComments) || !rawComments.length) return null;

    const visible = rawComments.filter((c): c is Record<string, unknown> => {
      if (!c || typeof c !== 'object') return false;
      const v = (c as Record<string, unknown>).customer_visible;
      return v === true || v === 1 || v === '1';
    });
    if (!visible.length) return null;

    // Más reciente primero: `created_at` (epoch o ISO-8601, ambos comparan bien como texto
    // creciente/decreciente salvo casos borde) con `msg_num`/`id` como desempate si faltara.
    const sorted = [...visible].sort((a, b) => {
      const byDate = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
      if (byDate !== 0) return byDate;
      return Number(b.msg_num ?? b.id ?? 0) - Number(a.msg_num ?? a.id ?? 0);
    });

    const last = sorted[0];
    const rawText = last.message ?? last.comment ?? last.text;
    if (typeof rawText !== 'string' || !rawText.trim()) return null;

    const authorId = last.author_id;
    const authorName =
      authorId !== undefined && authorId !== null ? await this.resolveAssignedAgentName(authorId) : null;

    return { text: this.stripInvgateHtml(rawText), authorName };
  }

  /** Nombre completo del agente de InvGate asignado a un incidente, o `null` sin asignar/sin resolver. */
  private async resolveAssignedAgentName(assignedId: unknown): Promise<string | null> {
    if (assignedId === undefined || assignedId === null) return null;
    const agent = await this.invgateService.getUserById(Number(assignedId)).catch(() => null);
    if (!agent) return null;
    return [agent.name, agent.lastname].filter(Boolean).join(' ') || null;
  }

  /**
   * Nodo `transfer_agent`: transfiere la gestión a un humano.
   *
   * - `data.methods` (subconjunto de 'email' | 'ticket' | 'phone' — 'phone'
   *   reservado, sin implementar) define qué se ejecuta.
   * - `data.assignees` rota por round robin: a quién le tocó la última vez
   *   se guarda en `FlowNodeRoundRobin`, compartido entre TODAS las
   *   conversaciones que pasen por este nodo (no un contador por charla).
   * - `data.watchers`/`data.collaborators` se notifican (si el método
   *   'email' está tildado) pero nunca reciben la asignación del ticket.
   */
  private async executeTransferAgentNode(
    node: any,
    data: any,
    user: any,
    tenantId: string,
    body: string,
    flowState: Record<string, any>,
    flowId: string,
  ): Promise<NodeExecutionResult> {
    const methods: string[] = Array.isArray(data.methods) ? data.methods : [];
    const assigneeIds: string[] = Array.isArray(data.assignees) ? data.assignees : [];
    const watcherIds: string[] = Array.isArray(data.watchers) ? data.watchers : [];
    const collaboratorIds: string[] = Array.isArray(data.collaborators) ? data.collaborators : [];

    const assignee = assigneeIds.length
      ? await this.pickNextAssignee(flowId, node.id, assigneeIds, tenantId)
      : null;

    // `data.message` es texto configurado en el editor y puede traer `{{variable}}`
    // (ej. `{{descripcion}}`, `{{Urgencia}}`) igual que el texto de cualquier otro
    // nodo — pero a diferencia de esos, nunca pasaba por `executeFlow` como
    // `responseText` (es una nota interna, no le llega al usuario, ver comentario
    // más abajo), así que el interpolate() que corre ahí no lo tocaba y las
    // variables quedaban sin reemplazar en el mail y en el ticket.
    const note = data.message ? this.interpolate(data.message, flowState) : undefined;

    if (methods.includes('ticket') && assignee) {
      const ticket = await this.prisma.ticket.create({
        data: {
          userId: user.id,
          tenantId,
          assignedToId: assignee.id,
          subject: (flowState.subject || body).substring(0, 100),
          description: [note, flowState.description || body].filter(Boolean).join('\n\n'),
          priority: flowState.priority || 'medium',
        },
      });

      // Mismo criterio que en el nodo `ticket_create` — ver el comentario ahí.
      const pendingAttachments: StoredAttachment[] = Array.isArray(flowState.pendingAttachments)
        ? flowState.pendingAttachments
        : [];
      flowState.pendingAttachments = [];

      const invgateTicketId = await this.syncTicketToInvgate(
        ticket,
        user.phone,
        {
          categoryName: flowState.category,
          priorityName: flowState.priority,
          typeName: flowState.ticketType,
        },
        await this.loadAttachments(pendingAttachments),
      );
      // Mismo criterio que en 'ticket_create': preferí el número de InvGate, el cuid
      // interno no le sirve a nadie fuera del sistema — `ticket_query` acepta cualquiera
      // de los dos igual (busca por `id` O `invgateId`), así que esto no rompe nada viejo.
      flowState.lastTicketId = invgateTicketId ?? ticket.id;
    }

    if (methods.includes('email')) {
      const notifyIds = Array.from(
        new Set([assignee?.id, ...watcherIds, ...collaboratorIds].filter(Boolean)),
      ) as string[];
      // Filtrado por `tenantId`: `data.assignees`/`watchers`/`collaborators` son userIds fijados
      // en el editor. `sanitizeCrossTenantRefs` los sanea al guardar el flujo, pero contra el
      // conjunto de TODAS las empresas a las que el flujo está asignado — un flujo compartido
      // entre A y B puede legítimamente traer gente de ambas. Sin este filtro, la conversación
      // de un cliente de A podía terminar mandándole el email de transferencia (con su nombre,
      // teléfono y nota) a alguien que solo pertenece a B.
      const recipients = notifyIds.length
        ? await this.prisma.user.findMany({
            where: { id: { in: notifyIds }, tenants: { some: { tenantId, tenant: { deletedAt: null } } } },
          })
        : [];
      const userName =
        [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.phone || 'Un usuario';
      const assigneeName = assignee
        ? [assignee.firstName, assignee.lastName].filter(Boolean).join(' ') || assignee.email
        : null;

      for (const recipient of recipients) {
        await this.emailService.send({
          to: recipient.email,
          subject: `Transferencia de conversación — ${userName}`,
          text:
            `${userName} (${user?.phone || 'sin teléfono'}) fue transferido a soporte humano.\n\n` +
            (note ? `Nota: ${note}\n\n` : '') +
            `Último mensaje: "${body}"\n\n` +
            (assigneeName ? `Asignado a: ${assigneeName}\n` : 'Sin colaborador asignado.\n') +
            (flowState.lastTicketId ? `Ticket: #${flowState.lastTicketId}\n` : ''),
        });
      }
    }

    // `data.message` es una nota interna para el agente (va al mail y al ticket, arriba),
    // no un texto para el chat: si el flujo necesita avisarle algo al usuario acá, se
    // pone un nodo `message` antes de este. Sin responseText, sigue a la próxima arista.
    return { flowState };
  }

  /**
   * Nodo `sms`: manda un SMS por Twilio a una lista de destinatarios elegidos en el editor
   * de un `<select>` de usuarios (mismo criterio que `transfer_agent.watchers`/`collaborators`)
   * — `data.recipients` son userIds, no números escritos a mano, así que no hace falta validar
   * formato ni confiar en que alguien tipee bien un E.164. Se les manda al `user.phone` que
   * tengan cargado; sin teléfono, se los salta. Publica directo a `sms.outgoing`:
   * `TwilioSmsService` ya está suscripto ahí y hace la llamada real a la API de Twilio, así que
   * no hace falta inyectarlo acá.
   */
  private async executeSmsNode(
    data: any,
    flowState: Record<string, any>,
    tenantId: string,
  ): Promise<NodeExecutionResult> {
    const recipientIds: string[] = Array.isArray(data.recipients) ? data.recipients : [];
    const text = data.message ? this.interpolate(data.message, flowState) : '';

    if (text && recipientIds.length) {
      // Mismo filtro por `tenantId` que en `executeTransferAgentNode`: un `data.recipients`
      // configurado en el editor de un flujo compartido puede traer gente de otra empresa
      // asignada al mismo flujo — sin esto, la conversación de un cliente de esta empresa
      // podía terminar mandando un SMS con su nombre/nota a alguien de una empresa distinta.
      const recipients = await this.prisma.user.findMany({
        where: { id: { in: recipientIds }, tenants: { some: { tenantId, tenant: { deletedAt: null } } } },
      });
      for (const recipient of recipients) {
        if (!recipient.phone) continue;
        await this.broker.publish('sms.outgoing', {
          pattern: 'message.send',
          data: { to: recipient.phone, body: text },
          tenantId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return { flowState };
  }

  /**
   * Elige el próximo de `assigneeIds` en orden, rotando sobre el índice persistido en
   * FlowNodeRoundRobin. Filtra por `tenantId`, no solo por `deletedAt`: `data.assignees` es
   * config del nodo, y un flujo compartido entre varias empresas puede legítimamente traer
   * gente de todas ellas (`sanitizeCrossTenantRefs` sanea contra ESE conjunto al guardar, no
   * contra la empresa puntual de cada conversación) — sin este filtro, el ticket/transferencia
   * de un cliente de esta empresa podía terminar asignado a alguien de otra.
   */
  private async pickNextAssignee(flowId: string, nodeId: string, assigneeIds: string[], tenantId: string) {
    // `data.assignees` no se actualiza solo cuando alguien se da de baja (de la persona, o de
    // esta empresa puntual), así que filtramos acá: sale de la rotación en vez de seguir
    // recibiendo tickets/transferencias. Orden estable según `assigneeIds`, no el que
    // devuelva la DB.
    const active = await this.prisma.user.findMany({
      where: {
        id: { in: assigneeIds },
        deletedAt: null,
        tenants: { some: { tenantId, tenant: { deletedAt: null } } },
      },
    });
    if (!active.length) return null;
    const activeIds = assigneeIds.filter((id) => active.some((u) => u.id === id));

    let state: { lastIndex: number };
    try {
      state = await this.prisma.flowNodeRoundRobin.upsert({
        where: { flowId_nodeId: { flowId, nodeId } },
        update: {},
        create: { flowId, nodeId, lastIndex: -1 },
      });
    } catch (err) {
      // Dos conversaciones distintas pueden tocar el mismo nodo round-robin por primera vez
      // casi al mismo tiempo — el `create` del upsert de la que "pierde la carrera" choca
      // contra el `@@unique([flowId, nodeId])` (mismo patrón que `persistContentSid` en
      // `TwilioWhatsAppService`). No es un error real: solo hace falta leer la fila que ya
      // quedó creada por la otra.
      if ((err as { code?: string }).code !== 'P2002') throw err;
      state = await this.prisma.flowNodeRoundRobin.findUniqueOrThrow({
        where: { flowId_nodeId: { flowId, nodeId } },
      });
    }

    const nextIndex = (state.lastIndex + 1) % activeIds.length;
    await this.prisma.flowNodeRoundRobin.update({
      where: { flowId_nodeId: { flowId, nodeId } },
      data: { lastIndex: nextIndex },
    });

    const nextUserId = activeIds[nextIndex];
    return active.find((u) => u.id === nextUserId) ?? null;
  }

  private async executeNode(
    node: any,
    body: string,
    conversation: any,
    user: any,
    tenantId: string,
    from: string,
    edges: any[],
    flowState: Record<string, any>,
    identity: { isKnown: boolean; roleId: string | null; roleName: string | null },
    flowId: string,
    contextSourceId: string | null,
    skillPromptText: string | null,
  ): Promise<NodeExecutionResult> {
    const type = node.type;
    const data = node.data || {};

    switch (type) {
      case 'start': {
        // `user` e `identity` ya vienen resueltos desde `handleMessage`, contra el
        // registro de usuarios (UserTenant + Role) — no se vuelve a consultar acá.
        // Repetir la consulta en este punto era exactamente el bug: para entonces
        // el usuario ya existía (lo creaba `handleMessage` un paso antes), así que
        // el número nunca se detectaba como desconocido.
        const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(' ');
        flowState.isKnownUser = identity.isKnown;
        flowState.userName = fullName || null;
        flowState.userFirstName = user?.firstName || null;
        flowState.userLastName = user?.lastName || null;
        flowState.userEmail = user?.email || null;
        flowState.userPhone = from;
        flowState.userId = user?.id || null;
        flowState.userRole = identity.roleName;
        flowState.userRoleId = identity.roleId;

        // Saludo configurable desde el editor (`data.text`), con `{{variable}}` de la charla —
        // incluidas las de `flowState` que se acaban de setear arriba (`{{userFirstName}}`,
        // `{{userName}}`, `{{userRole}}`, etc.). Sin configurar se mantiene el texto de siempre,
        // así ningún flujo existente cambia de comportamiento al actualizar.
        //
        // El mismo texto sirve para las dos ramas a propósito: hasta 2026-08-27 `data.text` era
        // SOLO el saludo del usuario desconocido, pero desde "no hablamos con desconocidos" un
        // número no registrado se rechaza antes de llegar al flujo, así que esa rama no se
        // ejecuta más y el campo quedaba sin ningún efecto visible.
        // `noGreeting` (tilde "No enviar saludo" en el editor) es lo único que arranca la charla
        // sin ningún mensaje de este nodo: el flujo sigue de largo por su arista, y el primer
        // texto que ve la persona es el del nodo siguiente. Un `data.text` vacío NO alcanza para
        // eso a propósito — ningún flujo tenía ese campo cargado cuando se volvió configurable
        // (2026-09-01), así que tomar "vacío" como "sin saludo" los habría dejado a todos mudos
        // de golpe al actualizar.
        const configuredGreeting = data.text?.trim() ? this.interpolate(data.text, flowState) : null;
        const greeting = data.noGreeting
          ? undefined
          : (configuredGreeting ??
            (identity.isKnown
              ? `¡Hola ${user?.firstName || ''}! Bienvenido de nuevo.`
              : '¡Hola! Bienvenido. ¿En qué puedo ayudarte?'));

        // Dos salidas: conocido / desconocido. El editor visual las dibuja como
        // aristas desde los handles `known` / `unknown`, así que se enruta por ahí;
        // `data.*TargetNodeId` queda como fallback para flujos viejos.
        return {
          responseText: greeting,
          nextNodeId:
            (identity.isKnown ? data.knownTargetNodeId : data.unknownTargetNodeId) || undefined,
          sourceHandle: identity.isKnown ? 'known' : 'unknown',
          flowState,
        };
      }

      case 'message': {
        // Avanzar automáticamente al siguiente nodo
        return { responseText: data.text };
      }

      case 'end': {
        return {
          responseText: data.text || undefined,
          endConversation: true,
        };
      }

      case 'device_validation':
        return this.executeDeviceValidationNode(node, body, user, from, flowState, data.text);

      case 'menu': {
        const options = data.options || [];

        // Pila de navegación entre menús (pedido 2026-08-12): cada vez que se
        // elige una opción real (no "Volver") se apila el menú que se abandona,
        // así el próximo menú puede ofrecer "Volver" a él. Vacía = no hay menú
        // anterior (el menú raíz nunca la muestra). Es runtime, no del grafo del
        // flujo: refleja por dónde pasó ESTA conversación, no la estructura
        // estática — funciona igual si un submenú se llega desde varios lados.
        const menuStack: MenuStackEntry[] = flowState.__menuStack || [];
        const displayOptions =
          menuStack.length > 0 ? [...options, { value: BACK_OPTION_VALUE, label: 'Volver' }] : options;

        // Ya se derivó a conversación libre con el LLM (el mensaje anterior no
        // encajaba en ninguna opción ni era una cancelación): sigue atendiendo
        // con el historial completo, sin volver a evaluar contra las opciones.
        // Si el flujo tiene una fuente de verdad vinculada, `orchestratorLlm` la
        // consulta antes de responder — ver ese método.
        if (flowState.__llmFallback === node.id) {
          const matchesOption = displayOptions.some(
            (opt: any, idx: number) =>
              body.trim() === opt.value || body.trim() === opt.label || body.trim() === String(idx + 1),
          );
          if (matchesOption) {
            // El usuario volvió a tipear/tocar una opción válida del menú: sale del modo
            // LLM libre y deja que el matching de más abajo procese la selección como
            // de costumbre. Sin esto, __llmFallback nunca se limpiaba y la conversación
            // quedaba pegada acá para siempre, aunque el usuario acertara la opción.
            delete flowState.__llmFallback;
            flowState.__awaiting = node.id;
          } else {
            const responseText = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId, skillPromptText);
            return { responseText, waitForInput: true, flowState };
          }
        }

        // Primera llegada al menú: mostrar opciones y esperar. Sin esto, al
        // encadenar nodos el menú consumiría el mensaje que lo activó.
        if (flowState.__awaiting !== node.id) {
          flowState.__awaiting = node.id;
          const interactive = this.buildMenuInteractive(data.text, displayOptions);
          // Si hay interactivo, `responseText` tiene que ser SOLO el header (sin
          // la lista numerada): las opciones ya se ven en los botones/lista, y
          // ese mismo texto es el que `executeFlow` termina mandando como body
          // del mensaje interactivo real — listarlas dos veces sería redundante.
          const responseText = interactive
            ? (data.text ?? '').trim() || 'Elegí una opción:'
            : (
                (data.text ?? '') +
                '\n' +
                displayOptions.map((opt: any, idx: number) => `${idx + 1}. ${opt.label}`).join('\n')
              ).trim();
          return { responseText, interactive, waitForInput: true, flowState };
        }

        const selected = displayOptions.find(
          (opt: any) =>
            body.trim() === opt.value ||
            body.trim() === opt.label ||
            body.trim() === String(displayOptions.indexOf(opt) + 1),
        );

        if (selected) {
          delete flowState.__awaiting;
          if (selected.value === BACK_OPTION_VALUE) {
            return this.navigateMenuBack(flowState, menuStack, flowId);
          }
          flowState.__menuStack = [...menuStack, { nodeId: node.id, flowId }];
          // Arista con sourceHandle = valor de la opción elegida
          const edge = edges.find(
            (e: any) => e.source === node.id && e.sourceHandle === String(selected.value),
          );
          return { nextNodeId: edge?.target || selected.targetNodeId, flowState };
        }

        // No hubo match literal: el usuario puede haber contestado en lenguaje
        // natural ("se me rompió la impresora" en vez de tocar "2"), o puede
        // querer cancelar la gestión ("dejalo", "mejor no"). Se interpreta con
        // el LLM antes de asumir que es una opción inválida — solo se gasta esta
        // llamada acá, nunca en el camino feliz de un match literal.
        const interpretation = await this.interpretMenuChoice(body, displayOptions);

        if (interpretation.cancel) {
          return this.cancelInteraction(flowState);
        }

        const matched = interpretation.optionValue
          ? displayOptions.find((opt: any) => String(opt.value) === interpretation.optionValue)
          : undefined;

        if (matched) {
          delete flowState.__awaiting;
          if (matched.value === BACK_OPTION_VALUE) {
            return this.navigateMenuBack(flowState, menuStack, flowId);
          }
          flowState.__menuStack = [...menuStack, { nodeId: node.id, flowId }];
          const edge = edges.find(
            (e: any) => e.source === node.id && e.sourceHandle === String(matched.value),
          );
          return { nextNodeId: edge?.target || matched.targetNodeId, flowState };
        }

        // Ni opción ni cancelación: en vez de insistir con el menú, el LLM toma
        // la conversación para entender el problema del usuario y recopilar
        // datos. Queda en este modo para los próximos mensajes (ver el chequeo
        // de `__llmFallback` al principio del case).
        delete flowState.__awaiting;
        flowState.__llmFallback = node.id;
        const fallbackResponse = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId, skillPromptText);
        return { responseText: fallbackResponse, waitForInput: true, flowState };
      }

      case 'input': {
        // Primera llegada: preguntar y esperar. En la segunda, el body ya es la
        // respuesta del usuario y recién ahí se guarda y se avanza.
        if (flowState.__awaiting !== node.id) {
          flowState.__awaiting = node.id;
          return {
            responseText: data.text || 'Por favor, ingresá el dato solicitado.',
            waitForInput: true,
            flowState,
          };
        }

        // Antes de guardar el texto como el dato pedido, se descarta que en
        // realidad sea un intento de cancelar ("dejalo", "mejor no", "cancelá
        // esto"). El filtro por palabras clave es a propósito barato y solo
        // dispara la llamada al LLM (que sí entiende matices) cuando hay una
        // sospecha real — así una respuesta normal (email, nombre, etc.) no
        // paga ese costo.
        if (this.looksLikeCancelAttempt(body)) {
          const wantsToCancel = await this.confirmCancelIntent(body, data.text);
          if (wantsToCancel) {
            return this.cancelInteraction(flowState);
          }
        }

        if (data.variableName) {
          flowState[this.stripVariableBraces(data.variableName)] = body;
        }
        delete flowState.__awaiting;
        return { flowState };
      }

      case 'notification': {
        // Texto + un único botón (ej. "Agregue sus fotos" / "Sin foto"). Dos modos:
        //  - 'link' (data.buttonMode === 'link'): el botón abre una URL.
        //  - 'confirm' (default): al tocarlo, sigue el flujo por la única arista de
        //    salida del nodo. Cualquier otro mensaje —el usuario agrega algo (manda
        //    las fotos) o pregunta algo— lo toma el LLM, mismo mecanismo de fallback
        //    que `menu`, pero sin ramificar por opción: acá no hay nada que elegir,
        //    solo confirmar o desviarse.
        const buttonLabel = (data.buttonLabel || 'Continuar').trim();

        if (data.buttonMode === 'link') {
          if (!data.buttonUrl) {
            // Sin URL configurada no hay botón que mandar: se degrada a mensaje de
            // texto plano en vez de mandar un botón roto.
            return { responseText: data.text };
          }
          // WhatsApp no avisa cuando se toca un botón de link, así que no hay nada que
          // matchear — pero SÍ hay que frenar acá con `waitForInput` (como cualquier nodo
          // con `interactive`): sin esto, `executeFlow` sigue encadenando al próximo nodo
          // en el mismo turno y ese nodo pisa este `interactive` (solo se manda el último
          // de la cadena) — el botón nunca llegaba a salir. El próximo mensaje que mande
          // el usuario, sea cual sea, avanza por la única salida del nodo.
          if (flowState.__awaiting === node.id) {
            delete flowState.__awaiting;
            return { flowState };
          }
          flowState.__awaiting = node.id;
          const interactive = this.buildCtaInteractive(data.text, buttonLabel, data.buttonUrl);
          return { responseText: (data.text ?? '').trim(), interactive, waitForInput: true, flowState };
        }

        const pressedButton = () => body.trim() === buttonLabel || body.trim() === '1';
        // "Espera foto" (data.expectsPhoto, tildable en el editor): si está prendido,
        // mandar una imagen también avanza el flujo, igual que tocar el botón — no tiene
        // sentido derivar al LLM a alguien que ya hizo lo que el nodo le pidió (ej.
        // "Agregue sus fotos"). Sin el tilde, el nodo no espera nada en particular más
        // que el botón, y una imagen cae al LLM como cualquier otro mensaje que no matchea.
        // `pendingAttachments` ya lo actualizó `handleMessage` (paso 2.5) antes de llegar
        // acá, con los adjuntos de este mismo mensaje.
        const sentImage = () =>
          !!data.expectsPhoto &&
          Array.isArray(flowState.pendingAttachments) &&
          flowState.pendingAttachments.length > 0;

        // Ya se derivó a conversación libre (el mensaje anterior no era el botón ni
        // encajaba): sigue atendiendo con el LLM hasta que el usuario toque el botón o
        // mande una imagen.
        if (flowState.__llmFallback === node.id) {
          if (pressedButton() || sentImage()) {
            delete flowState.__llmFallback;
            return { flowState };
          }
          const responseText = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId, skillPromptText);
          return { responseText, waitForInput: true, flowState };
        }

        // Primera llegada: mostrar el texto con el botón y esperar.
        if (flowState.__awaiting !== node.id) {
          flowState.__awaiting = node.id;
          const interactive = this.buildMenuInteractive(data.text, [
            { value: buttonLabel, label: buttonLabel },
          ]);
          const responseText = interactive
            ? (data.text ?? '').trim()
            : `${(data.text ?? '').trim()}\n\n[${buttonLabel}]`;
          return { responseText, interactive, waitForInput: true, flowState };
        }

        delete flowState.__awaiting;
        if (pressedButton() || sentImage()) {
          return { flowState };
        }

        // No tocó el botón ni mandó una imagen: puede estar preguntando algo. Se lo
        // pasa al LLM en vez de insistir con el botón.
        flowState.__llmFallback = node.id;
        const fallbackResponse = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId, skillPromptText);
        return { responseText: fallbackResponse, waitForInput: true, flowState };
      }

      case 'condition': {
        // Formato nuevo: una única comparación contra una variable de flowState
        // (incluida cualquiera de las que siempre trae `start`, como `userRole`),
        // con 2 salidas fijas por sourceHandle ('true'/'false'). Reemplaza a la
        // lista vieja de `conditions`, que sigue funcionando para flujos viejos
        // que no tengan `compareVariable` seteado.
        if (data.compareVariable) {
          const rawValue = flowState[this.stripVariableBraces(data.compareVariable)];
          const compareValue = data.compareValue ?? '';
          let matches: boolean;
          switch (data.compareOperator) {
            case 'not_equals':
              matches = String(rawValue ?? '') !== compareValue;
              break;
            case 'contains':
              matches = String(rawValue ?? '')
                .toLowerCase()
                .includes(compareValue.toLowerCase());
              break;
            case 'exists':
              matches = rawValue !== undefined && rawValue !== null && rawValue !== '';
              break;
            case 'not_exists':
              matches = rawValue === undefined || rawValue === null || rawValue === '';
              break;
            case 'equals':
            default:
              matches = String(rawValue ?? '') === compareValue;
              break;
          }
          return { sourceHandle: matches ? 'true' : 'false' };
        }

        const conditions = data.conditions || [];
        let matched = false;
        let targetNodeId: string | null = null;

        for (const cond of conditions) {
          if (cond.type === 'keyword' && body.toLowerCase().includes(cond.value.toLowerCase())) {
            matched = true;
            targetNodeId = cond.targetNodeId;
            break;
          }
          if (cond.type === 'regex') {
            const regex = new RegExp(cond.value, 'i');
            if (regex.test(body)) {
              matched = true;
              targetNodeId = cond.targetNodeId;
              break;
            }
          }
          if (cond.type === 'variable' && flowState[cond.value]) {
            matched = true;
            targetNodeId = cond.targetNodeId;
            break;
          }
        }

        if (!matched && data.defaultTargetNodeId) {
          targetNodeId = data.defaultTargetNodeId;
        }

        return targetNodeId ? { nextNodeId: targetNodeId } : {};
      }

      case 'ticket_create': {
        // Los 5 campos del nodo admiten `{{variable}}` (igual que `data.message` en
        // transfer_agent) además del valor fijo elegido en el editor — así category/
        // priority/ticketType pueden venir de CUALQUIER variable que la charla haya
        // recolectado, no solo de las claves fijas `flowState.category`/`.priority`/
        // `.ticketType` a las que ya caían como fallback. `interpolate` deja el
        // placeholder tal cual si la variable no existe en flowState.
        const subject = data.subject ? this.interpolate(data.subject, flowState) : undefined;
        const description = data.description ? this.interpolate(data.description, flowState) : undefined;
        const category = data.category ? this.interpolate(data.category, flowState) : undefined;
        const priority = data.priority ? this.interpolate(data.priority, flowState) : undefined;
        const ticketType = data.ticketType ? this.interpolate(data.ticketType, flowState) : undefined;

        const ticket = await this.prisma.ticket.create({
          data: {
            userId: user.id,
            tenantId,
            subject: subject || flowState.subject || body.substring(0, 100),
            description: description || flowState.description || body,
            priority: priority || 'medium',
          },
        });

        // Imágenes que el usuario mandó en cualquier punto de esta charla (ver 2.5 en
        // handleMessage) — se consumen acá, tanto si el ticket termina sincronizando en
        // InvGate como si no: no quedan reservadas para un ticket futuro.
        const pendingAttachments: StoredAttachment[] = Array.isArray(flowState.pendingAttachments)
          ? flowState.pendingAttachments
          : [];
        flowState.pendingAttachments = [];

        const invgateTicketId = await this.syncTicketToInvgate(
          ticket,
          from,
          {
            categoryName: category || flowState.category,
            priorityName: priority || flowState.priority,
            typeName: ticketType || flowState.ticketType,
          },
          await this.loadAttachments(pendingAttachments),
        );
        // `lastTicketId` (lo que consulta `ticket_query` después) y lo que puede mostrar
        // `data.text` acá: preferí SIEMPRE el número de InvGate — el cuid interno no le
        // sirve a nadie fuera del sistema. Sin sync (InvGate caído, mal configurado,
        // etc.) cae al id local — sigue siendo un ticket válido, solo que no llegó a
        // InvGate todavía.
        flowState.lastTicketId = invgateTicketId ?? ticket.id;
        // Mensaje final 100% a cargo de quien arma el flujo: sin `data.text` configurado
        // no hay ningún texto fijo — antes SIEMPRE se mandaba "Ticket #X creado..." sin
        // forma de sacarlo ni de personalizarlo. `{{lastTicketId}}` (recién seteado
        // arriba) y cualquier otra variable de la charla quedan disponibles para armarlo.
        return {
          responseText: data.text ? this.interpolate(data.text, flowState) : undefined,
          flowState,
        };
      }

      case 'ticket_query': {
        // Tres pasos, mismo idioma que `menu`/`input` (`flowState.__awaiting` +
        // `waitForInput`): (1) primera llegada, lista EN VIVO los tickets abiertos
        // del usuario contra InvGate (no la tabla local `Ticket` — su estado
        // cacheado puede estar desactualizado, ver `buildOpenTicketsList`); (2) elige
        // uno, se muestra el detalle con un botón "Volver a la lista"; (3) si toca
        // ese botón vuelve a (1), cualquier otra respuesta sigue de largo por la
        // arista del nodo (igual que `input`).
        const awaitingThisNode = flowState.__awaiting === node.id;
        const step = flowState.__ticketQueryStep;

        const resolveCustomerId = async (): Promise<number | null> => {
          if (!(await this.invgateService.isConfigured())) return null;
          return this.resolveInvgateCustomerId(user.id, from);
        };

        const clearTicketQueryState = () => {
          delete flowState.__awaiting;
          delete flowState.__ticketQueryStep;
          delete flowState.__ticketQueryListCache;
          delete flowState.__ticketQueryListTruncated;
        };

        /**
         * "Volver a la lista" reusa la MISMA lista ya armada (`flowState.__ticketQueryListCache`)
         * en vez de reconsultar InvGate — no solo por ahorrar la consulta: Twilio manda listas
         * vía un Content Template cacheado por FORMA exacta del menú, incluyendo el id de cada
         * fila (`TwilioWhatsAppService.hashInteractiveShape`). Si se reconstruye la lista de
         * nuevo, aunque el resultado sea idéntico, cualquier corrimiento en el orden/estado de
         * los tickets de InvGate arma un hash distinto y fuerza crear un Content Template
         * nuevo (lento, y ese es justo el que a veces no llega a renderizar el botón/lista del
         * lado de WhatsApp). Reenviando el mismo objeto en memoria, es 100% el mismo Content
         * Template ya usado en el mensaje anterior — el mismo que si funciona (ver el botón
         * "Volver a la lista", con forma fija, siempre cacheado). Se descarta con
         * `clearTicketQueryState` apenas se sale del nodo, así una visita futura sí trae los
         * tickets al día.
         */
        const renderTicketList = async (prefix?: string): Promise<NodeExecutionResult> => {
          let interactive = flowState.__ticketQueryListCache as WhatsAppInteractive | undefined;
          let truncated = !!flowState.__ticketQueryListTruncated;

          if (!interactive) {
            const customerId = await resolveCustomerId();
            if (!customerId) {
              clearTicketQueryState();
              return {
                responseText: 'No pude vincular tu usuario con InvGate para buscar tus tickets. Contactá a un administrador.',
                flowState,
              };
            }

            const built = await this.buildOpenTicketsList(customerId);
            if (!built.interactive) {
              clearTicketQueryState();
              return { responseText: 'No tenés tickets abiertos en este momento.', flowState };
            }
            interactive = built.interactive;
            truncated = built.truncated;
            flowState.__ticketQueryListCache = interactive;
            flowState.__ticketQueryListTruncated = truncated;
          }

          flowState.__awaiting = node.id;
          flowState.__ticketQueryStep = 'select';
          const notice = truncated
            ? `Tenés más de ${MAX_TICKET_LIST_ROWS} tickets abiertos, te muestro los ${MAX_TICKET_LIST_ROWS} más recientes.\n\n`
            : '';
          return {
            responseText: (prefix ?? '') + notice + 'Elegí un ticket:',
            interactive,
            waitForInput: true,
            flowState,
          };
        };

        if (awaitingThisNode && step === 'detail') {
          if (body.trim() === BACK_OPTION_VALUE) {
            return renderTicketList();
          }
          clearTicketQueryState();
          return { flowState };
        }

        if (awaitingThisNode) {
          // Paso "elegir ticket": `body` es el id de InvGate de la fila tocada, o
          // tipeado a mano — por eso `buildTicketDetailText` verifica que el
          // incidente encontrado le pertenezca a ESTE `customerId` antes de
          // mostrarlo (si no, cualquiera podría ver el ticket de otra persona
          // adivinando un id bajo).
          const customerId = await resolveCustomerId();
          if (!customerId) return renderTicketList();

          const selectedRef = body.trim();
          const detailText = await this.buildTicketDetailText(selectedRef, customerId);
          if (!detailText) {
            return renderTicketList('No reconocí esa opción. ');
          }

          flowState.__ticketQueryStep = 'detail';
          return {
            responseText: detailText,
            interactive: {
              type: 'button',
              body: detailText,
              buttons: [{ id: BACK_OPTION_VALUE, title: 'Volver a la lista' }],
            },
            waitForInput: true,
            flowState,
          };
        }

        // Primera llegada.
        return renderTicketList();
      }

      case 'transfer_agent':
        return this.executeTransferAgentNode(node, data, user, tenantId, body, flowState, flowId);

      case 'sms':
        return this.executeSmsNode(data, flowState, tenantId);

      case 'llm_query': {
        // `sessionStartedAt` acota el historial a la sesión actual — mismo criterio
        // que `orchestratorLlm` (ver ese comentario): si la charla se cerró y se
        // reanudó (mismo Conversation.id), los mensajes de antes del cierre no son
        // contexto de "la charla actual" y no deben mezclarse acá. Además, `desc` +
        // `take` agarra los ÚLTIMOS N mensajes de esa sesión (no los primeros N) —
        // con `asc` una sesión de más de `contextMessages` mensajes deja al modelo
        // mirando el arranque de la charla en vez de lo último dicho. Se revierte
        // después para mandarlos en orden cronológico, como los espera la API del LLM.
        const sessionStart = conversation.sessionStartedAt ?? conversation.createdAt;
        const recentMessages = (
          await this.prisma.message.findMany({
            where: { conversationId: conversation.id, createdAt: { gte: sessionStart } },
            orderBy: { createdAt: 'desc' },
            take: data.contextMessages || 10,
          })
        ).reverse();

        const llmMessages: LlmMessage[] = recentMessages.map((m) => ({
          role: m.senderType === 'user' ? 'user' : 'assistant',
          content: m.content,
        }));

        // Fuente de verdad vinculada al flujo: igual que en `orchestratorLlm`, se
        // consulta siempre que esté presente, antes de generar la respuesta —
        // este nodo antes la ignoraba por completo aunque `executeNode` ya la
        // recibía como parámetro.
        if (contextSourceId) {
          const knowledge = await this.contextSourcesService.queryKnowledge(tenantId, contextSourceId, body);
          if (knowledge.ok && knowledge.answer) {
            llmMessages.push({
              role: 'system',
              content:
                `Contexto de la fuente de verdad vinculada a este flujo (información autoritativa, ` +
                `priorizala si contradice lo que ya sabés):\n${knowledge.answer}`,
            });
          } else {
            this.logger.warn(`Fuente de verdad ${contextSourceId} sin respuesta útil: ${knowledge.message}`);
          }
        }

        // Prompt base = LLM_SYSTEM_PROMPT de /settings + Skill del flujo. El
        // systemPrompt propio del nodo (si lo trae) lo REEMPLAZA por default —
        // mismo comportamiento que antes de sumar Skills — o se le AGREGA a
        // continuación si el nodo eligió 'append' (ver systemPromptMode).
        const basePrompt = await this.buildBasePrompt(skillPromptText);
        const systemPrompt =
          data.systemPrompt && data.systemPromptMode === 'append'
            ? [basePrompt, data.systemPrompt].filter(Boolean).join('\n\n')
            : data.systemPrompt || basePrompt;

        // Modo extracción: en vez de mandarle al usuario lo que diga el modelo, lo usamos
        // para resolver una o más variables (ej. "sede") y ramificar — así el nodo puede
        // saltear los pasos que las piden cuando ya están en la charla. Si falta alguna,
        // el nodo mismo se detiene a preguntarla (ver executeLlmQueryExtraction) en vez de
        // ramificar directo a "no encontrado": solo cae a "no definido" si el usuario se
        // niega a darla o se agotan los intentos.
        //
        // Igual que `condition`, las ramas van por `data.foundTargetNodeId`/
        // `missingTargetNodeId` (no por `sourceHandle` de un edge): este nodo usa
        // `BaseNode` en el editor, que solo tiene un handle de salida genérico sin id,
        // así que no hay forma de dibujar dos salidas nombradas en el canvas.
        if (data.extractVariables?.length) {
          return this.executeLlmQueryExtraction(
            node,
            data,
            data.extractVariables,
            llmMessages,
            systemPrompt,
            flowState,
            data.temperature,
          );
        }

        // `temperature` solo se manda si el nodo lo define — un `temperature: undefined`
        // explícito pisaría el default de LlmService (LLM_TEMPERATURE de /settings) con
        // `undefined` en el merge (`{...defaults, ...tenantConfig}`), perdiendo la cascada
        // BD → env → default y cayendo al 0.7 hardcodeado de cada provider.
        const responseText = await this.llmService.chat(llmMessages, {
          systemPrompt,
          ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
        });

        return { responseText };
      }

      case 'delay': {
        // Acotado: ahora los nodos se encadenan dentro de una sola request HTTP,
        // así que un delay largo la dejaría colgada.
        const seconds = Math.min(data.seconds || 1, MAX_DELAY_SECONDS);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return {};
      }

      case 'variable': {
        if (data.action === 'set' && data.name) {
          flowState[this.stripVariableBraces(data.name)] = data.value ?? body;
        }
        return { flowState };
      }

      case 'webhook': {
        // Fire-and-forget: no devuelve responseText, así que no interrumpe la
        // conversación con el usuario. Si falla, se loguea y el flujo sigue
        // (un webhook caído -p.ej. una alerta a Discord- no debe trabar el bot).
        const url = data.url ? this.interpolate(data.url, flowState) : '';
        if (!url) {
          this.logger.warn(`Nodo webhook (${node.id}) sin URL configurada.`);
          return {};
        }
        const method = (data.method || 'POST').toUpperCase();
        const requestBody = method !== 'GET' && data.body ? this.interpolate(data.body, flowState) : undefined;
        try {
          const res = await fetch(url, {
            method,
            headers: requestBody ? { 'Content-Type': 'application/json' } : undefined,
            body: requestBody,
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          if (!res.ok) {
            this.logger.warn(`Webhook (${node.id}) respondió ${res.status}: ${(await res.text().catch(() => '')).substring(0, 200)}`);
          }
        } catch (err) {
          this.logger.error(`No se pudo llamar al webhook (${node.id}, ${url}): ${(err as Error).message}`);
        }
        return {};
      }

      case 'subflow': {
        const subFlowId = data.flowId;
        const entryNodeId = data.entryNodeId;
        if (!subFlowId) {
          return { responseText: 'Error: sub-flujo no configurado.' };
        }
        const subFlow = await this.flowService.findById(subFlowId);
        if (!subFlow) {
          return { responseText: 'Error: sub-flujo no encontrado.' };
        }
        // Cambiar a sub-flujo
        const nextNodeId = entryNodeId || this.findStartNodeId(subFlow.nodes as any[]);
        return {
          responseText: data.text || `Entrando a sub-flujo: ${subFlow.name}`,
          nextNodeId: undefined, // Se maneja el cambio de flujo fuera
          flowState: {
            ...flowState,
            __subflow: { flowId: subFlowId, entryNodeId: nextNodeId, previousFlowId: conversation.currentFlowId },
          },
        };
      }

      default:
        return { responseText: data.text || 'Nodo no implementado.' };
    }
  }

  /**
   * Nodo `llm_query` en modo extracción (`data.extractVariables`). A diferencia del modo
   * conversacional plano, este nodo puede detener el flujo para preguntarle al usuario los
   * datos que falten (ej. "sede") en vez de ramificar directo a "no encontrado" — solo cae a
   * `LLM_QUERY_UNDEFINED_VALUE` si el usuario se niega a darlo o se agota `data.maxAttempts`.
   *
   * Reusa `flowState.__awaiting` (mismo mecanismo que el nodo `input`) para saber si esta
   * ejecución es la primera pasada (evalúa la charla tal cual llegó) o una respuesta a la
   * pregunta que el nodo mismo hizo. Las variables ya resueltas (con valor real o con
   * `LLM_QUERY_UNDEFINED_VALUE`) quedan en `flowState` entre turnos, así que una vuelta
   * parcial (algunas encontradas, otras no) no las vuelve a preguntar.
   */
  private async executeLlmQueryExtraction(
    node: any,
    data: any,
    variables: Array<{ variable: string; label?: string; allowedValues?: string[] }>,
    llmMessages: LlmMessage[],
    systemPrompt: string,
    flowState: Record<string, any>,
    temperature?: number,
  ): Promise<NodeExecutionResult> {
    const maxAttempts =
      typeof data.maxAttempts === 'number' && data.maxAttempts > 0
        ? data.maxAttempts
        : DEFAULT_LLM_QUERY_MAX_ATTEMPTS;
    // Cuántas veces ya se le preguntó al usuario por los datos que faltan, ANTES de esta
    // pasada — 0 en la primera ejecución (todavía no se preguntó nada).
    const attemptsSoFar = flowState.__awaiting === node.id ? flowState.__llmQueryAttempts || 0 : 0;

    const pending = variables.filter((v) => {
      const value = flowState[this.stripVariableBraces(v.variable)];
      return value === undefined || value === null || value === '';
    });

    if (pending.length) {
      const outcomes = await this.extractLlmQueryValues(llmMessages, systemPrompt, pending);
      const stillMissing: typeof pending = [];

      for (const v of pending) {
        const key = this.stripVariableBraces(v.variable);
        const outcome = outcomes[key];
        if (outcome && outcome !== 'NONE' && outcome !== 'REFUSED') {
          flowState[key] = outcome;
        } else if (outcome === 'REFUSED' || attemptsSoFar >= maxAttempts) {
          flowState[key] = LLM_QUERY_UNDEFINED_VALUE;
        } else {
          stillMissing.push(v);
        }
      }

      if (stillMissing.length) {
        flowState.__awaiting = node.id;
        flowState.__llmQueryAttempts = attemptsSoFar + 1;
        const question = await this.generateLlmQueryQuestion(systemPrompt, llmMessages, stillMissing, temperature);
        return { responseText: question, waitForInput: true, flowState };
      }
    }

    delete flowState.__awaiting;
    delete flowState.__llmQueryAttempts;
    // Una sola salida, siempre por la arista dibujada en el canvas (pedido 2026-08-28):
    // tanto "todas resueltas" como "alguna quedó en no definido" siguen el mismo camino —
    // quien necesite ramificar por "no definido" pone un nodo `condition` después. Los
    // campos foundTargetNodeId/missingTargetNodeId se IGNORAN a propósito (eran texto
    // libre en el editor: un ID tipeado a mano con un typo mandaba el flujo a un nodo
    // inexistente y el motor lo reseteaba en silencio — así se rompió el flujo de test
    // que motivó todo esto). Siguen en el DTO solo para que los flujos viejos que los
    // tengan guardados pasen la validación al re-guardarse.
    return { flowState };
  }

  /**
   * Un llamado al LLM por turno para TODAS las variables pendientes de `llm_query` (en vez
   * de uno por variable): le pasa la charla reciente y le pide una línea `variable: valor`
   * por cada una, con NONE si todavía no se mencionó o REFUSED si el usuario se negó
   * explícitamente a darla (así el nodo puede caer a "no definido" sin esperar a agotar
   * `maxAttempts`). Ante una línea faltante o sin parsear, se trata como NONE — el peor caso
   * es una pregunta de más, no un valor inventado.
   *
   * Siempre corre en `temperature: 0`, sin importar el `temperature` configurado en el nodo
   * (igual que `confirmEndChatIntent` e `interpretMenuChoice`): es una clasificación
   * (¿el usuario ya dijo esto o no?), no una redacción — dejarla "creativa" es lo que hacía
   * que el nodo confundiera "no lo dijo" con inventar contexto extra.
   */
  private async extractLlmQueryValues(
    llmMessages: LlmMessage[],
    systemPrompt: string,
    pending: Array<{ variable: string; label?: string; allowedValues?: string[] }>,
  ): Promise<Record<string, string>> {
    const items = pending.map((v) => {
      const key = this.stripVariableBraces(v.variable);
      const label = v.label || key;
      const allowed = v.allowedValues?.length
        ? ` Valores válidos (respondé EXACTAMENTE uno, calcado): ${v.allowedValues.join(', ')}.`
        : '';
      return { key, line: `- ${key} (${label}).${allowed}` };
    });

    const extractPrompt =
      `${systemPrompt}\n\nTu única tarea ahora: para cada uno de estos datos, determinar si en ` +
      `la conversación el usuario ya lo indicó:\n${items.map((i) => i.line).join('\n')}\n\n` +
      'Respondé UNA línea por dato, en este formato exacto ("clave: valor"):\n' +
      items.map((i) => `${i.key}: <valor, o NONE si no lo dijo, o REFUSED si se negó a darlo>`).join('\n') +
      '\n\nNada de explicaciones ni texto adicional, solo esas líneas.';

    const raw = await this.llmService.chat(llmMessages, {
      systemPrompt: extractPrompt,
      maxTokens: LLM_QUERY_EXTRACT_MAX_TOKENS,
      temperature: 0,
    });

    const outcomes: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!match) continue;
      // Clave normalizada, no igualdad exacta: un modelo de razonamiento suele decorar
      // la línea aunque el prompt pida el formato pelado — "- sede: X", "**sede**: X",
      // "Sede: X" — y el match exacto tiraba esas respuestas válidas a NONE.
      const parsedKey = this.normalizeForMatch(match[1]);
      const item = items.find((i) => this.normalizeForMatch(i.key) === parsedKey);
      if (!item) continue;
      // Mismo motivo sobre el valor: sacarle markdown/comillas envolventes antes de
      // guardarlo ("**DM - Martinez**" → "DM - Martinez").
      outcomes[item.key] = match[2].trim().replace(/^[*_`"']+|[*_`"']+$/g, '').trim();
    }

    // Nada parseó para alguna clave pendiente: dejar rastro del output crudo — sin esto,
    // un `content` vacío/cortado (ej. modelo de razonamiento sin presupuesto de tokens) o
    // un formato inesperado se convierte en NONE en silencio y el nodo re-pregunta datos
    // que el usuario ya dio, sin ninguna pista en los logs de por qué.
    const unparsed = items.filter(({ key }) => !outcomes[key]);
    if (unparsed.length) {
      this.logger.warn(
        `extractLlmQueryValues: sin línea parseable para [${unparsed.map((i) => i.key).join(', ')}] — ` +
          `respuesta cruda del modelo (${raw.length} chars): ${JSON.stringify(raw.slice(0, 500))}`,
      );
    }

    for (const { key } of items) {
      const value = outcomes[key];
      if (!value) {
        outcomes[key] = 'NONE';
        continue;
      }
      const upper = value.toUpperCase();
      if (upper === 'NONE' || upper === 'REFUSED') {
        outcomes[key] = upper;
        continue;
      }
      const spec = pending.find((v) => this.stripVariableBraces(v.variable) === key);
      if (spec?.allowedValues?.length) {
        // Match normalizado en vez de exacto: el prompt le pide al modelo devolver el
        // valor "calcado", pero en la práctica varía (tilde, mayúscula, punto final, o
        // "Alta prioridad" en vez de "Alta") — con match exacto, una respuesta que el
        // usuario SÍ dio terminaba descartada a NONE por una diferencia cosmética, no
        // porque no se haya dicho. Primero intenta igualdad normalizada; si no hay,
        // contención en cualquier sentido (agarra tanto "alta" dentro de "alta
        // prioridad" como al revés).
        const normalized = this.normalizeForMatch(value);
        const matched =
          spec.allowedValues.find((v) => this.normalizeForMatch(v) === normalized) ||
          spec.allowedValues.find((v) => {
            const nv = this.normalizeForMatch(v);
            return nv.length > 0 && (normalized.includes(nv) || nv.includes(normalized));
          });
        outcomes[key] = matched || 'NONE';
      }
    }

    return outcomes;
  }

  /**
   * Normaliza para comparar valores de `llm_query.allowedValues` contra lo que devuelve
   * el clasificador: sin tildes, minúsculas, puntuación colapsada a espacios. Pensado
   * para tolerar variaciones cosméticas de la respuesta del modelo, no para reconocer
   * sinónimos o texto libre — la comparación sigue siendo contra el catálogo cerrado de
   * `allowedValues`, nunca contra un valor inventado.
   */
  private normalizeForMatch(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Redacta la pregunta que `llm_query` le manda al usuario por los datos que faltan.
   * Ante cualquier falla del proveedor, cae a una pregunta fija en vez de dejar el nodo sin
   * responder — el peor caso es una pregunta menos natural, no un turno perdido.
   *
   * `temperature` viene del nodo (`data.temperature`); default 0 si no se configuró — a
   * diferencia de dejarla caer en el `LLM_TEMPERATURE` global (pensado para charla libre,
   * no para esta redacción acotada), 0 es lo que garantiza que respete "UNA pregunta, nada
   * más" en vez de mezclar la pregunta con una respuesta libre tipo asistente.
   */
  private async generateLlmQueryQuestion(
    systemPrompt: string,
    llmMessages: LlmMessage[],
    missing: Array<{ variable: string; label?: string }>,
    temperature?: number,
  ): Promise<string> {
    const labels = missing.map((v) => v.label || this.stripVariableBraces(v.variable));
    const fallback = `Para continuar, necesito que me indiques: ${labels.join(', ')}.`;
    try {
      const raw = await this.llmService.chat(llmMessages, {
        systemPrompt:
          `${systemPrompt}\n\nTodavía falta que el usuario indique: ${labels.join(', ')}. Redactá UNA ` +
          'pregunta breve y amable pidiéndole ese dato (o esos datos, si son varios). Nada más que la ' +
          'pregunta, sin saludos ni explicaciones.',
        temperature: temperature ?? 0,
      });
      return raw.trim() || fallback;
    } catch (err) {
      this.logger.warn(`No se pudo generar la pregunta de llm_query (${labels.join(', ')}): ${(err as Error).message}`);
      return fallback;
    }
  }

  /**
   * Arma el system prompt base: `LLM_SYSTEM_PROMPT` de /settings (con
   * `DEFAULT_SYSTEM_PROMPT` como piso si no hay nada cargado ni en BD ni en env,
   * cascada de `AppConfigService`) seguido del texto del Skill del flujo en curso,
   * si tiene uno vinculado (`Flow.skillId`). Es el punto único donde se combinan
   * ambos — tanto el nodo `llm_query` como `orchestratorLlm` parten de acá.
   */
  private async buildBasePrompt(skillPromptText: string | null): Promise<string> {
    const settingsPrompt = await this.appConfig.get('LLM_SYSTEM_PROMPT', DEFAULT_SYSTEM_PROMPT);
    return [settingsPrompt, skillPromptText]
      .map((s) => s?.trim())
      .filter((s): s is string => !!s)
      .join('\n\n');
  }

  /**
   * Orquestador LLM para mensajes fuera de flujo o cuando no hay flujo activo.
   * Interpreta intenciones, detecta referencias a tickets, y genera respuestas completas.
   * `contextSourceId`: fuente de verdad vinculada al `Flow` en curso (null si no
   * hay flujo activo o el flujo no tiene ninguna vinculada) — si está presente, se
   * consulta siempre antes de generar la respuesta (ver más abajo).
   * `skillPromptText`: texto del Skill vinculado al `Flow` en curso (null si no hay
   * flujo activo o no tiene ninguno vinculado) — ver `buildBasePrompt`.
   */
  private async orchestratorLlm(
    conversation: any,
    body: string,
    tenantId: string,
    contextSourceId: string | null,
    skillPromptText: string | null,
  ): Promise<string> {
    // `sessionStartedAt` acota el historial a la sesión actual: si la charla
    // se cerró y se reanudó (mismo Conversation.id, ver `handleMessage`), los
    // `Message` de antes del cierre no cuentan como contexto de "la charla
    // actual" — verificado en producción, una charla con varios turnos rotos
    // de una sesión vieja seguía contaminando las respuestas nuevas después de
    // reanudar. Fallback a `createdAt` para filas de antes de esta migración.
    const sessionStart = conversation.sessionStartedAt ?? conversation.createdAt;
    // `desc` + `take` para los ÚLTIMOS 10 de la sesión (no los primeros 10) — mismo
    // motivo que en `case 'llm_query'`: con `asc` una sesión de más de 10 mensajes
    // deja al modelo mirando el arranque de la charla en vez de lo último dicho.
    const recentMessages = (
      await this.prisma.message.findMany({
        where: { conversationId: conversation.id, createdAt: { gte: sessionStart } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
    ).reverse();

    // Fuente de verdad vinculada al flujo: se consulta siempre que esté presente,
    // antes de generar la respuesta — no queda a criterio del LLM pedirla (eso
    // dependía de que el modelo devolviera un sentinel exacto, y con proveedores
    // poco confiables o modelos de razonamiento el sentinel no siempre llegaba
    // tal cual, así que la fuente terminaba sin consultarse). `queryKnowledge`
    // nunca tira (atrapa timeout/error internamente y devuelve `ok:false`).
    let knowledgeContext: string | null = null;
    if (contextSourceId) {
      const knowledge = await this.contextSourcesService.queryKnowledge(tenantId, contextSourceId, body);
      if (knowledge.ok && knowledge.answer) {
        knowledgeContext = knowledge.answer;
      } else {
        this.logger.warn(`Fuente de verdad ${contextSourceId} sin respuesta útil: ${knowledge.message}`);
      }
    }

    // Prompt base (LLM_SYSTEM_PROMPT de /settings + Skill del flujo, si tiene uno)
    // antepuesto a las instrucciones propias del orquestador — no las reemplaza.
    const basePrompt = await this.buildBasePrompt(skillPromptText);
    const orchestratorInstructions =
      'Eres un orquestador de soporte técnico. Tu trabajo es:\n' +
      '1. Entender la consulta del usuario\n' +
      '2. Si menciona un ticket existente, analizarlo para dar contexto\n' +
      '3. Si necesita crear un ticket, hacer las preguntas necesarias para completarlo\n' +
      '4. Si es una pregunta simple, responder directamente\n' +
      '5. Siempre ser amable, conciso y en español.' +
      (knowledgeContext
        ? '\n6. Abajo tenés el contexto de la fuente de verdad vinculada a este flujo — ' +
          'es información autoritativa: si contradice lo que ya sabés, priorizala a ella. ' +
          'Si ni con ese contexto podés responder, decilo con honestidad en vez de inventar.'
        : '');

    const llmMessages: LlmMessage[] = [
      {
        role: 'system',
        content: [basePrompt, orchestratorInstructions].filter(Boolean).join('\n\n'),
      },
      ...(knowledgeContext
        ? [{ role: 'system' as const, content: `Contexto de la fuente de verdad vinculada a este flujo:\n${knowledgeContext}` }]
        : []),
      ...recentMessages.map((m) => ({
        role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // Detectar referencias a tickets (números de 3+ dígitos)
    const ticketRefMatch = body.match(/ticket\s*#?(\d+)/i) || body.match(/\b(\d{3,})\b/);
    if (ticketRefMatch) {
      const ticketId = ticketRefMatch[1];
      const ticket = await this.prisma.ticket.findFirst({
        where: { id: { contains: ticketId }, tenantId },
      });
      if (ticket) {
        llmMessages.push({
          role: 'system',
          content: `Contexto del ticket #${ticket.id}: ${ticket.subject} - Estado: ${ticket.status} - Prioridad: ${ticket.priority || 'normal'}`,
        });
      }
    }

    try {
      const responseText = await this.llmService.chat(llmMessages);
      return responseText;
    } catch (err) {
      // A diferencia de `interpretMenuChoice` (que tiene un fallback silencioso
      // porque es un paso interno), acá no hay nada más que devolver — es la
      // respuesta final al usuario. Sin este catch, un timeout o error del
      // proveedor (ej. OpenCode Go con REQUEST_TIMEOUT_MS=120s) tiraba sin capturar
      // hasta `handleMessage`, y el usuario se quedaba sin ninguna respuesta.
      this.logger.error(`orchestratorLlm: el proveedor LLM falló — ${err instanceof Error ? err.message : err}`);
      return 'Perdón, tuve un problema para responderte. ¿Podés reformular tu consulta o intentar de nuevo en un momento?';
    }
  }
}
