/**
 * Canal de un flujo [D10, contrato de integración C47/C52]: `text` (WhatsApp/SMS, "Flujos IVR")
 * o `voice` (llamadas del voicebot, "Flujos de voz"). Cada canal tiene su permiso RBAC [DA6] y su
 * API (`/flows` y `/voice-flows`): una no ve ni toca los flujos de la otra.
 */
export type FlowChannel = 'text' | 'voice';

/** Recurso RBAC de cada canal (tiene que coincidir con `permissions.catalog.ts`). */
export const FLOW_RESOURCE: Record<FlowChannel, string> = {
  text: 'flows',
  voice: 'voice_flows',
};

/**
 * Nodos que no existen por voz: el editor de voz no los ofrece y el backend rechaza guardarlos.
 * Si un flujo de voz viejo llega a uno, el motor lo saltea con un log (ver `ConversationsService`).
 */
/** Nodos que solo existen por voz: un flujo de texto no los admite. */
export const TEXT_UNSUPPORTED_NODES: ReadonlySet<string> = new Set(['voice_identify', 'transfer_extension']);

export const VOICE_UNSUPPORTED_NODES: ReadonlySet<string> = new Set([
  'notification',
  'ticket_query',
  'device_validation',
  'delay',
]);
