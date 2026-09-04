/**
 * Catálogo de frecuencias de repetición para `ScheduleCalendarEntry`. Mismo criterio que
 * `schedule-entry-types.catalog.ts`: lista cerrada en código, no un enum de Prisma. Son 4
 * valores fijos — no amerita un endpoint dedicado (mismo caso que `FLOW_CONTEXT_OPTIONS`,
 * duplicado tal cual en el frontend).
 */

export interface RecurrenceFrequencyDefinition {
  freq: string;
  label: string;
}

export const SCHEDULE_RECURRENCE_FREQUENCIES: RecurrenceFrequencyDefinition[] = [
  { freq: 'daily', label: 'Diariamente' },
  { freq: 'weekly', label: 'Semanalmente' },
  { freq: 'monthly', label: 'Mensualmente' },
  { freq: 'yearly', label: 'Anualmente' },
];

export const SCHEDULE_RECURRENCE_FREQUENCY_VALUES: string[] = SCHEDULE_RECURRENCE_FREQUENCIES.map(
  (f) => f.freq,
);

const BY_FREQ = new Set(SCHEDULE_RECURRENCE_FREQUENCY_VALUES);

export function isValidRecurrenceFrequency(freq: string): boolean {
  return BY_FREQ.has(freq);
}
