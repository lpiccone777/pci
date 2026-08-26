/**
 * Catálogo de tipos de entrada de calendario (feriado / guardia).
 *
 * Mismo criterio que `context-source-types.catalog.ts` para `ContextSource.type`: lista
 * cerrada en código, no un enum de Prisma, para poder sumar tipos nuevos sin migración de
 * schema. Única fuente de verdad de qué `type` son válidos — la comparten
 * `ScheduleCalendarEntry.type` y `FlowAlternative.type` (ver flow.service.ts).
 */

export interface ScheduleEntryTypeDefinition {
  type: string;
  label: string;
}

export const SCHEDULE_ENTRY_TYPES: ScheduleEntryTypeDefinition[] = [
  { type: 'feriado', label: 'Feriado' },
  { type: 'guardia', label: 'Guardia' },
];

export const SCHEDULE_ENTRY_TYPE_VALUES: string[] = SCHEDULE_ENTRY_TYPES.map((t) => t.type);

const BY_TYPE = new Map(SCHEDULE_ENTRY_TYPES.map((t) => [t.type, t]));

export function isValidScheduleEntryType(type: string): boolean {
  return BY_TYPE.has(type);
}
