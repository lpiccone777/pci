/**
 * Fuente de datos que respalda las respuestas de un flujo — a qué "fuente de
 * verdad" apunta cuando resuelve una consulta. Lista cerrada a propósito: sirve
 * para filtrar/seleccionar flujos por dominio más adelante, no es texto libre.
 *
 * El frontend (apps/web/src/app/dashboard/flows/[id]/page.tsx) mantiene esta
 * misma lista para el dropdown — no hay un endpoint dedicado para esto porque son
 * 4 valores fijos, igual que `nodeTypeList` en el editor no se sirve desde acá.
 */
export const FLOW_CONTEXT_OPTIONS = [
  { value: 'none', label: 'Ninguna / genérico' },
  { value: 'invgate', label: 'Invgate (tickets)' },
  { value: 'internal_kb', label: 'Base de conocimiento interna' },
  { value: 'other', label: 'Otro' },
] as const;

export type FlowContext = (typeof FLOW_CONTEXT_OPTIONS)[number]['value'];

export const FLOW_CONTEXT_VALUES = FLOW_CONTEXT_OPTIONS.map((o) => o.value);
