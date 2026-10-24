/**
 * Canal de un flujo (contrato de integración C52): `text` = *Flujos IVR* (WhatsApp/SMS) y
 * `voice` = *Flujos de voz* (llamadas del voicebot). Las dos secciones usan los mismos
 * componentes (`components/flows/`) contra su propia API y su propio permiso RBAC [DA6].
 */
export type FlowChannel = 'text' | 'voice';

export interface FlowChannelConfig {
  channel: FlowChannel;
  /** Base de la API: `/flows` o `/voice-flows`. */
  api: string;
  /** Ruta del listado en el backoffice (el editor cuelga de `${base}/edit/`). */
  base: string;
  /** Recurso RBAC (tiene que coincidir con `permissions.catalog.ts` del backend). */
  resource: string;
  title: string;
}

export const FLOW_CHANNELS: Record<FlowChannel, FlowChannelConfig> = {
  text: { channel: 'text', api: '/flows', base: '/dashboard/flows', resource: 'flows', title: 'Flujos IVR' },
  voice: {
    channel: 'voice',
    api: '/voice-flows',
    base: '/dashboard/voice-flows',
    resource: 'voice_flows',
    title: 'Flujos de voz',
  },
};

/** Nodos que no existen por voz: la paleta del editor de voz no los ofrece (el backend los rechaza). */
export const VOICE_UNSUPPORTED_NODES: ReadonlySet<string> = new Set([
  'notification',
  'ticket_query',
  'device_validation',
  'delay',
]);
