/**
 * 1.25 Calendario de feriados/guardias (BE-CAL-*)
 *
 * Vía: endpoints REST reales (`/schedule-calendar/*`) con supertest sobre la base efímera, más
 * el `ScheduleCalendarService` real tomado del contenedor para los casos que ejercitan
 * `resolveStatus` (no está expuesto por HTTP: lo consume `FlowService.findActiveFlowForTenant`).
 *
 * Frontera mockeada: únicamente el `fetch` a la API pública de feriados (argentinadatos.com),
 * que es un tercero. El servicio, el controlador, los guards y la base se ejercitan de verdad.
 */
import {
  createTestApp,
  TestApp,
  tokenFor,
  withAuth,
  http,
  createTenant,
  createRole,
  createUser,
  installFetchMock,
  uniqueEmail,
  uniqueSlug,
} from './support';
import { ScheduleCalendarService } from '../src/modules/schedule-calendar/schedule-calendar.service';

const CAL_PERMS = [
  'schedule-calendar:read',
  'schedule-calendar:create',
  'schedule-calendar:update',
  'schedule-calendar:delete',
];

/** Entrada mínima válida; cada test pisa lo que necesita. */
function entryPayload(over: Record<string, unknown> = {}) {
  return {
    type: 'feriado',
    title: 'Entrada de prueba',
    startAt: '2026-07-09T00:00:00.000Z',
    endAt: '2026-07-09T23:59:59.000Z',
    allDay: true,
    ...over,
  };
}

describe('1.25 Calendario de feriados/guardias (BE-CAL-*)', () => {
  let t: TestApp;
  let service: ScheduleCalendarService;

  // Empresa A: la que opera. Empresa B: la ajena, para los cortes de aislamiento.
  let tenantA: { id: string };
  let tenantB: { id: string };
  let roleA: { id: string };
  let roleA2: { id: string };
  let roleB: { id: string };
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    t = await createTestApp();
    service = t.moduleRef.get(ScheduleCalendarService);

    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('cal-a') });
    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('cal-b') });
    roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Calendario A',
      permissions: CAL_PERMS,
    });
    roleA2 = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Guardia A' });
    roleB = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Calendario B',
      permissions: CAL_PERMS,
    });
    const userA = await createUser(t.prisma, {
      email: uniqueEmail('cal-a'),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    const userB = await createUser(t.prisma, {
      email: uniqueEmail('cal-b'),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    tokenA = tokenFor(t, userA);
    tokenB = tokenFor(t, userB);
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    // Cada test arma su propio calendario: limpiar para que los filtros y `resolveStatus`
    // no vean entradas de tests anteriores.
    await t.prisma.scheduleCalendarEntry.deleteMany({
      where: { tenantId: { in: [tenantA.id, tenantB.id] } },
    });
  });

  const post = (payload: Record<string, unknown>, token = tokenA, tenantId = tenantA.id) =>
    withAuth(http(t).post('/schedule-calendar'), token, tenantId).send(payload);

  // --- BE-CAL-01: ABM completo ---

  it('BE-CAL-01: POST crea la entrada scopeada al tenant activo', async () => {
    const res = await post(entryPayload({ title: 'Feriado patrio', roleId: roleA.id }));

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(tenantA.id);
    expect(res.body.title).toBe('Feriado patrio');
    expect(res.body.roleId).toBe(roleA.id);
    expect(res.body.source).toBe('manual');
  });

  it('BE-CAL-01: GET lista solo lo del tenant activo, ordenado por startAt ascendente', async () => {
    await post(
      entryPayload({
        title: 'Segunda',
        startAt: '2026-08-10T00:00:00.000Z',
        endAt: '2026-08-10T23:00:00.000Z',
      }),
    );
    await post(
      entryPayload({
        title: 'Primera',
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-01T23:00:00.000Z',
      }),
    );
    // Entrada de la empresa ajena: no debe aparecer.
    await post(entryPayload({ title: 'De la otra empresa' }), tokenB, tenantB.id);

    const res = await withAuth(http(t).get('/schedule-calendar'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    expect(res.body.map((e: any) => e.title)).toEqual(['Primera', 'Segunda']);
  });

  it('BE-CAL-01: GET filtra por roleId y por type', async () => {
    await post(entryPayload({ title: 'Feriado global' }));
    await post(
      entryPayload({ title: 'Guardia del rol', type: 'guardia', roleId: roleA.id, allDay: false }),
    );

    const porRol = await withAuth(
      http(t).get(`/schedule-calendar?roleId=${roleA.id}`),
      tokenA,
      tenantA.id,
    );
    const porTipo = await withAuth(http(t).get('/schedule-calendar?type=guardia'), tokenA, tenantA.id);

    expect(porRol.body.map((e: any) => e.title)).toEqual(['Guardia del rol']);
    expect(porTipo.body.map((e: any) => e.title)).toEqual(['Guardia del rol']);
  });

  it('BE-CAL-01: los filtros de fecha se cruzan — una entrada que abarca el rango sin empezar dentro también aparece', async () => {
    // Abarca todo julio; el filtro pide una ventana interior (10 al 12).
    await post(
      entryPayload({
        title: 'Abarca el rango',
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-31T23:59:00.000Z',
      }),
    );
    await post(
      entryPayload({
        title: 'Fuera del rango',
        startAt: '2026-09-01T00:00:00.000Z',
        endAt: '2026-09-02T00:00:00.000Z',
      }),
    );

    const res = await withAuth(
      http(t).get('/schedule-calendar?from=2026-07-10T00:00:00.000Z&to=2026-07-12T00:00:00.000Z'),
      tokenA,
      tenantA.id,
    );

    expect(res.body.map((e: any) => e.title)).toEqual(['Abarca el rango']);
  });

  it('BE-CAL-01: PATCH actualiza y DELETE borra', async () => {
    const creada = await post(entryPayload({ title: 'Original' }));

    const patch = await withAuth(
      http(t).patch(`/schedule-calendar/${creada.body.id}`),
      tokenA,
      tenantA.id,
    ).send({ title: 'Corregida' });
    expect(patch.status).toBe(200);
    expect(patch.body.title).toBe('Corregida');

    const del = await withAuth(
      http(t).delete(`/schedule-calendar/${creada.body.id}`),
      tokenA,
      tenantA.id,
    );
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });

    const despues = await withAuth(http(t).get('/schedule-calendar'), tokenA, tenantA.id);
    expect(despues.body).toEqual([]);
  });

  // --- BE-CAL-02: catálogos ---

  it('BE-CAL-02: type fuera del catálogo devuelve 400 con la lista de valores válidos', async () => {
    const res = await post(entryPayload({ type: 'vacaciones' }));

    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('feriado');
    expect(String(res.body.message)).toContain('guardia');
  });

  it('BE-CAL-02: recurrenceFreq fuera del catálogo devuelve 400 con la lista de frecuencias', async () => {
    const res = await post(entryPayload({ recurrenceFreq: 'quincenal' }));

    expect(res.status).toBe(400);
    const msg = String(res.body.message);
    expect(msg).toContain('daily');
    expect(msg).toContain('yearly');
  });

  it('BE-CAL-02: el catálogo de tipos se sirve por GET /schedule-calendar/types', async () => {
    const res = await withAuth(http(t).get('/schedule-calendar/types'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    expect(res.body.map((x: any) => x.type).sort()).toEqual(['feriado', 'guardia']);
  });

  // --- BE-CAL-03: rangos inválidos ---

  it('BE-CAL-03: endAt anterior o igual a startAt devuelve 400', async () => {
    const anterior = await post(
      entryPayload({ startAt: '2026-07-10T10:00:00.000Z', endAt: '2026-07-10T09:00:00.000Z' }),
    );
    const igual = await post(
      entryPayload({ startAt: '2026-07-10T10:00:00.000Z', endAt: '2026-07-10T10:00:00.000Z' }),
    );

    expect(anterior.status).toBe(400);
    expect(anterior.body.message).toContain('La fecha de fin debe ser posterior a la de inicio');
    expect(igual.status).toBe(400);
  });

  it('BE-CAL-03: recurrenceUntil anterior al inicio devuelve 400', async () => {
    const res = await post(
      entryPayload({ recurrenceFreq: 'weekly', recurrenceUntil: '2026-01-01T00:00:00.000Z' }),
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('debe ser posterior al inicio');
  });

  // --- BE-CAL-04: repetición sin frecuencia ---

  it('BE-CAL-04: recurrenceUntil sin recurrenceFreq se descarta en silencio (no se rechaza)', async () => {
    const res = await post(entryPayload({ recurrenceUntil: '2027-01-01T00:00:00.000Z' }));

    expect(res.status).toBe(201);
    expect(res.body.recurrenceFreq).toBeNull();
    expect(res.body.recurrenceUntil).toBeNull();
  });

  it('BE-CAL-04: apagar la repetición en un PATCH fuerza recurrenceUntil a null', async () => {
    const creada = await post(
      entryPayload({ recurrenceFreq: 'weekly', recurrenceUntil: '2027-01-01T00:00:00.000Z' }),
    );
    expect(creada.body.recurrenceUntil).not.toBeNull();

    const res = await withAuth(
      http(t).patch(`/schedule-calendar/${creada.body.id}`),
      tokenA,
      tenantA.id,
    ).send({ recurrenceFreq: null });

    expect(res.status).toBe(200);
    expect(res.body.recurrenceFreq).toBeNull();
    expect(res.body.recurrenceUntil).toBeNull();
  });

  it('BE-CAL-04: con frecuencia y sin "hasta" la repetición queda indefinida', async () => {
    const res = await post(entryPayload({ recurrenceFreq: 'monthly' }));

    expect(res.status).toBe(201);
    expect(res.body.recurrenceFreq).toBe('monthly');
    expect(res.body.recurrenceUntil).toBeNull();
  });

  // --- BE-CAL-05 / BE-CAL-06: aislamiento ---

  it('BE-CAL-05: roleId de otra empresa (o inexistente) devuelve 400', async () => {
    const ajeno = await post(entryPayload({ roleId: roleB.id }));
    const inexistente = await post(entryPayload({ roleId: 'rol-que-no-existe' }));

    expect(ajeno.status).toBe(400);
    expect(ajeno.body.message).toContain('no existe o no pertenece a este tenant');
    expect(inexistente.status).toBe(400);
  });

  it('BE-CAL-06: GET, PATCH y DELETE por id de una entrada ajena devuelven 404', async () => {
    const ajena = await post(entryPayload({ title: 'De B' }), tokenB, tenantB.id);
    const id = ajena.body.id;

    const get = await withAuth(http(t).get(`/schedule-calendar/${id}`), tokenA, tenantA.id);
    const patch = await withAuth(http(t).patch(`/schedule-calendar/${id}`), tokenA, tenantA.id).send({
      title: 'Pisada',
    });
    const del = await withAuth(http(t).delete(`/schedule-calendar/${id}`), tokenA, tenantA.id);

    for (const res of [get, patch, del]) {
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('La entrada de calendario no existe en este tenant');
    }
    // Y la entrada sigue viva en su empresa.
    const sigue = await t.prisma.scheduleCalendarEntry.findUnique({ where: { id } });
    expect(sigue?.title).toBe('De B');
  });

  // --- BE-CAL-07: resolveStatus ---

  describe('BE-CAL-07: resolveStatus(tenant, rol, instante)', () => {
    const instante = new Date('2026-07-09T12:00:00.000Z');
    const rango = {
      startAt: new Date('2026-07-09T00:00:00.000Z'),
      endAt: new Date('2026-07-09T23:59:00.000Z'),
    };

    const sembrar = (type: string, roleId: string | null) =>
      t.prisma.scheduleCalendarEntry.create({
        data: { tenantId: tenantA.id, type, title: type, roleId, allDay: true, ...rango },
      });

    it('BE-CAL-07: sin entradas que matcheen devuelve null', async () => {
      expect(await service.resolveStatus(tenantA.id, roleA.id, instante)).toBeNull();
    });

    it('BE-CAL-07: solo guardia devuelve "guardia"; al sumar un feriado, gana feriado', async () => {
      await sembrar('guardia', roleA.id);
      expect(await service.resolveStatus(tenantA.id, roleA.id, instante)).toBe('guardia');

      await sembrar('feriado', roleA.id);
      expect(await service.resolveStatus(tenantA.id, roleA.id, instante)).toBe('feriado');
    });

    it('BE-CAL-07: con feriado y guardia en el mismo instante gana feriado', async () => {
      await sembrar('feriado', null);
      await sembrar('guardia', null);

      expect(await service.resolveStatus(tenantA.id, roleA.id, instante)).toBe('feriado');
    });

    it('BE-CAL-07: una entrada con roleId null matchea cualquier rol; una de otro rol no matchea', async () => {
      await sembrar('feriado', null);
      expect(await service.resolveStatus(tenantA.id, roleA2.id, instante)).toBe('feriado');

      await t.prisma.scheduleCalendarEntry.deleteMany({ where: { tenantId: tenantA.id } });
      await sembrar('guardia', roleA2.id);
      expect(await service.resolveStatus(tenantA.id, roleA.id, instante)).toBeNull();
      expect(await service.resolveStatus(tenantA.id, roleA2.id, instante)).toBe('guardia');
    });

    it('BE-CAL-07: consultando con roleId null solo matchean las entradas de roleId null', async () => {
      await sembrar('feriado', roleA.id);
      expect(await service.resolveStatus(tenantA.id, null, instante)).toBeNull();

      await sembrar('guardia', null);
      expect(await service.resolveStatus(tenantA.id, null, instante)).toBe('guardia');
    });

    it('BE-CAL-07: el estado no cruza empresas', async () => {
      await sembrar('feriado', null);
      expect(await service.resolveStatus(tenantB.id, null, instante)).toBeNull();
    });
  });

  // --- BE-CAL-08: repetición ---

  describe('BE-CAL-08: repetición en las cuatro frecuencias', () => {
    /** Siembra una entrada repetida en la empresa A. */
    const sembrarRepetida = async (opts: {
      startAt: string;
      endAt: string;
      recurrenceFreq: string;
      recurrenceUntil?: string;
    }) => {
      await t.prisma.scheduleCalendarEntry.create({
        data: {
          tenantId: tenantA.id,
          type: 'guardia',
          title: 'Repetida',
          roleId: null,
          allDay: false,
          startAt: new Date(opts.startAt),
          endAt: new Date(opts.endAt),
          recurrenceFreq: opts.recurrenceFreq,
          recurrenceUntil: opts.recurrenceUntil ? new Date(opts.recurrenceUntil) : null,
        },
      });
    };
    const estadoEn = (iso: string) => service.resolveStatus(tenantA.id, null, new Date(iso));

    it('BE-CAL-08: semanal matchea el mismo día y horario de la semana siguiente, no otro día', async () => {
      // Jueves 09/07/2026, de 09 a 17.
      await sembrarRepetida({
        startAt: '2026-07-09T09:00:00.000Z',
        endAt: '2026-07-09T17:00:00.000Z',
        recurrenceFreq: 'weekly',
      });

      expect(await estadoEn('2026-07-16T12:00:00.000Z')).toBe('guardia'); // jueves siguiente
      expect(await estadoEn('2026-07-17T12:00:00.000Z')).toBeNull(); // viernes de esa semana
      expect(await estadoEn('2026-07-16T20:00:00.000Z')).toBeNull(); // jueves, fuera de horario
    });

    it('BE-CAL-08: diaria repite el mismo horario todos los días', async () => {
      await sembrarRepetida({
        startAt: '2026-07-09T09:00:00.000Z',
        endAt: '2026-07-09T11:00:00.000Z',
        recurrenceFreq: 'daily',
      });

      expect(await estadoEn('2026-07-12T10:00:00.000Z')).toBe('guardia');
      expect(await estadoEn('2026-07-12T15:00:00.000Z')).toBeNull();
    });

    it('BE-CAL-08: mensual y anual repiten la misma fecha del ciclo siguiente', async () => {
      await sembrarRepetida({
        startAt: '2026-07-09T09:00:00.000Z',
        endAt: '2026-07-09T17:00:00.000Z',
        recurrenceFreq: 'monthly',
      });
      expect(await estadoEn('2026-08-09T12:00:00.000Z')).toBe('guardia');
      expect(await estadoEn('2026-08-10T12:00:00.000Z')).toBeNull();

      await t.prisma.scheduleCalendarEntry.deleteMany({ where: { tenantId: tenantA.id } });
      await sembrarRepetida({
        startAt: '2026-07-09T09:00:00.000Z',
        endAt: '2026-07-09T17:00:00.000Z',
        recurrenceFreq: 'yearly',
      });
      expect(await estadoEn('2027-07-09T12:00:00.000Z')).toBe('guardia');
      expect(await estadoEn('2027-08-09T12:00:00.000Z')).toBeNull();
    });

    it('BE-CAL-08: un rango que cruza medianoche matchea la madrugada del día siguiente', async () => {
      // 20:00 a 08:00 del día siguiente, repetida a diario.
      await sembrarRepetida({
        startAt: '2026-07-09T20:00:00.000Z',
        endAt: '2026-07-10T08:00:00.000Z',
        recurrenceFreq: 'daily',
      });

      expect(await estadoEn('2026-07-13T02:00:00.000Z')).toBe('guardia');
      expect(await estadoEn('2026-07-13T12:00:00.000Z')).toBeNull();
    });

    it('BE-CAL-08: recurrenceUntil corta la serie aunque el ciclo siga cayendo', async () => {
      await sembrarRepetida({
        startAt: '2026-07-09T09:00:00.000Z',
        endAt: '2026-07-09T17:00:00.000Z',
        recurrenceFreq: 'weekly',
        recurrenceUntil: '2026-07-20T00:00:00.000Z',
      });

      expect(await estadoEn('2026-07-16T12:00:00.000Z')).toBe('guardia'); // dentro del "hasta"
      expect(await estadoEn('2026-07-23T12:00:00.000Z')).toBeNull(); // ciclo posterior al corte
    });
  });

  it('BE-CAL-09: la repetición mensual anclada un 31 desborda al mes siguiente (limitación asumida)', async () => {
    // Ancla 31/01/2027 (año no bisiesto): la ocurrencia "de febrero" cae el 03/03, porque la
    // aritmética usa Date.setMonth. Está documentado como borde conocido del MVP, no es un ❌.
    await t.prisma.scheduleCalendarEntry.create({
      data: {
        tenantId: tenantA.id,
        type: 'feriado',
        title: 'Ancla 31',
        roleId: null,
        allDay: false,
        startAt: new Date('2027-01-31T10:00:00.000Z'),
        endAt: new Date('2027-01-31T18:00:00.000Z'),
        recurrenceFreq: 'monthly',
      },
    });

    expect(await service.resolveStatus(tenantA.id, null, new Date('2027-03-03T12:00:00.000Z'))).toBe(
      'feriado',
    );
    // Y, como consecuencia del desborde, el 28/02 no queda cubierto.
    expect(
      await service.resolveStatus(tenantA.id, null, new Date('2027-02-28T12:00:00.000Z')),
    ).toBeNull();
  });

  // --- BE-CAL-10 a 13: import de feriados ---

  describe('BE-CAL-10 a 13: import de feriados argentinos', () => {
    let fetchMock: ReturnType<typeof installFetchMock> | null = null;

    const feriadosApi = [
      { fecha: '2026-05-01', tipo: 'inamovible', nombre: 'Día del Trabajador' },
      { fecha: '2026-05-25', tipo: 'inamovible', nombre: 'Revolución de Mayo' },
    ];

    afterEach(() => {
      fetchMock?.restore();
      fetchMock = null;
    });

    const importar = (year: number | string, token = tokenA, tenantId = tenantA.id) =>
      withAuth(http(t).post(`/schedule-calendar/import-ar-holidays/${year}`), token, tenantId);

    it('BE-CAL-10: importa el año y crea una entrada por feriado, anclada en -03:00', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));

      const res = await importar(2026);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ imported: 2, year: 2026 });
      expect(fetchMock.requests[0].url).toContain('argentinadatos.com');
      expect(fetchMock.requests[0].url).toContain('/2026/');

      const entradas = await t.prisma.scheduleCalendarEntry.findMany({
        where: { tenantId: tenantA.id },
        orderBy: { startAt: 'asc' },
      });
      expect(entradas).toHaveLength(2);
      expect(entradas[0].type).toBe('feriado');
      expect(entradas[0].title).toBe('Día del Trabajador');
      expect(entradas[0].allDay).toBe(true);
      expect(entradas[0].roleId).toBeNull();
      expect(entradas[0].source).toBe('ar_holidays_import');
      // Anclaje -03:00: la medianoche civil argentina del 01/05 es 03:00 UTC.
      expect(entradas[0].startAt.toISOString()).toBe('2026-05-01T03:00:00.000Z');
      expect(entradas[0].endAt.toISOString()).toBe('2026-05-02T02:59:59.999Z');
    });

    it('BE-CAL-11: reimportar el mismo año reemplaza limpio, sin duplicar', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));

      await importar(2026);
      const segunda = await importar(2026);

      expect(segunda.body).toEqual({ imported: 2, year: 2026 });
      const total = await t.prisma.scheduleCalendarEntry.count({ where: { tenantId: tenantA.id } });
      expect(total).toBe(2);
    });

    it('BE-CAL-11: el DELETE del import borra solo lo importado y deja intactas las entradas manuales', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));
      await importar(2026);
      await post(
        entryPayload({
          title: 'Cargada a mano',
          startAt: '2026-05-01T00:00:00.000Z',
          endAt: '2026-05-01T20:00:00.000Z',
        }),
      );

      const res = await withAuth(
        http(t).delete('/schedule-calendar/import-ar-holidays/2026'),
        tokenA,
        tenantA.id,
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: 2, year: 2026 });
      const quedan = await t.prisma.scheduleCalendarEntry.findMany({
        where: { tenantId: tenantA.id },
      });
      expect(quedan.map((e) => e.title)).toEqual(['Cargada a mano']);
    });

    it('BE-CAL-12: un status no-2xx de la API externa devuelve 400 y no borra lo ya importado', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));
      await importar(2026);
      fetchMock.restore();

      fetchMock = installFetchMock(() => ({ status: 503, body: 'Service Unavailable' }));
      const res = await importar(2026);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('No se pudo obtener el listado de feriados de 2026');
      expect(res.body.message).toContain('HTTP 503');
      // El borrado del import anterior corre DESPUÉS del fetch exitoso: lo viejo sigue vivo.
      const total = await t.prisma.scheduleCalendarEntry.count({ where: { tenantId: tenantA.id } });
      expect(total).toBe(2);
    });

    it('BE-CAL-12: un error de red devuelve 400 con el motivo y no borra nada', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));
      await importar(2026);
      fetchMock.restore();

      fetchMock = installFetchMock(() => {
        throw new Error('conexión rechazada');
      });
      const res = await importar(2026);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('conexión rechazada');
      const total = await t.prisma.scheduleCalendarEntry.count({ where: { tenantId: tenantA.id } });
      expect(total).toBe(2);
    });

    it('BE-CAL-12: una lista vacía devuelve 400 y no borra lo ya importado', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));
      await importar(2026);
      fetchMock.restore();

      fetchMock = installFetchMock(() => ({ status: 200, body: [] }));
      const res = await importar(2026);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('No hay feriados publicados para 2026');
      const total = await t.prisma.scheduleCalendarEntry.count({ where: { tenantId: tenantA.id } });
      expect(total).toBe(2);
    });

    it('BE-CAL-13: año fuera de rango o no numérico devuelve 400 sin llamar a la API externa', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));

      const cero = await importar(0);
      const futuro = await importar(3000);
      const texto = await importar('abc');

      expect(cero.status).toBe(400);
      expect(cero.body.message).toBe('Año inválido');
      expect(futuro.status).toBe(400);
      expect(texto.status).toBe(400); // ParseIntPipe
      expect(fetchMock.requests).toHaveLength(0);
    });

    it('BE-CAL-13: el mismo corte aplica al DELETE del import', async () => {
      fetchMock = installFetchMock(() => ({ status: 200, body: feriadosApi }));

      const res = await withAuth(
        http(t).delete('/schedule-calendar/import-ar-holidays/1800'),
        tokenA,
        tenantA.id,
      );

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Año inválido');
      expect(fetchMock.requests).toHaveLength(0);
    });
  });

  it('BE-CAL-14: con un calendario grande, resolveStatus sigue resolviendo bien y se mide su costo', async () => {
    // Volumen equivalente a varios años importados más guardias repetidas.
    const data: any[] = [];
    for (let year = 2020; year <= 2026; year++) {
      for (let i = 0; i < 60; i++) {
        const day = String((i % 28) + 1).padStart(2, '0');
        const month = String((i % 12) + 1).padStart(2, '0');
        data.push({
          tenantId: tenantA.id,
          type: 'guardia',
          title: `Guardia ${year}-${i}`,
          roleId: null,
          allDay: false,
          startAt: new Date(`${year}-${month}-${day}T09:00:00.000Z`),
          endAt: new Date(`${year}-${month}-${day}T17:00:00.000Z`),
          recurrenceFreq: i % 3 === 0 ? 'weekly' : null,
          recurrenceUntil: null,
        });
      }
    }
    await t.prisma.scheduleCalendarEntry.createMany({ data });
    // El feriado que sí debe ganar, en un instante que ninguna guardia cubre.
    await t.prisma.scheduleCalendarEntry.create({
      data: {
        tenantId: tenantA.id,
        type: 'feriado',
        title: 'El que importa',
        roleId: null,
        allDay: true,
        startAt: new Date('2026-12-25T00:00:00.000Z'),
        endAt: new Date('2026-12-25T23:59:00.000Z'),
      },
    });

    const inicio = Date.now();
    const estado = await service.resolveStatus(
      tenantA.id,
      null,
      new Date('2026-12-25T12:00:00.000Z'),
    );
    const ms = Date.now() - inicio;

    expect(estado).toBe('feriado');
    // Umbral holgado: lo que se vigila es que traer todas las entradas y filtrar en memoria
    // (no se puede filtrar por fecha en el WHERE) no degrade el arranque de cada conversación.
    expect(ms).toBeLessThan(2000);
    // eslint-disable-next-line no-console
    console.log(`[BE-CAL-14] resolveStatus sobre ${data.length + 1} entradas: ${ms} ms`);
  });
});
