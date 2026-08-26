import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateScheduleCalendarEntryDto,
  UpdateScheduleCalendarEntryDto,
} from './dto/schedule-calendar-entry.dto';
import { isValidRecurrenceFrequency } from './schedule-recurrence.catalog';
import { occursOn } from './schedule-recurrence.util';

/** `source` de una entrada cargada a mano desde el modal (default de schema.prisma). */
const MANUAL_SOURCE = 'manual';
/** `source` de una entrada importada de la API de feriados argentinos — ver `importArgentinaHolidays`. */
export const AR_HOLIDAYS_SOURCE = 'ar_holidays_import';

const AR_HOLIDAYS_API_URL = 'https://api.argentinadatos.com/v1/feriados';
const AR_HOLIDAYS_TIMEOUT_MS = 15_000;

interface ArgentinaHolidayApiEntry {
  fecha: string; // 'YYYY-MM-DD'
  tipo: string; // 'inamovible' | 'trasladable' | 'puente' | ...
  nombre: string;
}

/**
 * Calendario de feriados/guardias por rol. Cada entrada es un rango `startAt`-`endAt`
 * (`roleId` null = aplica a todos los roles del tenant), opcionalmente repetido
 * (`recurrenceFreq`/`recurrenceUntil` — ver schedule-recurrence.util.ts), que `resolveStatus`
 * consulta para decidir si, en un instante dado, un rol está en feriado, en guardia, o en
 * ninguno de los dos — insumo de `FlowService.findActiveFlowForTenant` para elegir el flow
 * alternativo.
 *
 * Por tenant (como Area/ContextSource): el tenant sale siempre de `@CurrentTenant()`, nunca
 * del body.
 */
@Injectable()
export class ScheduleCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    tenantId: string,
    filters?: { roleId?: string; type?: string; from?: Date; to?: Date },
  ) {
    return this.prisma.scheduleCalendarEntry.findMany({
      where: {
        tenantId,
        ...(filters?.roleId ? { roleId: filters.roleId } : {}),
        ...(filters?.type ? { type: filters.type } : {}),
        ...(filters?.from ? { endAt: { gte: filters.from } } : {}),
        ...(filters?.to ? { startAt: { lte: filters.to } } : {}),
      },
      orderBy: { startAt: 'asc' },
    });
  }

  async findOne(tenantId: string, id: string) {
    return this.getOwned(tenantId, id);
  }

  async create(tenantId: string, dto: CreateScheduleCalendarEntryDto) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);
    this.assertRange(startAt, endAt);
    const recurrenceFreq = dto.recurrenceFreq ?? null;
    const recurrenceUntil = this.resolveRecurrenceUntil(recurrenceFreq, dto.recurrenceUntil ?? null);
    this.assertRecurrence(startAt, recurrenceFreq, recurrenceUntil);
    if (dto.roleId) await this.assertRoleBelongsToTenant(tenantId, dto.roleId);

    return this.prisma.scheduleCalendarEntry.create({
      data: {
        tenantId,
        type: dto.type,
        title: dto.title.trim(),
        roleId: dto.roleId ?? null,
        startAt,
        endAt,
        allDay: dto.allDay ?? true,
        recurrenceFreq,
        recurrenceUntil,
        source: MANUAL_SOURCE,
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateScheduleCalendarEntryDto) {
    const existing = await this.getOwned(tenantId, id);

    const startAt = dto.startAt ? new Date(dto.startAt) : existing.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : existing.endAt;
    this.assertRange(startAt, endAt);
    if (dto.roleId) await this.assertRoleBelongsToTenant(tenantId, dto.roleId);

    // Merge explícito (no un simple spread condicional): si `recurrenceFreq` termina en
    // null (ausente, o el caller lo desactivó), `recurrenceUntil` se fuerza a null con él —
    // no tiene sentido dejar un "hasta" huérfano sin repetición.
    const recurrenceFreq = dto.recurrenceFreq !== undefined ? dto.recurrenceFreq : existing.recurrenceFreq;
    const recurrenceUntilInput =
      dto.recurrenceUntil !== undefined
        ? dto.recurrenceUntil
        : (existing.recurrenceUntil?.toISOString() ?? null);
    const recurrenceUntil = this.resolveRecurrenceUntil(recurrenceFreq, recurrenceUntilInput);
    this.assertRecurrence(startAt, recurrenceFreq, recurrenceUntil);

    return this.prisma.scheduleCalendarEntry.update({
      where: { id },
      data: {
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.roleId !== undefined ? { roleId: dto.roleId } : {}),
        ...(dto.startAt !== undefined ? { startAt } : {}),
        ...(dto.endAt !== undefined ? { endAt } : {}),
        ...(dto.allDay !== undefined ? { allDay: dto.allDay } : {}),
        recurrenceFreq,
        recurrenceUntil,
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.getOwned(tenantId, id);
    await this.prisma.scheduleCalendarEntry.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * Resuelve el estado temporal para (tenant, rol, instante): `'feriado'` | `'guardia'` |
   * `null` si ninguno matchea. Si ambos matchean el mismo instante, feriado gana (una
   * fecha feriada es un estado más absoluto que una guardia estándar).
   *
   * `roleId` null (usuario desconocido, o sin rol resuelto) solo matchea entradas con
   * `roleId: null` (las que aplican a todos los roles del tenant).
   *
   * A diferencia de la versión sin repetición, acá NO se puede filtrar por rango de fecha
   * en el WHERE — una entrada semanal/mensual/anual puede matchear `atDate` aunque su
   * `startAt`/`endAt` original caiga lejísimos de ese instante. Se trae todo lo que aplica
   * a (tenant, rol) y se filtra en memoria con `occursOn`. El volumen esperado de esta tabla
   * es bajo (entradas de calendario administradas a mano, no telemetría), así que el costo
   * extra es aceptable frente a la alternativa de reimplementar la aritmética de
   * repetición en SQL.
   */
  async resolveStatus(
    tenantId: string,
    roleId: string | null,
    atDate: Date,
  ): Promise<'feriado' | 'guardia' | null> {
    const candidates = await this.prisma.scheduleCalendarEntry.findMany({
      where: {
        tenantId,
        OR: [{ roleId }, { roleId: null }],
      },
      select: { type: true, startAt: true, endAt: true, recurrenceFreq: true, recurrenceUntil: true },
    });
    const matches = candidates.filter((c) => occursOn(c, atDate));
    if (matches.some((m) => m.type === 'feriado')) return 'feriado';
    if (matches.some((m) => m.type === 'guardia')) return 'guardia';
    return null;
  }

  /**
   * Importa los feriados nacionales de `year` desde la API pública
   * https://api.argentinadatos.com/v1/feriados/{year}/ (sin autenticación, sin broker de por
   * medio — mismo criterio que `InvgateService`: I/O externo administrativo, no un canal ni
   * una fuente de verdad consultada en vivo durante una conversación). Cada feriado se crea
   * `allDay: true`, `roleId: null` (aplica a todos los roles — se puede reasignar a mano
   * después) y `source: AR_HOLIDAYS_SOURCE`, que es lo que permite deshacer el import entero
   * con `removeArgentinaHolidaysImport` sin tocar entradas cargadas a mano.
   *
   * Reimportar el mismo año reemplaza limpio: borra el import anterior de ese año antes de
   * crear el nuevo, así un segundo intento no duplica feriados.
   */
  async importArgentinaHolidays(tenantId: string, year: number) {
    this.assertValidYear(year);

    let holidays: ArgentinaHolidayApiEntry[];
    try {
      const res = await fetch(`${AR_HOLIDAYS_API_URL}/${year}/`, {
        signal: AbortSignal.timeout(AR_HOLIDAYS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      holidays = await res.json();
    } catch (err) {
      throw new BadRequestException(
        `No se pudo obtener el listado de feriados de ${year}: ${err instanceof Error ? err.message : 'error desconocido'}`,
      );
    }
    if (!Array.isArray(holidays) || holidays.length === 0) {
      throw new BadRequestException(`No hay feriados publicados para ${year}`);
    }

    await this.removeArgentinaHolidaysImport(tenantId, year);

    const data = holidays.map((h) => ({
      tenantId,
      type: 'feriado',
      title: h.nombre,
      roleId: null,
      // La API de feriados da la fecha "civil" argentina (sin hora): anclar con offset
      // -03:00 (no "Z"/UTC) para que el día completo en el calendario sea el mismo día que
      // publica la API. Con "Z", la medianoche real cae 3hs antes en hora local y el evento
      // se veía partido en dos días.
      startAt: new Date(`${h.fecha}T00:00:00.000-03:00`),
      endAt: new Date(`${h.fecha}T23:59:59.999-03:00`),
      allDay: true,
      recurrenceFreq: null,
      recurrenceUntil: null,
      source: AR_HOLIDAYS_SOURCE,
    }));
    await this.prisma.scheduleCalendarEntry.createMany({ data });
    return { imported: data.length, year };
  }

  /** Borra en bloque el import de `year` (source = AR_HOLIDAYS_SOURCE), sin tocar entradas manuales. */
  async removeArgentinaHolidaysImport(tenantId: string, year: number) {
    this.assertValidYear(year);
    const result = await this.prisma.scheduleCalendarEntry.deleteMany({
      where: {
        tenantId,
        source: AR_HOLIDAYS_SOURCE,
        startAt: {
          gte: new Date(`${year}-01-01T00:00:00.000Z`),
          lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
        },
      },
    });
    return { deleted: result.count, year };
  }

  // --- helpers ---

  private assertValidYear(year: number) {
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new BadRequestException('Año inválido');
    }
  }

  private async getOwned(tenantId: string, id: string) {
    const entry = await this.prisma.scheduleCalendarEntry.findFirst({ where: { id, tenantId } });
    if (!entry) throw new NotFoundException('La entrada de calendario no existe en este tenant');
    return entry;
  }

  private assertRange(startAt: Date, endAt: Date) {
    if (endAt <= startAt) {
      throw new BadRequestException('La fecha de fin debe ser posterior a la de inicio');
    }
  }

  /** `recurrenceUntil` sin `recurrenceFreq` no tiene sentido — se descarta en silencio, no se rechaza. */
  private resolveRecurrenceUntil(recurrenceFreq: string | null, recurrenceUntil: string | null): Date | null {
    if (!recurrenceFreq || !recurrenceUntil) return null;
    return new Date(recurrenceUntil);
  }

  private assertRecurrence(startAt: Date, recurrenceFreq: string | null, recurrenceUntil: Date | null) {
    if (recurrenceFreq && !isValidRecurrenceFrequency(recurrenceFreq)) {
      throw new BadRequestException(`Frecuencia de repetición desconocida: "${recurrenceFreq}"`);
    }
    if (recurrenceUntil && recurrenceUntil < startAt) {
      throw new BadRequestException('La fecha "hasta" debe ser posterior al inicio');
    }
  }

  /** Mismo criterio que `FlowService.applyTenantAssignment`: un rol de otro tenant no puede colarse acá. */
  private async assertRoleBelongsToTenant(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId }, select: { tenantId: true } });
    if (!role || role.tenantId !== tenantId) {
      throw new BadRequestException(`El rol ${roleId} no existe o no pertenece a este tenant`);
    }
  }
}
