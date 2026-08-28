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
    private readonly inboundTenantRouting: InboundTenantRoutingService,
  ) {}

  async onModuleInit() {
    await this.broker.subscribe('whatsapp.incoming', this.handleMessage.bind(this));
    // SMS es un canal aparte, no una alternativa de WhatsApp (a diferencia de Twilio vs
    // Meta, que comparten cola porque son el mismo canal): conversaciones propias, no
    // compite por whatsapp.incoming. `handleMessage` es el mismo — ver `channel` en el
    // payload, que decide de qué `Conversation` y a qué cola de salida se habla.
    await this.broker.subscribe('sms.incoming', this.handleMessage.bind(this));
    // Mismo handler, misma lógica de negocio: la única diferencia con el canal real
    // es por qué cola entra el mensaje. Así /simulate ejercita el camino real
    // completo (RabbitMQ de punta a punta) en vez de llamar al método en proceso.
    await this.broker.subscribe(SIMULATE_QUEUE, this.handleMessage.bind(this));
    this.logger.log(`Subscribed to whatsapp.incoming, sms.incoming and ${SIMULATE_QUEUE}`);
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
    // no simplemente "existe un User con este teléfono". Ese chequeo tiene que
    // hacerse ANTES de crear el placeholder de WhatsApp: si se hiciera después (como
    // hacía antes el nodo `start`), el usuario siempre iba a existir porque lo
    // acabábamos de crear nosotros mismos un instante antes, y el número nunca se
    // detectaba como desconocido.
    const membership = await this.usersService.findMembershipByPhone(from, tenantId);
    const user = membership?.user ?? (await this.usersService.findOrCreateByPhone(from));
    const identity = {
      isKnown: !!membership,
      roleId: membership?.role.id ?? null,
      roleName: membership?.role.name ?? null,
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

    // 2.5 Adjuntos (imágenes de WhatsApp/SMS vía Twilio, ver TwilioWebhookController/
    // TwilioSmsWebhookController): se acumulan en flowState.pendingAttachments hasta que
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
      // Fallback: orquestador LLM para mensajes fuera de flujo
      responseText = await this.orchestratorLlm(conversation, body, tenantId, null, null);
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
    // Buscar flujo activo
    let flowId = conversation.currentFlowId;
    let currentNodeId = conversation.currentNodeId;

    if (!flowId) {
      // El flujo de inicio se elige por (empresa + rol del usuario): `identity.roleId`
      // ya viene resuelto desde handleMessage contra el registro real de usuarios.
      const flow = await this.flowService.findActiveFlowForTenant(tenantId, identity.roleId);
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
        // Nodo no encontrado (flujo editado bajo los pies): resetear.
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

      const nextNodeId = this.resolveNextNode(node, edges, result);

      // Un nodo que apunta a sí mismo no es un bucle a ejecutar: es "quedate acá
      // esperando el próximo mensaje". Sin esto daría MAX_FLOW_STEPS vueltas, y en
      // un llm_query eso son 25 llamadas al modelo por cada mensaje entrante.
      if (nextNodeId === node.id) {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return this.toFlowResult(responses, interactive);
      }

      // `llm_query` sin salida es un punto final conversacional, no el fin del flujo:
      // la conversación queda parada ahí y los mensajes siguientes van derecho al
      // modelo, sin repetir el saludo ni los nodos previos.
      if (!nextNodeId && node.type === 'llm_query') {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return this.toFlowResult(responses, interactive);
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

  /** Junta las respuestas acumuladas de `executeFlow` en el resultado final, o `null` si no hubo ninguna. */
  private toFlowResult(
    responses: string[],
    interactive?: WhatsAppInteractive,
  ): { text: string; interactive?: WhatsAppInteractive } | null {
    return responses.length ? { text: responses.join('\n\n'), interactive } : null;
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

  /** Mismo reemplazo de `{{variable}}` que `interpolate`, aplicado a un mensaje interactivo (botones/lista). */
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

    await this.emailService.send({
      to: email,
      subject: 'Código de validación de dispositivo - Plataforma Conversacional Inteligente',
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
   * Nodo `ticket_query`: si el ticket ya se sincronizó con InvGate, trae el estado
   * real de ahí (InvGate es la fuente de verdad una vez sincronizado — el estado local
   * solo se actualiza cuando el bot lo consulta, no hay webhook de InvGate todavía) y
   * de paso actualiza `Ticket.status` local para que quede consistente. Sin
   * `invgateId` (o si InvGate no responde), devuelve el estado local tal cual.
   */
  private async refreshInvgateStatus(ticket: { id: string; invgateId: string | null; status: string }): Promise<string> {
    if (!ticket.invgateId || !(await this.invgateService.isConfigured())) return ticket.status;

    try {
      const incident = await this.invgateService.getIncident(ticket.invgateId);
      if (incident.status_id === undefined) return ticket.status;

      const statusName = await this.invgateService.getStatusName(incident.status_id);
      if (statusName !== ticket.status) {
        await this.prisma.ticket.update({ where: { id: ticket.id }, data: { status: statusName } });
      }
      return statusName;
    } catch (err) {
      this.logger.warn(`No se pudo refrescar el estado del ticket ${ticket.id} desde InvGate: ${(err as Error).message}`);
      return ticket.status;
    }
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
      ? await this.pickNextAssignee(flowId, node.id, assigneeIds)
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
      const recipients = notifyIds.length
        ? await this.prisma.user.findMany({ where: { id: { in: notifyIds } } })
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
      const recipients = await this.prisma.user.findMany({ where: { id: { in: recipientIds } } });
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

  /** Elige el próximo de `assigneeIds` en orden, rotando sobre el índice persistido en FlowNodeRoundRobin. */
  private async pickNextAssignee(flowId: string, nodeId: string, assigneeIds: string[]) {
    // `data.assignees` es config del nodo (no se actualiza sola cuando alguien se da de
    // baja), así que filtramos acá: un colaborador soft-deleted sale de la rotación en
    // vez de seguir recibiendo tickets/transferencias. Orden estable según `assigneeIds`,
    // no el que devuelva la DB.
    const active = await this.prisma.user.findMany({
      where: { id: { in: assigneeIds }, deletedAt: null },
    });
    if (!active.length) return null;
    const activeIds = assigneeIds.filter((id) => active.some((u) => u.id === id));

    const state = await this.prisma.flowNodeRoundRobin.upsert({
      where: { flowId_nodeId: { flowId, nodeId } },
      update: {},
      create: { flowId, nodeId, lastIndex: -1 },
    });

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

        const greeting = identity.isKnown
          ? `¡Hola ${user?.firstName || ''}! Bienvenido de nuevo.`
          : data.text || '¡Hola! Bienvenido. ¿En qué puedo ayudarte?';

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

      case 'condition': {
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
        // `lastTicketId` (lo que consulta `ticket_query` después) y lo que ve el usuario
        // acá: preferí SIEMPRE el número de InvGate — el cuid interno no le sirve a nadie
        // fuera del sistema. Sin sync (InvGate caído, mal configurado, etc.) cae al id
        // local — sigue siendo un ticket válido, solo que no llegó a InvGate todavía.
        flowState.lastTicketId = invgateTicketId ?? ticket.id;
        return {
          responseText: `Ticket #${flowState.lastTicketId} creado. Un agente te contactará pronto.`,
          flowState,
        };
      }

      case 'ticket_query': {
        // `ticketId` puede ser el cuid interno (tickets viejos, o uno nuevo que no llegó
        // a sincronizar con InvGate) o el número de InvGate (lo normal ahora, ver
        // `lastTicketId` en 'ticket_create'/executeTransferAgentNode) — se busca por
        // cualquiera de los dos campos, sin necesidad de adivinar cuál es.
        const ticketId = data.ticketIdVariable
          ? flowState[this.stripVariableBraces(data.ticketIdVariable)]
          : flowState.lastTicketId;
        if (ticketId) {
          // `tenantId` es obligatorio acá: `invgateId` es un correlativo global de
          // InvGate (sistema externo, no tiene noción de tenant) y `id` es un cuid
          // — sin este filtro, un tenant puede consultar (y ver subject/status de)
          // tickets de otro tenant adivinando un número de InvGate bajo.
          const ticket = await this.prisma.ticket.findFirst({
            where: { tenantId, OR: [{ id: String(ticketId) }, { invgateId: String(ticketId) }] },
          });
          if (ticket) {
            const status = await this.refreshInvgateStatus(ticket);
            return {
              responseText: `Ticket #${ticket.invgateId ?? ticket.id}: ${ticket.subject} - Estado: ${status}`,
            };
          }
        }
        return { responseText: 'No encontré el ticket solicitado.' };
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
        // TODO: Implementar llamada HTTP a webhook externo
        return { responseText: 'Acción webhook ejecutada (stub).' };
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
    const allResolved = variables.every(
      (v) => flowState[this.stripVariableBraces(v.variable)] !== LLM_QUERY_UNDEFINED_VALUE,
    );
    return { nextNodeId: allResolved ? data.foundTargetNodeId : data.missingTargetNodeId, flowState };
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
      maxTokens: CLASSIFIER_MAX_TOKENS,
      temperature: 0,
    });

    const outcomes: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!match) continue;
      const item = items.find((i) => i.key.toLowerCase() === match[1].trim().toLowerCase());
      if (!item) continue;
      outcomes[item.key] = match[2].trim();
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
        const matched = spec.allowedValues.find((v) => v.toLowerCase() === value.toLowerCase());
        outcomes[key] = matched || 'NONE';
      }
    }

    return outcomes;
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
