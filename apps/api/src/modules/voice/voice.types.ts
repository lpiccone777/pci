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
  /** `null` en las salientes de pci [C63]. */
  extension: string | null;
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
  /** `no_input` [C64]: venció el `noInputMs` de la respuesta anterior, sin texto. */
  kind: 'start' | 'user' | 'continue' | 'no_input';
  text?: string | null;
  /** Tecla marcada en el teléfono [C57]: "0"–"9", "*" o "#". Puede venir sola o con `text`. */
  dtmf?: string | null;
  call?: VoiceCallInfo;
  previous?: VoiceHeard | null;
  supersedes?: string | null;
  /** El voicebot acepta avisos de progreso de este turno [C65]: sin esto, pci no los manda. */
  progress?: boolean;
}

export interface VoiceTurnReply {
  v: 1;
  turnId: string;
  actions: VoiceAction[];
  awaitInput: boolean;
  /** Solo con `awaitInput` [C64]: sin entrada en este tiempo, el voicebot manda `no_input`. */
  noInputMs?: number;
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
