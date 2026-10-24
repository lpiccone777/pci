import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { BrokerMessage, BrokerService } from '../broker/broker.service';
import { ConversationsService } from '../conversations/conversations.service';
import { FlowService } from '../flow/flow.service';
import {
  CallEndedEvent,
  CallStartedEvent,
  VOICE_EVENTS_QUEUE,
  VOICE_TURN_QUEUE,
  VOICE_TURN_REPLY_PATTERN,
  VoiceCallInfo,
  VoiceHeard,
  VoiceTurnError,
  VoiceTurnReply,
  VoiceTurnRequest,
} from './voice.types';

/** Vencimiento del lease del turno: si el proceso que lo tomó se cae, otro lo retoma. */
const TURN_LEASE_MS = 15_000;
/** Cuánto espera un turno a que se libere el de la misma llamada antes de responder `busy`. */
const TURN_LEASE_WAIT_MS = 10_000;
const TURN_LEASE_RETRY_MS = 25;

/** Contenido del mensaje del bot cuando respondió el LLM de voz: se reemplaza por lo oído. */
const DELEGATED_PLACEHOLDER = '(respuesta libre del voicebot)';

type VoiceCallWithConversation = Prisma.VoiceCallGetPayload<{ include: { conversation: true } }>;

/**
 * Canal de voz de pci (contrato de integración §5): consume `voice.events` y el RPC
 * `voice.turn` del voicebot y los corre contra el motor de flujos (`ConversationsService`,
 * canal `voice`).
 *
 * Lo que vive acá y no en el motor:
 * - **Una conversación por llamada** (`VoiceCall`, id = `callId`), abierta por lo primero que
 *   llegue (`call.started` o `kind: "start"`), sin usuario [DA5] y con el tenant del interno.
 * - **Serialización por llamada** [C4]: cola en memoria dentro del proceso + lease en
 *   `VoiceCall` entre instancias (un `UPDATE` condicionado a que esté vencido).
 * - **Idempotencia** [C27]: un `turnId` ya procesado devuelve la respuesta guardada.
 * - **`supersedes`** [DA1]: el snapshot de antes del turno se restaura si no fue `committed`.
 * - **`previous`/`lastSpoken`**: el mensaje del bot se reemplaza por lo que se oyó.
 * - **Siempre responde** [C7]: ante una falla, `error` con `actions: []`.
 */
@Injectable()
export class VoiceTurnsService implements OnModuleInit {
  private readonly logger = new Logger(VoiceTurnsService.name);
  /** Último trabajo encolado por llamada (serialización dentro del proceso). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly broker: BrokerService,
    private readonly conversations: ConversationsService,
    private readonly flows: FlowService,
  ) {}

  async onModuleInit() {
    await this.broker.subscribe(VOICE_TURN_QUEUE, (msg) => this.handleTurnMessage(msg));
    await this.broker.subscribe(VOICE_EVENTS_QUEUE, (msg) => this.handleEventMessage(msg));
    this.logger.log(`Subscribed to ${VOICE_TURN_QUEUE} and ${VOICE_EVENTS_QUEUE}`);
  }

  // --- RPC voice.turn ---

  private async handleTurnMessage(msg: BrokerMessage) {
    const startedAt = Date.now();
    const req = (msg.data ?? {}) as VoiceTurnRequest;
    const turnId = typeof req.turnId === 'string' ? req.turnId : '';
    let reply: VoiceTurnReply;
    try {
      this.assertValidTurn(req);
      reply = await this.serialize(req.callId, () => this.processTurn(req, startedAt));
    } catch (err) {
      const code = err instanceof VoiceTurnError ? err.code : 'internal';
      const level = err instanceof VoiceTurnError ? 'warn' : 'error';
      this.logger[level](
        `[voz] turno ${turnId || '?'} de ${req.callId ?? '?'}: ${code} (${err instanceof Error ? err.message : err})`,
      );
      reply = { v: 1, turnId, actions: [], awaitInput: true, committed: false, superseded: false, error: code };
    }

    this.logger.log(
      `[voz] turno ${turnId} (${req.kind}) de ${req.callId}: ${Date.now() - startedAt} ms` +
        (reply.error ? ` · error ${reply.error}` : ''),
    );
    if (!msg.replyTo) {
      this.logger.warn(`[voz] voice.turn ${turnId} sin replyTo: no hay a dónde responder.`);
      return;
    }
    // La cola de respuesta es del voicebot y exclusiva: no se reafirma [C35].
    await this.broker.publish(
      msg.replyTo,
      {
        pattern: VOICE_TURN_REPLY_PATTERN,
        data: reply,
        correlationId: msg.correlationId,
        timestamp: new Date().toISOString(),
      },
      { assert: false },
    );
  }

  private assertValidTurn(req: VoiceTurnRequest) {
    const ok =
      typeof req.callId === 'string' &&
      !!req.callId &&
      typeof req.turnId === 'string' &&
      !!req.turnId &&
      ['start', 'user', 'continue'].includes(req.kind);
    if (!ok) throw new VoiceTurnError('invalid_request', 'faltan callId, turnId o un kind válido');
    if (req.kind === 'start' && !req.call?.extension) {
      throw new VoiceTurnError('invalid_request', 'kind "start" sin call.extension');
    }
  }

  private async processTurn(req: VoiceTurnRequest, startedAt: number): Promise<VoiceTurnReply> {
    const call = await this.ensureCall(req.callId, req.call);
    return this.withLease(call.id, async () => {
      // Idempotencia [C27]: mismo turnId → misma respuesta, sin volver a correr el flujo.
      const done = await this.prisma.voiceTurn.findUnique({ where: { id: req.turnId } });
      if (done?.response) return done.response as unknown as VoiceTurnReply;

      if (req.previous?.turnId) await this.applyHeard(req.previous);

      let superseded = false;
      if (req.supersedes) superseded = await this.restoreSuperseded(call.id, req.supersedes);

      let conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { id: call.conversationId } });
      if (conversation.status !== 'active') {
        // El flujo terminó a mitad de llamada (fin de flujo sin `end`): la llamada sigue, así
        // que la conversación se reabre y el próximo tramo arranca de nuevo por el interno.
        conversation = await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { status: 'active', closedAt: null },
        });
      }
      // Copia profunda YA: el motor muta `flowState` en el lugar mientras corre el tramo.
      const snapshot = JSON.parse(
        JSON.stringify({
          currentFlowId: conversation.currentFlowId,
          currentNodeId: conversation.currentNodeId,
          flowState: conversation.flowState,
        }),
      ) as Prisma.InputJsonValue;

      const text = req.kind === 'user' ? (req.text ?? '').trim() : '';
      const userMessage = text
        ? await this.prisma.message.create({
            data: { conversationId: conversation.id, senderType: 'user', content: text },
          })
        : null;

      // Sin posición: flujo de la llamada por el interno [DA8]. Sin flujo → charla libre.
      const startFlow =
        conversation.currentFlowId || req.kind === 'continue' ? null : await this.resolveCallFlow(call);
      const output = await this.conversations.runVoiceFlow(
        conversation,
        call.tenantId,
        text,
        call.callerNumber,
        startFlow ?? undefined,
      );
      const flowOutput = output ?? {
        actions: [{ type: 'say' as const, mode: 'delegate' as const, systemPrompt: await this.conversations.voiceFreeChatPrompt() }],
        committed: false,
        ended: false,
      };

      const literal = flowOutput.actions.flatMap((a) => (a.type === 'say' && a.mode === 'literal' ? [a.text] : []));
      const delegated = flowOutput.actions.some((a) => a.type === 'say' && a.mode === 'delegate');
      const botContent = literal.join('\n\n') || (delegated ? DELEGATED_PLACEHOLDER : '');
      const botMessage = botContent
        ? await this.prisma.message.create({
            data: { conversationId: conversation.id, senderType: 'assistant', content: botContent },
          })
        : null;

      const reply: VoiceTurnReply = {
        v: 1,
        turnId: req.turnId,
        actions: flowOutput.actions,
        awaitInput: !flowOutput.ended,
        committed: flowOutput.committed,
        superseded,
        error: null,
      };
      await this.prisma.voiceTurn.create({
        data: {
          id: req.turnId,
          callId: call.id,
          kind: req.kind,
          text: text || null,
          response: reply as unknown as Prisma.InputJsonValue,
          committed: flowOutput.committed,
          snapshot,
          userMessageId: userMessage?.id ?? null,
          botMessageId: botMessage?.id ?? null,
          durationMs: Date.now() - startedAt,
        },
      });
      return reply;
    });
  }

  /** Flujo de la llamada por su interno [DA8+DA15]. `null` = charla libre. */
  private async resolveCallFlow(call: { extensionId: string | null; tenantId: string }) {
    const extension = call.extensionId
      ? await this.prisma.extension.findUnique({ where: { id: call.extensionId }, select: { tenantId: true, flowId: true } })
      : null;
    return this.flows.findVoiceFlowForExtension(extension ?? { tenantId: call.tenantId, flowId: null });
  }

  /**
   * `supersedes` [DA1]: si el turno reemplazado no tuvo efectos, se vuelve al estado de antes de
   * él y se borran sus mensajes (nunca se dijo). Si los tuvo, se ignora y se procesa encima.
   */
  private async restoreSuperseded(callId: string, supersededTurnId: string): Promise<boolean> {
    const old = await this.prisma.voiceTurn.findUnique({ where: { id: supersededTurnId } });
    if (!old || old.callId !== callId || old.committed || old.superseded) return false;

    const snapshot = (old.snapshot ?? {}) as {
      currentFlowId?: string | null;
      currentNodeId?: string | null;
      flowState?: Prisma.InputJsonValue | null;
    };
    const call = await this.prisma.voiceCall.findUniqueOrThrow({ where: { id: callId } });
    const messageIds = [old.userMessageId, old.botMessageId].filter((id): id is string => !!id);
    await this.prisma.$transaction([
      this.prisma.conversation.update({
        where: { id: call.conversationId },
        data: {
          status: 'active',
          closedAt: null,
          currentFlowId: snapshot.currentFlowId ?? null,
          currentNodeId: snapshot.currentNodeId ?? null,
          flowState: snapshot.flowState ?? Prisma.JsonNull,
        },
      }),
      this.prisma.message.deleteMany({ where: { id: { in: messageIds } } }),
      this.prisma.voiceTurn.update({ where: { id: old.id }, data: { superseded: true } }),
    ]);
    return true;
  }

  /** El mensaje del bot de ese turno pasa a ser lo que el usuario oyó (o se borra si nada). */
  private async applyHeard(heard: VoiceHeard) {
    const turn = await this.prisma.voiceTurn.findUnique({ where: { id: heard.turnId }, select: { botMessageId: true } });
    if (!turn?.botMessageId) return;
    const heardText = (heard.heardText ?? '').trim();
    if (heardText) {
      await this.prisma.message.updateMany({ where: { id: turn.botMessageId }, data: { content: heardText } });
    } else {
      await this.prisma.message.deleteMany({ where: { id: turn.botMessageId } });
    }
  }

  // --- voice.events ---

  private async handleEventMessage(msg: BrokerMessage) {
    try {
      if (msg.pattern === 'call.started') {
        const event = (msg.data ?? {}) as CallStartedEvent;
        if (!event.callId) throw new VoiceTurnError('invalid_request', 'call.started sin callId');
        await this.serialize(event.callId, () => this.onCallStarted(event));
      } else if (msg.pattern === 'call.ended') {
        const event = (msg.data ?? {}) as CallEndedEvent;
        if (!event.callId) throw new VoiceTurnError('invalid_request', 'call.ended sin callId');
        await this.serialize(event.callId, () => this.onCallEnded(event));
      } else {
        // `call.outbound.result` (§6) llega con las salientes de pci, en H5.
        this.logger.debug(`[voz] evento ${msg.pattern} sin consumidor todavía`);
      }
    } catch (err) {
      // Un evento que no se puede procesar no se reintenta: se loguea y se descarta.
      this.logger.warn(`[voz] evento ${msg.pattern} descartado: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Abre la llamada si no existe y registra la entrada real (`startedAt`) [C48]. */
  private async onCallStarted(event: CallStartedEvent) {
    const call = await this.ensureCall(event.callId, event, event.startedAt);
    const startedAt = event.startedAt ? new Date(event.startedAt) : null;
    await this.prisma.voiceCall.update({
      where: { id: call.id },
      data: {
        ...(startedAt && !Number.isNaN(startedAt.getTime()) && { startedAt }),
        calledNumber: call.calledNumber ?? event.calledNumber ?? null,
        callerNumber: call.callerNumber ?? event.callerNumber ?? null,
        ...(event.direction && { direction: event.direction }),
      },
    });
  }

  private async onCallEnded(event: CallEndedEvent) {
    const call = await this.prisma.voiceCall.findUnique({ where: { id: event.callId } });
    if (!call) {
      this.logger.warn(`[voz] call.ended de ${event.callId}: la llamada no se abrió en pci, se ignora.`);
      return;
    }
    await this.withLease(call.id, async () => {
      if (event.lastSpoken?.turnId) await this.applyHeard(event.lastSpoken);
      const endedAt = event.endedAt ? new Date(event.endedAt) : new Date();
      await this.prisma.$transaction([
        this.prisma.voiceCall.update({
          where: { id: call.id },
          data: {
            endedAt: Number.isNaN(endedAt.getTime()) ? new Date() : endedAt,
            endReason: event.reason ?? null,
            lastSpoken: event.lastSpoken ? (event.lastSpoken as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
        }),
        // Una conversación de voz no se retoma: la próxima llamada abre otra.
        this.prisma.conversation.update({
          where: { id: call.conversationId },
          data: {
            status: 'closed',
            closedAt: new Date(),
            currentFlowId: null,
            currentNodeId: null,
            flowState: Prisma.JsonNull,
          },
        }),
      ]);
    });
  }

  // --- llamada, serialización y lease ---

  /**
   * La llamada y su conversación, creadas por lo primero que llegue (`call.started` o el turno
   * `start`), sin depender del orden [§5.2]. El tenant sale del interno [DA5]; sin interno
   * habilitado no hay llamada [C45].
   */
  private async ensureCall(
    callId: string,
    info: VoiceCallInfo | undefined,
    startedAt?: string,
  ): Promise<VoiceCallWithConversation> {
    const found = await this.prisma.voiceCall.findUnique({ where: { id: callId }, include: { conversation: true } });
    if (found) return found;
    if (!info?.extension) throw new VoiceTurnError('unknown_call', `la llamada ${callId} no se abrió en pci`);

    const extension = await this.prisma.extension.findUnique({
      where: { number: String(info.extension).trim() },
      include: { tenant: { select: { deletedAt: true } } },
    });
    if (!extension || !extension.enabled) {
      throw new VoiceTurnError('unknown_extension', `el interno ${info.extension} no existe o está deshabilitado`);
    }
    if (extension.tenant.deletedAt) {
      throw new VoiceTurnError('tenant_unavailable', `la empresa del interno ${info.extension} está dada de baja`);
    }

    const start = startedAt ? new Date(startedAt) : new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const conversation = await tx.conversation.create({
          data: {
            userId: null,
            tenantId: extension.tenantId,
            channel: 'voice',
            externalId: callId,
            sessionStartedAt: new Date(),
          },
        });
        return tx.voiceCall.create({
          data: {
            id: callId,
            conversationId: conversation.id,
            tenantId: extension.tenantId,
            extensionId: extension.id,
            extensionNumber: extension.number,
            calledNumber: info.calledNumber ?? null,
            callerNumber: info.callerNumber ?? null,
            direction: info.direction ?? 'inbound',
            startedAt: Number.isNaN(start.getTime()) ? new Date() : start,
          },
          include: { conversation: true },
        });
      });
    } catch (err) {
      // Otra instancia la abrió entre el findUnique y el create: se usa esa.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.voiceCall.findUniqueOrThrow({ where: { id: callId }, include: { conversation: true } });
      }
      throw err;
    }
  }

  /** De a uno por llamada dentro de este proceso. */
  private serialize<T>(callId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(callId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.chains.set(callId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.chains.get(callId) === next) this.chains.delete(callId);
      });
    return next;
  }

  /**
   * De a uno por llamada entre instancias [C4]: lease en `VoiceCall`, tomado con un UPDATE
   * atómico condicionado a que esté libre o vencido. Se libera solo si sigue siendo propio.
   */
  private async withLease<T>(callId: string, work: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + TURN_LEASE_WAIT_MS;
    for (;;) {
      const now = new Date();
      const { count } = await this.prisma.voiceCall.updateMany({
        where: { id: callId, OR: [{ turnLockUntil: null }, { turnLockUntil: { lt: now } }] },
        data: { turnLockToken: token, turnLockUntil: new Date(now.getTime() + TURN_LEASE_MS) },
      });
      if (count) break;
      if (Date.now() > deadline) throw new VoiceTurnError('busy', `la llamada ${callId} tiene otro turno en curso`);
      await new Promise((r) => setTimeout(r, TURN_LEASE_RETRY_MS));
    }
    try {
      return await work();
    } finally {
      await this.prisma.voiceCall
        .updateMany({ where: { id: callId, turnLockToken: token }, data: { turnLockToken: null, turnLockUntil: null } })
        .catch((err) => this.logger.error(`[voz] no se pudo liberar el lease de ${callId}: ${err}`));
    }
  }
}
