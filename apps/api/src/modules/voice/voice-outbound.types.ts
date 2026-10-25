/**
 * Comandos pci → voicebot y resultado de las salientes (contrato de integración §6, C34, C63).
 */

/** Cola de comandos que consume el voicebot. RPC: `replyTo` + `correlationId`, como `voice.turn`. */
export const VOICEBOT_COMMANDS_QUEUE = 'voicebot.commands';

/** `call.outbound` [§6, C63]: un número por comando, con round-robin por `rotationKey` [C34]. */
export interface CallOutboundCommand {
  v: 1;
  /** `out-<uuid>`, lo genera pci [C63]. El voicebot lo usa como room. */
  callId: string;
  to: string[];
  flowId?: string;
  audioUrl?: string;
  digits?: string;
  maxRounds?: number;
  rotationKey: string;
  resetRotation?: boolean;
}

/**
 * `call.outbound.result` en `voice.events` [§6, C63]. Con flujo: `answered` sale al atender (el
 * cierre llega por `call.ended`) y `busy` es que no se discó por el tope de llamadas [C46].
 */
export interface CallOutboundResult {
  v: number;
  callId: string;
  outcome: 'answered' | 'busy' | 'digit' | 'no-answer' | 'no-digit' | 'hangup' | 'exhausted';
  answered?: boolean;
  digit?: string | null;
  to?: string | null;
  round?: number | null;
  maxRounds?: number | null;
  lastAttempt?: boolean;
}

export const OUTBOUND_CALL_ID_PREFIX = 'out-';
