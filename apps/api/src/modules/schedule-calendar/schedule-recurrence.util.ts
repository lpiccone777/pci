/**
 * `startAt`/`endAt` de una `ScheduleCalendarEntry` son siempre la PRIMER ocurrencia — cada
 * repetición reusa esa misma duración (`endAt - startAt`), desplazada al ciclo (día/semana/
 * mes/año) que corresponda. `occursOn` decide si un instante puntual cae dentro de alguna
 * ocurrencia, sin necesidad de expandir la serie entera — es lo que usa
 * `ScheduleCalendarService.resolveStatus`, que se ejecuta en el camino caliente de cada
 * conversación.
 */

export interface RecurringEntry {
  startAt: Date;
  endAt: Date;
  recurrenceFreq: string | null;
  recurrenceUntil: Date | null;
}

/** `true` si `atDate` cae dentro de la entrada original o de alguna de sus repeticiones. */
export function occursOn(entry: RecurringEntry, atDate: Date): boolean {
  if (!entry.recurrenceFreq) {
    return atDate >= entry.startAt && atDate <= entry.endAt;
  }
  if (atDate < entry.startAt) return false;
  if (entry.recurrenceUntil && atDate > entry.recurrenceUntil) return false;

  const occurrenceStart = lastOccurrenceStart(entry.startAt, entry.recurrenceFreq, atDate);
  if (!occurrenceStart) return false;
  if (entry.recurrenceUntil && occurrenceStart > entry.recurrenceUntil) return false;

  const durationMs = entry.endAt.getTime() - entry.startAt.getTime();
  const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
  return atDate >= occurrenceStart && atDate <= occurrenceEnd;
}

/**
 * Arranque de la ocurrencia del ciclo al que pertenece `atDate` (la última que empezó antes
 * o en ese instante), o `null` si `atDate` es anterior a `anchor`. `daily`/`weekly` son
 * intervalos fijos en milisegundos; `monthly`/`yearly` usan aritmética de calendario (mismo
 * criterio que `Date.setMonth`/`setFullYear`: si el mes de destino tiene menos días, JS
 * corre el desborde al mes siguiente — limitación conocida, no crítica para el MVP).
 */
function lastOccurrenceStart(anchor: Date, freq: string, atDate: Date): Date | null {
  if (atDate < anchor) return null;

  switch (freq) {
    case 'daily': {
      const diffDays = Math.floor((atDate.getTime() - anchor.getTime()) / 86_400_000);
      return new Date(anchor.getTime() + diffDays * 86_400_000);
    }
    case 'weekly': {
      const diffWeeks = Math.floor((atDate.getTime() - anchor.getTime()) / (7 * 86_400_000));
      return new Date(anchor.getTime() + diffWeeks * 7 * 86_400_000);
    }
    case 'monthly': {
      let months =
        (atDate.getFullYear() - anchor.getFullYear()) * 12 + (atDate.getMonth() - anchor.getMonth());
      let candidate = addMonths(anchor, months);
      if (candidate > atDate) {
        months -= 1;
        candidate = addMonths(anchor, months);
      }
      return months < 0 ? null : candidate;
    }
    case 'yearly': {
      let years = atDate.getFullYear() - anchor.getFullYear();
      let candidate = addYears(anchor, years);
      if (candidate > atDate) {
        years -= 1;
        candidate = addYears(anchor, years);
      }
      return years < 0 ? null : candidate;
    }
    default:
      return null;
  }
}

function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + n);
  return d;
}

function addYears(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  d.setFullYear(d.getFullYear() + n);
  return d;
}
