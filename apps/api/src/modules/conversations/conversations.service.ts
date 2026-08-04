import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { UsersService } from '../users/users.service';
import { FlowService } from '../flow/flow.service';
import { LlmMessage } from '../llm/llm-provider.interface';

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
 * Timeout del request/reply de simulate. Generoso a propósito: OpenCode Go razona
 * antes de responder y en la práctica tarda unos segundos, pero su propio timeout
 * interno por llamada HTTP es de 2 minutos (ver OpenCodeGoProvider).
 */
const SIMULATE_TIMEOUT_MS = 90_000;

/** Corte de seguridad ante flujos con ciclos entre nodos no interactivos. */
const MAX_FLOW_STEPS = 25;

/** Tope del nodo `delay`: encadenando, un delay largo colgaría la request entera. */
const MAX_DELAY_SECONDS = 10;

@Injectable()
export class ConversationsService implements OnModuleInit {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly broker: BrokerService,
    private readonly usersService: UsersService,
    private readonly flowService: FlowService,
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

    // 2. Buscar o crear conversación activa
    let conversation = await this.prisma.conversation.findFirst({
      where: { userId: user.id, tenantId, channel: 'whatsapp', status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          userId: user.id,
          tenantId,
          channel: 'whatsapp',
          externalId: from,
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

    // 4. EJECUTAR FLUJO IVR o ORQUESTADOR LLM
    let responseText: string;

    const flowResult = await this.executeFlow(conversation, user, body, tenantId, from, identity);
    if (flowResult) {
      responseText = flowResult;
    } else {
      // Fallback: orquestador LLM para mensajes fuera de flujo
      responseText = await this.orchestratorLlm(conversation, body, tenantId);
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
        data: { to: from, body: responseText },
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
  ): Promise<string | null> {
    // Buscar flujo activo
    let flowId = conversation.currentFlowId;
    let currentNodeId = conversation.currentNodeId;

    if (!flowId) {
      const flow = await this.flowService.findActiveFlowForTenant(tenantId);
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
    let nodeId: string | null = currentNodeId;
    let steps = 0;

    while (nodeId && steps < MAX_FLOW_STEPS) {
      steps++;

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) {
        // Nodo no encontrado (flujo editado bajo los pies): resetear.
        await this.resetFlow(conversation.id);
        return responses.length ? responses.join('\n\n') : null;
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
      );

      if (result.responseText) responses.push(result.responseText);
      if (result.flowState) flowState = result.flowState;

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
        return responses.length ? responses.join('\n\n') : null;
      }

      const nextNodeId = this.resolveNextNode(node, edges, result);

      // Un nodo que apunta a sí mismo no es un bucle a ejecutar: es "quedate acá
      // esperando el próximo mensaje". Sin esto daría MAX_FLOW_STEPS vueltas, y en
      // un llm_query eso son 25 llamadas al modelo por cada mensaje entrante.
      if (nextNodeId === node.id) {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return responses.length ? responses.join('\n\n') : null;
      }

      // `llm_query` sin salida es un punto final conversacional, no el fin del flujo:
      // la conversación queda parada ahí y los mensajes siguientes van derecho al
      // modelo, sin repetir el saludo ni los nodos previos.
      if (!nextNodeId && node.type === 'llm_query') {
        await this.persistFlowPosition(conversation.id, flowId, node.id, flowState);
        return responses.length ? responses.join('\n\n') : null;
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
      return responses.join('\n\n');
    }

    // Fin del flujo: se acabaron los nodos.
    await this.resetFlow(conversation.id);
    return responses.length ? responses.join('\n\n') : null;
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
  ): Promise<{
    responseText?: string;
    nextNodeId?: string;
    sourceHandle?: string;
    /** Corta la cadena y devuelve el turno al usuario, parando en este nodo. */
    waitForInput?: boolean;
    flowState?: any;
  }> {
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

      case 'menu': {
        const options = data.options || [];

        // Primera llegada al menú: mostrar opciones y esperar. Sin esto, al
        // encadenar nodos el menú consumiría el mensaje que lo activó.
        if (flowState.__awaiting !== node.id) {
          flowState.__awaiting = node.id;
          const menuText =
            (data.text ?? '') +
            '\n' +
            options.map((opt: any, idx: number) => `${idx + 1}. ${opt.label}`).join('\n');
          return { responseText: menuText.trim(), waitForInput: true, flowState };
        }

        const selected = options.find(
          (opt: any) =>
            body.trim() === opt.value ||
            body.trim() === opt.label ||
            body.trim() === String(options.indexOf(opt) + 1),
        );

        if (selected) {
          delete flowState.__awaiting;
          // Arista con sourceHandle = valor de la opción elegida
          const edge = edges.find(
            (e: any) => e.source === node.id && e.sourceHandle === String(selected.value),
          );
          return { nextNodeId: edge?.target || selected.targetNodeId, flowState };
        }

        // Opción inválida: repetir el menú y seguir esperando.
        const retryText =
          'Opción no válida.\n' +
          (data.text ?? '') +
          '\n' +
          options.map((opt: any, idx: number) => `${idx + 1}. ${opt.label}`).join('\n');
        return { responseText: retryText.trim(), waitForInput: true, flowState };
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

      case 'transfer_agent': {
        // TODO: Implementar cola de agentes humanos
        return {
          responseText: data.message || 'Te estoy transfiriendo con un agente humano. Por favor espera...',
        };
      }

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
   */
  private async orchestratorLlm(
    conversation: any,
    body: string,
    tenantId: string,
  ): Promise<string> {
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId: conversation.id },
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
          '5. Siempre ser amable, conciso y en español.',
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

    return this.llmService.chat(llmMessages, {
      systemPrompt:
        'Eres un asistente de soporte técnico amable y conciso. Responde en español. Si no sabes la respuesta, indícalo honestamente.',
    });
  }
}
