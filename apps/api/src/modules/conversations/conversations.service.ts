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

/** Texto exacto que `orchestratorLlm` le pide al LLM para señalar "necesito la fuente de verdad". */
const NEEDS_SOURCE_SENTINEL = 'NECESITA_FUENTE';

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
  ) {}

  async onModuleInit() {
    await this.broker.subscribe('whatsapp.incoming', this.handleMessage.bind(this));
    // Mismo handler, misma lógica de negocio: la única diferencia con el canal real
    // es por qué cola entra el mensaje. Así /simulate ejercita el camino real
    // completo (RabbitMQ de punta a punta) en vez de llamar al método en proceso.
    await this.broker.subscribe(SIMULATE_QUEUE, this.handleMessage.bind(this));
    this.logger.log(`Subscribed to whatsapp.incoming and ${SIMULATE_QUEUE}`);
  }

  /**
   * Para /conversations/simulate. Publica el mensaje en `SIMULATE_QUEUE` y espera
   * —a través del broker, no en memoria— la respuesta que `handleMessage` publica
   * de vuelta. Simula el funcionamiento real: RabbitMQ de punta a punta, no una
   * llamada directa que se salte la cola.
   */
  async simulateIncomingMessage(from: string, body: string, tenantId: string): Promise<string> {
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

    const { body: replyText } = reply.data as { to: string; body: string };
    return replyText;
  }

  /** Devuelve el texto con el que respondió el bot, para que `simulate` pueda mostrarlo. */
  private async handleMessage(msg: BrokerMessage): Promise<string> {
    const { from, body } = msg.data as { from: string; body: string };
    const tenantId = msg.tenantId!;

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
      where: { userId: user.id, tenantId, channel: 'whatsapp', status: 'active' },
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
          channel: 'whatsapp',
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
              channel: 'whatsapp',
              externalId: from,
              sessionStartedAt: new Date(),
            },
          });
    }

    // 3. Guardar mensaje del usuario
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'user',
        content: body,
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
        msg.replyTo ?? 'whatsapp.outgoing',
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
      responseText = await this.orchestratorLlm(conversation, body, tenantId, null);
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
      msg.replyTo ?? 'whatsapp.outgoing',
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
        { temperature: 0, maxTokens: 10 },
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
        { temperature: 0, maxTokens: 10 },
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
        { temperature: 0, maxTokens: 20 },
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
      flowState.lastTicketId = ticket.id;
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

  /** Elige el próximo de `assigneeIds` en orden, rotando sobre el índice persistido en FlowNodeRoundRobin. */
  private async pickNextAssignee(flowId: string, nodeId: string, assigneeIds: string[]) {
    const state = await this.prisma.flowNodeRoundRobin.upsert({
      where: { flowId_nodeId: { flowId, nodeId } },
      update: {},
      create: { flowId, nodeId, lastIndex: -1 },
    });

    const nextIndex = (state.lastIndex + 1) % assigneeIds.length;
    await this.prisma.flowNodeRoundRobin.update({
      where: { flowId_nodeId: { flowId, nodeId } },
      data: { lastIndex: nextIndex },
    });

    const nextUserId = assigneeIds[nextIndex];
    return this.prisma.user.findUnique({ where: { id: nextUserId } });
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
          const responseText = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId);
          return { responseText, waitForInput: true, flowState };
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
        const fallbackResponse = await this.orchestratorLlm(conversation, body, tenantId, contextSourceId);
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
          flowState[data.variableName] = body;
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
        const ticket = await this.prisma.ticket.create({
          data: {
            userId: user.id,
            tenantId,
            subject: data.subject || flowState.subject || body.substring(0, 100),
            description: data.description || flowState.description || body,
            priority: data.priority || 'medium',
          },
        });
        flowState.lastTicketId = ticket.id;
        return {
          responseText: `Ticket #${ticket.id} creado. Un agente te contactará pronto.`,
          flowState,
        };
      }

      case 'ticket_query': {
        const ticketId = data.ticketIdVariable ? flowState[data.ticketIdVariable] : flowState.lastTicketId;
        if (ticketId) {
          const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
          if (ticket) {
            return {
              responseText: `Ticket #${ticket.id}: ${ticket.subject} - Estado: ${ticket.status}`,
            };
          }
        }
        return { responseText: 'No encontré el ticket solicitado.' };
      }

      case 'transfer_agent':
        return this.executeTransferAgentNode(node, data, user, tenantId, body, flowState, flowId);

      case 'llm_query': {
        const recentMessages = await this.prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'asc' },
          take: data.contextMessages || 10,
        });

        const llmMessages: LlmMessage[] = recentMessages.map((m) => ({
          role: m.senderType === 'user' ? 'user' : 'assistant',
          content: m.content,
        }));

        const responseText = await this.llmService.chat(llmMessages, {
          systemPrompt:
            data.systemPrompt ||
            'Eres un asistente de soporte técnico amable y conciso. Responde en español.',
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
          flowState[data.name] = data.value ?? body;
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
   * Orquestador LLM para mensajes fuera de flujo o cuando no hay flujo activo.
   * Interpreta intenciones, detecta referencias a tickets, y genera respuestas completas.
   * `contextSourceId`: fuente de verdad vinculada al `Flow` en curso (null si no
   * hay flujo activo o el flujo no tiene ninguna vinculada) — ver más abajo.
   */
  private async orchestratorLlm(
    conversation: any,
    body: string,
    tenantId: string,
    contextSourceId: string | null,
  ): Promise<string> {
    // `sessionStartedAt` acota el historial a la sesión actual: si la charla
    // se cerró y se reanudó (mismo Conversation.id, ver `handleMessage`), los
    // `Message` de antes del cierre no cuentan como contexto de "la charla
    // actual" — verificado en producción, una charla con varios turnos rotos
    // de una sesión vieja seguía contaminando las respuestas nuevas después de
    // reanudar. Fallback a `createdAt` para filas de antes de esta migración.
    const sessionStart = conversation.sessionStartedAt ?? conversation.createdAt;
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId: conversation.id, createdAt: { gte: sessionStart } },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    const llmMessages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'Eres un orquestador de soporte técnico. Tu trabajo es:\n' +
          '1. Entender la consulta del usuario\n' +
          '2. Si menciona un ticket existente, analizarlo para dar contexto\n' +
          '3. Si necesita crear un ticket, hacer las preguntas necesarias para completarlo\n' +
          '4. Si es una pregunta simple, responder directamente\n' +
          '5. Siempre ser amable, conciso y en español.' +
          (contextSourceId
            ? '\n6. Hay una fuente de verdad externa disponible para lo que no puedas responder ' +
              'con lo que ya sabés o con el historial de esta charla. Si la necesitás, respondé ' +
              `ÚNICAMENTE con el texto exacto "${NEEDS_SOURCE_SENTINEL}" — sin nada más, sin ` +
              'inventar una respuesta ni pedir disculpas. Si ya podés responder sin consultarla, ' +
              'respondé normalmente: no la necesitás para todos los mensajes, solo cuando de ' +
              'verdad haga falta.'
            : ''),
      },
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

    const chatOptions = {
      systemPrompt:
        'Eres un asistente de soporte técnico amable y conciso. Responde en español. Si no sabes la respuesta, indícalo honestamente.',
    };

    try {
      let responseText = await this.llmService.chat(llmMessages, chatOptions);

      // Fuente de verdad vinculada al flujo: se consulta solo cuando el LLM pidió
      // el sentinel de arriba, no en cada turno — antes se consultaba siempre que
      // el flujo tuviera una `contextSourceId`, así que una charla que ya había
      // resuelto su pregunta seguía pagando la latencia del RAG (~10-30s) en cada
      // mensaje siguiente, aunque fuera un simple "gracias" o un tema nuevo que el
      // LLM podía responder solo. Con el sentinel, se intenta responder local
      // primero y solo se va al RAG cuando el propio LLM señala que lo necesita —
      // el próximo turno vuelve a intentar local. `queryKnowledge` nunca tira
      // (atrapa timeout/error internamente y devuelve `ok:false`).
      if (contextSourceId && responseText.trim() === NEEDS_SOURCE_SENTINEL) {
        const knowledge = await this.contextSourcesService.queryKnowledge(tenantId, contextSourceId, body);
        if (knowledge.ok && knowledge.answer) {
          llmMessages.push({
            role: 'system',
            content: `Contexto de la fuente de verdad vinculada a este flujo:\n${knowledge.answer}`,
          });
          responseText = await this.llmService.chat(llmMessages, chatOptions);
          // Verificado en producción: con proveedores poco confiables (ej. OpenCode Go en
          // modo `plan`), a veces el LLM repite el sentinel tal cual incluso ya con el
          // contexto de la fuente en el mensaje — sin este chequeo, el usuario recibía el
          // texto crudo "NECESITA_FUENTE" como respuesta. Si vuelve a pasar, se le manda
          // directamente la respuesta de la fuente en vez de nada.
          if (responseText.trim() === NEEDS_SOURCE_SENTINEL) {
            responseText = knowledge.answer;
          }
        } else {
          this.logger.warn(`Fuente de verdad ${contextSourceId} sin respuesta útil: ${knowledge.message}`);
          responseText =
            'No tengo esa información disponible en este momento. ¿Podés reformular tu consulta o preguntar otra cosa?';
        }
      }

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
