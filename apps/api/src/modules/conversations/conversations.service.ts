import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { BrokerService, BrokerMessage } from '../broker/broker.service';
import { UsersService } from '../users/users.service';
import { FlowService } from '../flow/flow.service';
import { LlmMessage } from '../llm/llm-provider.interface';

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
    this.logger.log('Subscribed to whatsapp.incoming');
  }

  async processIncomingMessage(from: string, body: string, tenantId: string) {
    return this.handleMessage({
      pattern: 'message.received',
      data: { from, body },
      tenantId,
      timestamp: new Date().toISOString(),
    });
  }

  private async handleMessage(msg: BrokerMessage) {
    const { from, body } = msg.data as { from: string; body: string };
    const tenantId = msg.tenantId!;

    this.logger.log(`[${tenantId}] Mensaje de ${from}: ${body.substring(0, 50)}...`);

    // 1. Identificar o crear usuario por teléfono
    const user = await this.usersService.findOrCreateByPhone(from);

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

    const flowResult = await this.executeFlow(conversation, user, body, tenantId, from);
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

    // 7. Publicar respuesta al canal de salida
    await this.broker.publish('whatsapp.outgoing', {
      pattern: 'message.send',
      data: { to: from, body: responseText },
      tenantId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`[${tenantId}] Respuesta enviada a ${from}`);
  }

  /**
   * Ejecuta un flujo IVR para la conversación actual.
   * Retorna la respuesta a enviar al usuario, o null si no hay flujo activo.
   */
  private async executeFlow(
    conversation: any,
    user: any,
    body: string,
    tenantId: string,
    from: string,
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

      // Inicializar flujo en la conversación
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { currentFlowId: flowId, currentNodeId, flowState: {} },
      });
    }

    const flow = await this.flowService.findById(flowId);
    const nodes = flow.nodes as any[];
    const edges = flow.edges as any[];

    // Encontrar nodo actual
    let node = nodes.find((n) => n.id === currentNodeId);
    if (!node) {
      // Nodo no encontrado, resetear flujo
      await this.resetFlow(conversation.id);
      return null;
    }

    // Ejecutar nodo según tipo
    const result = await this.executeNode(node, body, conversation, user, tenantId, from, edges);

    // Determinar siguiente nodo
    let nextNodeId: string | null = null;
    if (result.nextNodeId) {
      nextNodeId = result.nextNodeId;
    } else if (node.type === 'menu' || node.type === 'input' || node.type === 'condition') {
      // Para nodos interactivos, si no hay next explícito, mantener en el mismo nodo
      nextNodeId = node.id;
    } else {
      // Para nodos no interactivos, avanzar por la primera arista
      const edge = edges.find((e) => e.source === node.id);
      nextNodeId = edge?.target ?? null;
    }

    // Manejar transición a sub-flujo
    let effectiveFlowId = flowId;
    let effectiveNextNodeId = nextNodeId;
    if (result.flowState?.__subflow) {
      const sub = result.flowState.__subflow;
      effectiveFlowId = sub.flowId;
      effectiveNextNodeId = sub.entryNodeId;
      // Limpiar marca de sub-flujo para evitar loops infinitos
      delete result.flowState.__subflow;
    }

    // Actualizar estado de la conversación
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        currentFlowId: effectiveFlowId,
        currentNodeId: effectiveNextNodeId,
        flowState: result.flowState ? JSON.parse(JSON.stringify(result.flowState)) : conversation.flowState,
      },
    });

    if (!effectiveNextNodeId) {
      // Fin del flujo
      await this.resetFlow(conversation.id);
    }

    return result.responseText ?? null;
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
  ): Promise<{ responseText?: string; nextNodeId?: string; flowState?: any }> {
    const type = node.type;
    const data = node.data || {};
    const flowState = (conversation.flowState as Record<string, any>) || {};

    switch (type) {
      case 'start': {
        // Identificación del usuario por teléfono
        const phoneUser = await this.usersService.findByPhone(from);
        const isKnown = !!(phoneUser && (phoneUser.name || phoneUser.email));
        flowState.isKnownUser = isKnown;
        flowState.userName = phoneUser?.name || null;
        flowState.userEmail = phoneUser?.email || null;
        flowState.userPhone = from;
        flowState.userId = phoneUser?.id || null;

        const greeting = isKnown
          ? `¡Hola ${phoneUser?.name || ''}! Bienvenido de nuevo.`
          : data.text || '¡Hola! Bienvenido. ¿En qué puedo ayudarte?';

        // Dos salidas: conocido / desconocido
        const targetNodeId = isKnown ? data.knownTargetNodeId : data.unknownTargetNodeId;

        return { responseText: greeting, nextNodeId: targetNodeId || undefined, flowState };
      }

      case 'message': {
        // Avanzar automáticamente al siguiente nodo
        return { responseText: data.text };
      }

      case 'menu': {
        const options = data.options || [];
        const selected = options.find((opt: any) =>
          body.trim() === opt.value || body.trim() === opt.label || body.trim() === String(options.indexOf(opt) + 1),
        );

        if (selected) {
          // Buscar arista con sourceHandle = valor seleccionado
          const edge = edges.find((e: any) => e.source === node.id && e.sourceHandle === String(selected.value));
          return { nextNodeId: edge?.target || selected.targetNodeId };
        }

        // No seleccionó opción válida: repetir menú
        const menuText = data.text + '\n' + options.map((opt: any, idx: number) => `${idx + 1}. ${opt.label}`).join('\n');
        return { responseText: menuText };
      }

      case 'input': {
        // Guardar input en variable
        if (data.variableName) {
          flowState[data.variableName] = body;
        }
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
        const seconds = data.seconds || 1;
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
