import type { VoiceAction } from '../conversations/conversations.service';

/**
 * Mensajes de voz entre el voicebot y pci (contrato de integración §5, repo voicebot:
 * `docs/integracion-pci/contrato.md`). Todo viaja dentro de un `BrokerMessage` de pci, con
 * `v` dentro de `data`.
 */

/** Cola de eventos de llamada (voicebot → pci) [§5.2]. */
export const VOICE_EVENTS_QUEUE = 'voice.events';
/** Cola del RPC de turnos (voicebot → pci) [§5.3]. La respuesta va al `replyTo` del voicebot. */
export const VOICE_TURN_QUEUE = 'voice.turn';
export const VOICE_TURN_REPLY_PATTERN = 'voice.turn.reply';

export interface VoiceCallInfo {
  extension: string;
  calledNumber?: string | null;
  callerNumber?: string | null;
  direction?: 'inbound' | 'outbound';
}

/** Lo que el usuario efectivamente oyó de una respuesta (`previous`, `lastSpoken`). */
export interface VoiceHeard {
  turnId: string;
  heardText: string;
  interrupted?: boolean;
}

export interface VoiceTurnRequest {
  v: number;
  callId: string;
  turnId: string;
  kind: 'start' | 'user' | 'continue';
  text?: string | null;
  call?: VoiceCallInfo;
  previous?: VoiceHeard | null;
  supersedes?: string | null;
}

export interface VoiceTurnReply {
  v: 1;
  turnId: string;
  actions: VoiceAction[];
  awaitInput: boolean;
  committed: boolean;
  superseded: boolean;
  error: string | null;
}

export interface CallStartedEvent extends VoiceCallInfo {
  v: number;
  callId: string;
  startedAt?: string;
}

export interface CallEndedEvent {
  v: number;
  callId: string;
  reason?: 'hangup' | 'bot_hangup' | 'transfer' | 'error';
  endedAt?: string;
  lastSpoken?: VoiceHeard | null;
}

/**
 * Códigos de `error` de la respuesta [C7, C28]. Ante cualquiera, el voicebot dice el fallback
 * (o, en el `start`, `VOICEBOT_PCI_DOWN_TEXT` y corta [C47]).
 */
export type VoiceTurnErrorCode =
  | 'invalid_request'
  | 'unknown_call'
  | 'unknown_extension'
  | 'tenant_unavailable'
  | 'busy'
  | 'internal';

export class VoiceTurnError extends Error {
  constructor(
    readonly code: VoiceTurnErrorCode,
    message: string,
  ) {
    super(message);
  }
}
