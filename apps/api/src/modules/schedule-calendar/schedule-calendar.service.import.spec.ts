import { AR_HOLIDAYS_SOURCE, ScheduleCalendarService } from './schedule-calendar.service';

describe('ScheduleCalendarService — import de feriados de Argentina', () => {
  const deleteMany = jest.fn();
  const createMany = jest.fn();
  const prisma = { scheduleCalendarEntry: { deleteMany, createMany } } as any;
  const service = new ScheduleCalendarService(prisma);

  const TENANT = 'tenant-1';
  const originalFetch = global.fetch;

  beforeEach(() => {
    deleteMany.mockReset().mockResolvedValue({ count: 0 });
    createMany.mockReset().mockResolvedValue({ count: 0 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchOk(body: unknown) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    }) as any;
  }

  it('rechaza un año inválido sin llamar a fetch', async () => {
    global.fetch = jest.fn() as any;
    await expect(service.importArgentinaHolidays(TENANT, 1800)).rejects.toThrow('Año inválido');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('importa y mapea cada feriado a una entrada allDay de tipo feriado', async () => {
    mockFetchOk([
      { fecha: '2024-01-01', tipo: 'inamovible', nombre: 'Año nuevo' },
      { fecha: '2024-05-01', tipo: 'inamovible', nombre: 'Día del Trabajador' },
    ]);

    const result = await service.importArgentinaHolidays(TENANT, 2024);

    expect(result).toEqual({ imported: 2, year: 2024 });
    expect(createMany).toHaveBeenCalledTimes(1);
    const data = createMany.mock.calls[0][0].data;
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      tenantId: TENANT,
      type: 'feriado',
      title: 'Año nuevo',
      roleId: null,
      allDay: true,
      recurrenceFreq: null,
      source: AR_HOLIDAYS_SOURCE,
    });
    // Ancladas en -03:00 (hora argentina), no en UTC/"Z" — si no, medianoche local cae 3hs
    // antes en UTC y el feriado se ve partido en dos días.
    expect(data[0].startAt.toISOString()).toBe('2024-01-01T03:00:00.000Z');
    expect(data[0].endAt.toISOString()).toBe('2024-01-02T02:59:59.999Z');
  });

  it('reimportar el mismo año borra el import anterior antes de crear el nuevo', async () => {
    mockFetchOk([{ fecha: '2024-01-01', tipo: 'inamovible', nombre: 'Año nuevo' }]);
    await service.importArgentinaHolidays(TENANT, 2024);

    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, source: AR_HOLIDAYS_SOURCE }),
      }),
    );
    const deleteCallOrder = deleteMany.mock.invocationCallOrder[0];
    const createCallOrder = createMany.mock.invocationCallOrder[0];
    expect(deleteCallOrder).toBeLessThan(createCallOrder);
  });

  it('rechaza si la API externa responde con un status de error', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;
    await expect(service.importArgentinaHolidays(TENANT, 2024)).rejects.toThrow(
      /No se pudo obtener el listado de feriados/,
    );
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rechaza si la API externa no responde (falla de red)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as any;
    await expect(service.importArgentinaHolidays(TENANT, 2024)).rejects.toThrow(
      /No se pudo obtener el listado de feriados/,
    );
  });

  it('rechaza si la API externa devuelve una lista vacía', async () => {
    mockFetchOk([]);
    await expect(service.importArgentinaHolidays(TENANT, 2024)).rejects.toThrow(
      /No hay feriados publicados/,
    );
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('ScheduleCalendarService.removeArgentinaHolidaysImport', () => {
  const deleteMany = jest.fn();
  const prisma = { scheduleCalendarEntry: { deleteMany } } as any;
  const service = new ScheduleCalendarService(prisma);

  beforeEach(() => {
    deleteMany.mockReset().mockResolvedValue({ count: 3 });
  });

  it('borra solo las entradas importadas (source) de ese año, sin tocar las manuales', async () => {
    const result = await service.removeArgentinaHolidaysImport('tenant-1', 2024);

    expect(result).toEqual({ deleted: 3, year: 2024 });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        source: AR_HOLIDAYS_SOURCE,
        startAt: {
          gte: new Date('2024-01-01T00:00:00.000Z'),
          lt: new Date('2025-01-01T00:00:00.000Z'),
        },
      },
    });
  });
});
