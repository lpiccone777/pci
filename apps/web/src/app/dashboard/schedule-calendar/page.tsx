'use client';

import { useCallback, useMemo, useState } from 'react';
import { useEffect } from 'react';
import { Calendar, dateFnsLocalizer, SlotInfo, View } from 'react-big-calendar';
import {
  format,
  parse,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfDay,
  endOfDay,
  isSameDay,
  addDays,
  addWeeks,
  addMonths,
  addYears,
  getDay,
} from 'date-fns';
import { es } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/hooks/use-auth';

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { locale: es }),
  getDay,
  locales: { es },
});

interface RoleOption {
  id: string;
  name: string;
}

interface EntryData {
  id: string;
  type: string;
  title: string;
  roleId: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  /** `null` = no se repite. Ver RECURRENCE_LABEL. */
  recurrenceFreq: string | null;
  /** Con `recurrenceFreq` seteado, `null` = "hasta nuevo aviso" (indefinido). */
  recurrenceUntil: string | null;
  /** 'manual' | 'ar_holidays_import' — ver AR_HOLIDAYS_SOURCE en schedule-calendar.service.ts. */
  source: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  resource: EntryData;
}

const TYPE_LABEL: Record<string, string> = { feriado: 'Feriado', guardia: 'Guardia' };
// Relleno del evento = tipo. Violeta vs. verde azulado: hues bien separados (280° vs 165°)
// para distinguirse de un vistazo — nunca rojo ni blanco, a pedido explícito.
const TYPE_COLOR: Record<string, string> = { feriado: '#7c3aed', guardia: '#0d9488' };

// Contorno del evento = rol (además del filtro por rol). Paleta fija, sin rojo ni blanco,
// alejada a propósito de los dos colores de tipo de arriba para no confundir relleno con
// contorno. Un rol se asigna a un color por hash de su id — determinístico, sin persistir
// nada nuevo en el backend (Role no tiene campo de color).
const ROLE_COLOR_PALETTE = [
  '#0ea5e9', // sky
  '#f59e0b', // amber
  '#16a34a', // green
  '#db2777', // pink
  '#2563eb', // blue
  '#ca8a04', // yellow
  '#c026d3', // fuchsia
  '#475569', // slate
];
// Contorno de las entradas "todos los roles" (roleId null) — gris neutro, no confundible con
// ningún rol puntual.
const NO_ROLE_COLOR = '#94a3b8';

function hashToColor(input: string, palette: string[]): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

/** Copia del catálogo fijo del backend (schedule-recurrence.catalog.ts) — 4 valores, no amerita endpoint. */
const RECURRENCE_LABEL: Record<string, string> = {
  daily: 'Diariamente',
  weekly: 'Semanalmente',
  monthly: 'Mensualmente',
  yearly: 'Anualmente',
};

/** Copia de AR_HOLIDAYS_SOURCE en schedule-calendar.service.ts (backend). */
const AR_HOLIDAYS_SOURCE = 'ar_holidays_import';

/** Formato que espera `<input type="datetime-local">`: sin segundos ni zona horaria. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Formato que espera `<input type="date">`. */
function toLocalDateValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Rango visible del calendario según vista/fecha actual — acota la expansión de repeticiones. */
function getVisibleRange(date: Date, view: View): { start: Date; end: Date } {
  if (view === 'month') {
    return {
      start: startOfWeek(startOfMonth(date), { locale: es }),
      end: endOfWeek(endOfMonth(date), { locale: es }),
    };
  }
  if (view === 'week') {
    return { start: startOfWeek(date, { locale: es }), end: endOfWeek(date, { locale: es }) };
  }
  return { start: startOfDay(date), end: endOfDay(date) };
}

const RECURRENCE_STEP: Record<string, (d: Date, n: number) => Date> = {
  daily: addDays,
  weekly: addWeeks,
  monthly: addMonths,
  yearly: addYears,
};

// Guarda de seguridad: el rango visible ya acota naturalmente cuántas ocurrencias caben (a
// lo sumo ~31 diarias en una vista de mes), esto es solo por si algún día cambia el cálculo.
const MAX_OCCURRENCES_PER_ENTRY = 500;

/**
 * Expande una entrada (recurrente o no) a las ocurrencias que caen dentro de
 * [rangeStart, rangeEnd]. `startAt`/`endAt` son siempre la PRIMER ocurrencia; cada repetición
 * reusa esa misma duración, desplazada al ciclo que corresponda — mismo criterio que
 * `occursOn` en el backend (schedule-recurrence.util.ts), pero acá se listan todas las que
 * caen en el rango en vez de responder sí/no para un instante puntual.
 */
function expandOccurrences(entry: EntryData, rangeStart: Date, rangeEnd: Date): { start: Date; end: Date }[] {
  const start = new Date(entry.startAt);
  const end = new Date(entry.endAt);

  if (!entry.recurrenceFreq) {
    return start <= rangeEnd && end >= rangeStart ? [{ start, end }] : [];
  }

  const step = RECURRENCE_STEP[entry.recurrenceFreq];
  if (!step) return [];

  const durationMs = end.getTime() - start.getTime();
  const until = entry.recurrenceUntil ? new Date(entry.recurrenceUntil) : null;
  const occurrences: { start: Date; end: Date }[] = [];

  for (let n = 0; n < MAX_OCCURRENCES_PER_ENTRY; n++) {
    const occStart = step(start, n);
    if (occStart > rangeEnd) break;
    if (until && occStart > until) break;
    const occEnd = new Date(occStart.getTime() + durationMs);
    if (occEnd >= rangeStart) occurrences.push({ start: occStart, end: occEnd });
  }
  return occurrences;
}

/**
 * Divide un rango horario que cruza medianoche en tramos, cada uno dentro de un único día
 * calendario. Necesario porque la grilla horaria de semana/día de react-big-calendar no
 * puede dibujar un evento puntual (no `allDay`) que abarque más de un día — lo manda entero
 * al renglón de arriba ("todo el día"), sin importar que `allDay` sea `false`, porque cada
 * columna de la grilla es un único día y no hay forma de pintar una barra que cruce
 * columnas dentro de esa grilla. Partiendo en tramos de un día, cada uno cae en su columna
 * normal, ocupando el horario real (ej. una guardia 20:00→08:00 se ve como un tramo hasta
 * medianoche en un día y otro desde medianoche en el siguiente).
 *
 * Los eventos `allDay` (feriados) no pasan por acá — un feriado que cruza varios días debe
 * seguir viéndose como una única barra continua arriba, que es el comportamiento correcto
 * para ellos.
 */
function splitByDay(start: Date, end: Date): { start: Date; end: Date }[] {
  if (isSameDay(start, end)) return [{ start, end }];
  const segments: { start: Date; end: Date }[] = [];
  let segStart = start;
  while (segStart < end) {
    const dayEnd = endOfDay(segStart);
    const segEnd = dayEnd < end ? dayEnd : end;
    segments.push({ start: segStart, end: segEnd });
    segStart = addDays(startOfDay(segStart), 1);
  }
  return segments;
}

export default function ScheduleCalendarPage() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('schedule-calendar', 'create');
  const canUpdate = hasPermission('schedule-calendar', 'update');
  const canDelete = hasPermission('schedule-calendar', 'delete');

  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [entries, setEntries] = useState<EntryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('month');
  const [date, setDate] = useState(new Date());

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formType, setFormType] = useState('feriado');
  const [formTitle, setFormTitle] = useState('');
  const [formRoleId, setFormRoleId] = useState<string>('');
  const [formStart, setFormStart] = useState('');
  const [formEnd, setFormEnd] = useState('');
  const [formAllDay, setFormAllDay] = useState(true);
  const [formRecurrenceFreq, setFormRecurrenceFreq] = useState<string>('');
  const [formRecurrenceUntilMode, setFormRecurrenceUntilMode] = useState<'indefinite' | 'date'>(
    'indefinite',
  );
  const [formRecurrenceUntilDate, setFormRecurrenceUntilDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState('');

  // Import de feriados nacionales (API pública de argentinadatos.com), con la posibilidad
  // de deshacerlo en bloque — ver AR_HOLIDAYS_SOURCE.
  const [importYear, setImportYear] = useState(String(new Date().getFullYear()));
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState('');
  const [importError, setImportError] = useState('');

  const load = useCallback(async () => {
    try {
      const query = roleFilter ? `?roleId=${roleFilter}` : '';
      const data = await apiFetch(`/schedule-calendar${query}`);
      setEntries(data);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [roleFilter]);

  useEffect(() => {
    apiFetch('/roles')
      .then((data) => setRoles(data || []))
      .catch(() => setRoles([])); // sin permiso `roles:read`: el filtro por rol queda vacío
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const events: CalendarEvent[] = useMemo(() => {
    const { start: rangeStart, end: rangeEnd } = getVisibleRange(date, view);
    const out: CalendarEvent[] = [];
    for (const e of entries) {
      const occurrences = expandOccurrences(e, rangeStart, rangeEnd);
      // Una guardia con horario (allDay: false) que cruza medianoche se parte en tramos de
      // un día — ver splitByDay. Un feriado (allDay: true) que cruza varios días queda tal
      // cual, como una única barra continua arriba.
      const segments = e.allDay ? occurrences : occurrences.flatMap((occ) => splitByDay(occ.start, occ.end));
      segments.forEach((seg, idx) => {
        out.push({
          // Un mismo evento recurrente (o uno solo que cruza medianoche) puede aportar
          // varios tramos visibles a la vez — id único por tramo, pero `resource` siempre
          // apunta a la fila original: click en cualquiera edita la serie/entrada completa.
          id: segments.length > 1 ? `${e.id}__${idx}` : e.id,
          title: `${TYPE_LABEL[e.type] ?? e.type}: ${e.title}${e.recurrenceFreq ? ' 🔁' : ''}${
            e.source === AR_HOLIDAYS_SOURCE ? ' 🇦🇷' : ''
          }`,
          start: seg.start,
          end: seg.end,
          allDay: e.allDay,
          resource: e,
        });
      });
    }
    return out;
  }, [entries, date, view]);

  /** Color de contorno de un rol — `null` (todos los roles) usa NO_ROLE_COLOR. */
  const roleColor = useCallback(
    (roleId: string | null) => (roleId ? hashToColor(roleId, ROLE_COLOR_PALETTE) : NO_ROLE_COLOR),
    [],
  );

  function eventPropGetter(event: CalendarEvent) {
    return {
      style: {
        backgroundColor: TYPE_COLOR[event.resource.type] ?? '#6b7280',
        border: `2px solid ${roleColor(event.resource.roleId)}`,
      },
    };
  }

  function resetForm() {
    setEditingId(null);
    setFormType('feriado');
    setFormTitle('');
    setFormRoleId('');
    setFormAllDay(true);
    setFormRecurrenceFreq('');
    setFormRecurrenceUntilMode('indefinite');
    setFormRecurrenceUntilDate('');
    setModalError('');
  }

  function openCreateModal(slot: SlotInfo) {
    if (!canCreate) return;
    resetForm();
    setFormStart(toLocalInputValue(slot.start as Date));
    setFormEnd(toLocalInputValue(slot.end as Date));
    setModalOpen(true);
  }

  function openEditModal(event: CalendarEvent) {
    if (!canUpdate) return;
    const e = event.resource;
    setEditingId(e.id);
    setFormType(e.type);
    setFormTitle(e.title);
    setFormRoleId(e.roleId ?? '');
    setFormStart(toLocalInputValue(new Date(e.startAt)));
    setFormEnd(toLocalInputValue(new Date(e.endAt)));
    setFormAllDay(e.allDay);
    setFormRecurrenceFreq(e.recurrenceFreq ?? '');
    setFormRecurrenceUntilMode(e.recurrenceUntil ? 'date' : 'indefinite');
    setFormRecurrenceUntilDate(e.recurrenceUntil ? toLocalDateValue(new Date(e.recurrenceUntil)) : '');
    setModalError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    resetForm();
  }

  async function submitForm(ev: React.FormEvent) {
    ev.preventDefault();
    if (formRecurrenceFreq && formRecurrenceUntilMode === 'date' && !formRecurrenceUntilDate) {
      setModalError('Elegí hasta cuándo se repite, o marcá "Hasta nuevo aviso".');
      return;
    }
    setBusy(true);
    setModalError('');
    try {
      const payload = {
        type: formType,
        title: formTitle,
        roleId: formRoleId || null,
        startAt: new Date(formStart).toISOString(),
        endAt: new Date(formEnd).toISOString(),
        allDay: formAllDay,
        recurrenceFreq: formRecurrenceFreq || null,
        // "Hasta nuevo aviso" = null (indefinido). El fin del día elegido, para que esa
        // fecha completa quede incluida en la última repetición.
        recurrenceUntil:
          formRecurrenceFreq && formRecurrenceUntilMode === 'date' && formRecurrenceUntilDate
            ? new Date(`${formRecurrenceUntilDate}T23:59:59`).toISOString()
            : null,
      };
      if (editingId) {
        await apiFetch(`/schedule-calendar/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/schedule-calendar', { method: 'POST', body: JSON.stringify(payload) });
      }
      closeModal();
      await load();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const hasImportForYear = useMemo(() => {
    const year = Number(importYear);
    return entries.some(
      (e) => e.source === AR_HOLIDAYS_SOURCE && new Date(e.startAt).getFullYear() === year,
    );
  }, [entries, importYear]);

  async function importHolidays() {
    const year = Number(importYear);
    if (!Number.isInteger(year)) {
      setImportError('Ingresá un año válido.');
      return;
    }
    setImporting(true);
    setImportError('');
    setImportNotice('');
    try {
      const result = await apiFetch(`/schedule-calendar/import-ar-holidays/${year}`, {
        method: 'POST',
      });
      setImportNotice(`Se importaron ${result.imported} feriados de ${year}.`);
      await load();
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function undoImport() {
    const year = Number(importYear);
    if (!Number.isInteger(year)) {
      setImportError('Ingresá un año válido.');
      return;
    }
    if (!confirm(`¿Borrar los feriados importados de ${year}? No afecta entradas cargadas a mano.`)) {
      return;
    }
    setImporting(true);
    setImportError('');
    setImportNotice('');
    try {
      const result = await apiFetch(`/schedule-calendar/import-ar-holidays/${year}`, {
        method: 'DELETE',
      });
      setImportNotice(`Se borraron ${result.deleted} feriados importados de ${year}.`);
      await load();
    } catch (err: any) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  async function removeEntry() {
    if (!editingId) return;
    if (!confirm('¿Eliminar esta entrada de calendario?')) return;
    setBusy(true);
    setModalError('');
    try {
      await apiFetch(`/schedule-calendar/${editingId}`, { method: 'DELETE' });
      closeModal();
      await load();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="text-gray-500">Cargando...</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2 text-gray-800">Calendario de feriados/guardias</h1>
      <p className="text-sm text-gray-500 mb-4">
        Rangos de fecha/hora marcados como feriado o guardia, por rol. Un flujo con una
        variante configurada para ese estado (ver el selector Principal/Guardia/Feriado en el
        editor de flujos) la usa en vez del flujo Principal mientras dure el rango.
      </p>

      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <label className="text-sm text-gray-600">Rol:</label>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="border px-3 py-1.5 rounded text-sm"
        >
          <option value="">Todos los roles</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <span className="text-gray-300">|</span>
        <span className="text-xs text-gray-400">Relleno = tipo:</span>
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: TYPE_COLOR.feriado }} />
          Feriado
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: TYPE_COLOR.guardia }} />
          Guardia
        </span>
      </div>

      {/* Contorno = rol: mismo color que se dibuja como borde del evento en el calendario. */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className="text-xs text-gray-400">Contorno = rol:</span>
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <span
            className="w-2.5 h-2.5 rounded-full inline-block bg-gray-100"
            style={{ border: `2px solid ${NO_ROLE_COLOR}` }}
          />
          Todos los roles
        </span>
        {roles.map((r) => (
          <span key={r.id} className="flex items-center gap-1 text-xs text-gray-500">
            <span
              className="w-2.5 h-2.5 rounded-full inline-block bg-gray-100"
              style={{ border: `2px solid ${roleColor(r.id)}` }}
            />
            {r.name}
          </span>
        ))}
      </div>

      {/* Import de feriados nacionales (API pública de argentinadatos.com), con la
          posibilidad de deshacerlo en bloque sin tocar entradas cargadas a mano. */}
      {(canCreate || canDelete) && (
        <div className="flex items-center gap-2 mb-4 flex-wrap bg-gray-50 border rounded px-3 py-2">
          <span className="text-xs text-gray-500">Feriados nacionales (Argentina):</span>
          <input
            type="number"
            value={importYear}
            onChange={(e) => setImportYear(e.target.value)}
            className="border px-2 py-1 rounded text-sm w-24"
          />
          {canCreate && (
            <button
              type="button"
              onClick={importHolidays}
              disabled={importing}
              className="text-sm border border-gray-300 text-gray-700 px-3 py-1.5 rounded hover:bg-gray-100 disabled:opacity-50"
            >
              {importing ? 'Importando...' : 'Importar'}
            </button>
          )}
          {canDelete && hasImportForYear && (
            <button
              type="button"
              onClick={undoImport}
              disabled={importing}
              className="text-sm text-red-600 hover:text-red-800 px-2 disabled:opacity-50"
            >
              Deshacer import de {importYear}
            </button>
          )}
          {importNotice && <span className="text-xs text-green-600">{importNotice}</span>}
          {importError && <span className="text-xs text-red-500">{importError}</span>}
        </div>
      )}

      {error && <p className="text-red-500 mb-4">{error}</p>}
      {!canCreate && (
        <p className="text-gray-400 text-sm mb-4">
          No tenés permiso para crear entradas de calendario — vista de solo lectura.
        </p>
      )}

      <div className="bg-white rounded shadow p-4" style={{ height: 700 }}>
        <Calendar
          localizer={localizer}
          culture="es"
          events={events}
          startAccessor="start"
          endAccessor="end"
          view={view}
          onView={setView}
          date={date}
          onNavigate={setDate}
          views={['month', 'week', 'day']}
          selectable={canCreate}
          onSelectSlot={openCreateModal}
          onSelectEvent={openEditModal}
          eventPropGetter={eventPropGetter}
          // En mes, una serie diaria repite el mismo texto en cada celda y satura la
          // vista — ahí el color (relleno = tipo, contorno = rol) ya identifica el evento,
          // así que se oculta la etiqueta y el título completo pasa al tooltip nativo del
          // navegador (hover). En semana/día hay lugar de sobra, así que se muestra normal.
          // `tooltipAccessor` no se toca: por default lee `event.title`, que sigue teniendo
          // el texto completo siempre. El click sigue abriendo el modal de edición igual.
          titleAccessor={(event: CalendarEvent) => (view === 'month' ? '' : event.title)}
          messages={{
            month: 'Mes',
            week: 'Semana',
            day: 'Día',
            today: 'Hoy',
            previous: 'Anterior',
            next: 'Siguiente',
            noEventsInRange: 'Sin entradas en este rango.',
          }}
        />
      </div>

      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded shadow-lg w-full max-w-md p-5">
            <h2 className="font-semibold text-gray-700 mb-3">
              {editingId ? 'Editar entrada' : 'Nueva entrada de calendario'}
            </h2>
            <form onSubmit={submitForm} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tipo *</label>
                <select
                  value={formType}
                  onChange={(e) => setFormType(e.target.value)}
                  className="border px-3 py-2 rounded w-full"
                >
                  <option value="feriado">Feriado</option>
                  <option value="guardia">Guardia</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Rol</label>
                <select
                  value={formRoleId}
                  onChange={(e) => setFormRoleId(e.target.value)}
                  className="border px-3 py-2 rounded w-full"
                >
                  <option value="">Todos los roles</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Título *</label>
                <input
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="border px-3 py-2 rounded w-full"
                  placeholder="Feriado de fin de año"
                  maxLength={120}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Inicio *</label>
                  <input
                    type="datetime-local"
                    value={formStart}
                    onChange={(e) => setFormStart(e.target.value)}
                    className="border px-3 py-2 rounded w-full"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Fin *</label>
                  <input
                    type="datetime-local"
                    value={formEnd}
                    onChange={(e) => setFormEnd(e.target.value)}
                    className="border px-3 py-2 rounded w-full"
                    required
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-600">
                <input
                  type="checkbox"
                  checked={formAllDay}
                  onChange={(e) => setFormAllDay(e.target.checked)}
                />
                Todo el día
              </label>

              <div>
                <label className="block text-xs text-gray-500 mb-1">Repetir</label>
                <select
                  value={formRecurrenceFreq}
                  onChange={(e) => setFormRecurrenceFreq(e.target.value)}
                  className="border px-3 py-2 rounded w-full"
                >
                  <option value="">No se repite</option>
                  {Object.entries(RECURRENCE_LABEL).map(([freq, label]) => (
                    <option key={freq} value={freq}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              {formRecurrenceFreq && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Hasta</label>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 text-sm text-gray-600">
                      <input
                        type="radio"
                        name="recurrence-until-mode"
                        checked={formRecurrenceUntilMode === 'indefinite'}
                        onChange={() => setFormRecurrenceUntilMode('indefinite')}
                      />
                      Nuevo aviso
                    </label>
                    <label className="flex items-center gap-1.5 text-sm text-gray-600">
                      <input
                        type="radio"
                        name="recurrence-until-mode"
                        checked={formRecurrenceUntilMode === 'date'}
                        onChange={() => setFormRecurrenceUntilMode('date')}
                      />
                      Fecha:
                    </label>
                    <input
                      type="date"
                      value={formRecurrenceUntilDate}
                      onChange={(e) => {
                        setFormRecurrenceUntilDate(e.target.value);
                        if (e.target.value) setFormRecurrenceUntilMode('date');
                      }}
                      onFocus={() => setFormRecurrenceUntilMode('date')}
                      disabled={formRecurrenceUntilMode !== 'date'}
                      className="border px-2 py-1.5 rounded text-sm disabled:bg-gray-50 disabled:text-gray-400"
                    />
                  </div>
                </div>
              )}

              {modalError && <p className="text-red-500 text-sm">{modalError}</p>}

              <div className="flex justify-between items-center pt-2">
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy || !(editingId ? canUpdate : canCreate)}
                    className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
                  >
                    {busy ? 'Guardando...' : editingId ? 'Guardar cambios' : 'Crear'}
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="text-gray-600 px-4 py-2 rounded hover:bg-gray-100"
                  >
                    Cancelar
                  </button>
                </div>
                {editingId && canDelete && (
                  <button
                    type="button"
                    onClick={removeEntry}
                    disabled={busy}
                    className="text-red-600 hover:text-red-800 text-sm px-2"
                  >
                    Eliminar
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
