import { ScheduleCalendarService } from './schedule-calendar.service';

describe('ScheduleCalendarService.resolveStatus', () => {
  const findMany = jest.fn();
  const prisma = { scheduleCalendarEntry: { findMany } } as any;
  const service = new ScheduleCalendarService(prisma);

  beforeEach(() => {
    findMany.mockReset();
  });

  const TENANT = 'tenant-1';
  const ROLE = 'role-1';
  const NOW = new Date('2026-01-01T12:00:00.000Z');

  // La lógica de "¿esta entrada matchea este instante?" (incluida la repetición) vive en
  // occursOn (ver schedule-recurrence.util.spec.ts) — acá se prueba solo cómo resolveStatus
  // arma la consulta y combina los resultados que occursOn ya filtró.
  function nonRecurringEntry(type: string, atDate = NOW) {
    return { type, startAt: atDate, endAt: atDate, recurrenceFreq: null, recurrenceUntil: null };
  }

  it('devuelve null sin entradas que matcheen', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBeNull();
  });

  it('devuelve "guardia" si solo matchea una entrada de guardia', async () => {
    findMany.mockResolvedValue([nonRecurringEntry('guardia')]);
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBe('guardia');
  });

  it('devuelve "feriado" si solo matchea una entrada de feriado', async () => {
    findMany.mockResolvedValue([nonRecurringEntry('feriado')]);
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBe('feriado');
  });

  it('feriado gana si ambos matchean el mismo instante', async () => {
    findMany.mockResolvedValue([nonRecurringEntry('guardia'), nonRecurringEntry('feriado')]);
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBe('feriado');
  });

  it('ignora candidatas que no matchean (occursOn las descarta)', async () => {
    findMany.mockResolvedValue([nonRecurringEntry('feriado', new Date('2020-01-01T00:00:00.000Z'))]);
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBeNull();
  });

  it('una entrada con roleId null matchea sin importar el rol consultado', async () => {
    findMany.mockResolvedValue([nonRecurringEntry('guardia')]);
    await service.resolveStatus(TENANT, null, NOW);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ roleId: null }, { roleId: null }],
        }),
      }),
    );
  });

  it('escopea siempre por tenantId, sin filtrar por fecha en el WHERE', async () => {
    // A diferencia de la versión sin repetición, el filtro de fecha ya no puede vivir en
    // SQL (una entrada mensual/anual puede matchear aunque su startAt/endAt original esté
    // lejos de `atDate`) — se trae todo lo de (tenant, rol) y se filtra con occursOn.
    findMany.mockResolvedValue([]);
    await service.resolveStatus(TENANT, ROLE, NOW);
    const call = findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(TENANT);
    expect(call.where.startAt).toBeUndefined();
    expect(call.where.endAt).toBeUndefined();
  });

  it('una guardia recurrente semanal matchea la semana siguiente', async () => {
    findMany.mockResolvedValue([
      { type: 'guardia', startAt: new Date('2025-12-25T12:00:00.000Z'), endAt: new Date('2025-12-25T12:00:00.000Z'), recurrenceFreq: 'weekly', recurrenceUntil: null },
    ]);
    // NOW (2026-01-01) es exactamente una semana después del ancla (2025-12-25), mismo día de semana.
    await expect(service.resolveStatus(TENANT, ROLE, NOW)).resolves.toBe('guardia');
  });
});
