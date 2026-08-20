/**
 * 1.22 Integración InvGate (`InvgateService` + catálogo) (BE-IG-*)
 *
 * Vía: `/conversations/simulate` (nodos `ticket_create`/`ticket_query`, motor de flujos real)
 * y `/invgate/catalog/*` (endpoints REST reales) con supertest, sobre la base efímera.
 *
 * Frontera mockeada: SOLO el HTTP de InvGate (`installFetchMock`, base `INVGATE_API_URL` +
 * `/api/v1`). El motor de flujos, `InvgateService`, `ConversationsService` y los guards
 * corren de verdad — nada de eso se mockea.
 *
 * `InvgateService` es un provider único (singleton) para TODA la app de test (`t`), así que
 * sus cachés en memoria (`creatorIdCache`, `priorityCache`, `typeCache`, `statusNameCache`,
 * `categoryChildrenCache`) persisten entre `it` de este archivo. Por eso:
 *  - El catálogo simulado (prioridades/tipos/estados/categorías) es ESTÁTICO durante todo el
 *    archivo: cachearlo una vez no desactualiza nada.
 *  - `INVGATE_API_USER` se fija UNA sola vez en `beforeAll` con un username que matchea el
 *    "usuario técnico" simulado, y nunca se lo toca en el resto de la suite — así
 *    `creatorIdCache` queda resuelto correctamente para todos los tests que dependen de él.
 *  - BE-IG-10 (que necesita romper esa resolución a propósito) NO usa una segunda
 *    `createTestApp()` (a diferencia de BE-AUTH-25): `ConversationsService` se suscribe a la
 *    cola `whatsapp.simulate.incoming` del vhost efímero del archivo (uno solo, no uno por
 *    app), así que una segunda app viva competiría por los mismos mensajes con `t` — ver el
 *    comentario del propio test. En cambio construye su PROPIA instancia de `InvgateService`
 *    a mano (mismo `AppConfigService` real, sin pasar por Nest DI), así no envenena el
 *    `creatorIdCache` que el resto del archivo necesita resuelto.
 *  - `baseUrl()`/`apiUser()`/`apiKey()` en cambio se leen frescos en cada llamada (no
 *    cacheados): `INVGATE_API_URL`/`INVGATE_API_KEY` sí se pueden pisar y restaurar por test.
 *
 * Los nodos `ticket_create`/`ticket_query` se ejercitan armando un `Flow` de un solo nodo (sin
 * nodo `start`: `findStartNodeId` cae al primer nodo del array cuando no hay uno de tipo
 * `start`) asignado como inicio de un tenant/rol propio del test — así no hace falta un
 * nodo `start` para nada de lo que este bloque prueba. Para BE-IG-02 (ticket_query de un
 * ticket YA sincronizado) se arma la `Conversation` directo con `currentFlowId`/
 * `currentNodeId` apuntando al nodo `ticket_query`, salteando la resolución del flujo de
 * inicio — así el ticket pre-sincronizado no depende de que `ticket_create` haya corrido
 * antes en el mismo mensaje.
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
  createFlow,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
  getSystemContext,
  setSetting,
  deleteSetting,
  installFetchMock,
  FetchRouter,
} from './support';
import { InvgateService } from '../src/modules/invgate/invgate.service';
import { SecretsCipher } from '../src/config/secrets.cipher';
import { AppConfigService } from '../src/config/app-config.service';

// --- Catálogo simulado de InvGate (estático durante todo el archivo, ver comentario de arriba) ---

const TECH_USER = 'chatbot_tecnico_e2e';
const TECH_ID = 5551;

const PRIORITY_BAJA = 10;
const PRIORITY_MEDIA = 20;
const PRIORITY_ALTA = 30;
const PRIORITY_CRITICA = 40;
const PRIORITIES = [
  { id: PRIORITY_BAJA, name: 'Baja' },
  { id: PRIORITY_MEDIA, name: 'Media' },
  { id: PRIORITY_ALTA, name: 'Alta' },
  { id: PRIORITY_CRITICA, name: 'Crítica' },
];

const TYPE_INCIDENTE = 1;
const TYPE_SOLICITUD = 2;
const TYPES = [
  { id: TYPE_INCIDENTE, name: 'Incidente' },
  { id: TYPE_SOLICITUD, name: 'Solicitud' },
];

const STATUS_ABIERTO = 1;
const STATUS_EN_PROGRESO = 2;
const STATUS_RESUELTO = 3;
const STATUS_CERRADO = 4;
const STATUSES = [
  { id: STATUS_ABIERTO, name: 'Abierto' },
  { id: STATUS_EN_PROGRESO, name: 'En progreso' },
  { id: STATUS_RESUELTO, name: 'Resuelto' },
  { id: STATUS_CERRADO, name: 'Cerrado' },
];

const CATEGORY_HARDWARE = 100;
const CATEGORY_IMPRESORAS = 101;
const CATEGORY_TECLADOS = 102;
const CATEGORIES = [
  { id: CATEGORY_HARDWARE, name: 'Hardware', parent_category_id: null as number | null },
  { id: CATEGORY_IMPRESORAS, name: 'Impresoras', parent_category_id: CATEGORY_HARDWARE },
  { id: CATEGORY_TECLADOS, name: 'Teclados', parent_category_id: CATEGORY_HARDWARE },
];

const CATALOG_PARENT_ID = CATEGORY_HARDWARE; // INVGATE_CATEGORY_PARENT_ID "normal" del resto de la suite
const INFINITE_PARENT_ID = 900; // parent dedicado solo a BE-IG-12 (rama con miles de categorías)

const BASE_URL = 'https://invgate.e2e.test';
const SUITE_API_KEY = 'tk_e2e_super_secreto_0001';

const LEAK_TEST_ID = '424242';
const LEAK_TEST_SECRET = 'tk_leaked_secret_e2e_999';

/** Réplica de `InvgateService.normalizeName`, solo para filtrar la búsqueda del mock. */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

interface MockState {
  incidents: Map<number, { id: number; status_id: number }>;
  nextIncidentId: number;
  customerByPhone: Map<string, { id: number; username?: string }>;
  failCreateIncident: boolean;
  infiniteCategoryParentId: number | null;
}

/** Router del `fetch` mockeado — simula la API real de InvGate (`{base}/api/v1/...`). */
function invgateRouter(state: MockState): FetchRouter {
  return (url, init) => {
    const u = new URL(url);
    const method = (init?.method || 'GET').toUpperCase();
    const path = u.pathname;

    if (path.endsWith('/incident.attributes.priority')) {
      return { status: 200, body: { data: PRIORITIES } };
    }
    if (path.endsWith('/incident.attributes.type')) {
      return { status: 200, body: { data: TYPES } };
    }
    if (path.endsWith('/incident.attributes.status')) {
      return { status: 200, body: { data: STATUSES } };
    }
    if (path.endsWith('/incident.attributes.category')) {
      const search = u.searchParams.get('search');
      if (search) {
        const norm = normalize(search);
        const found = CATEGORIES.filter((c) => normalize(c.name) === norm);
        return { status: 200, body: { data: found } };
      }

      const page = Number(u.searchParams.get('page') || '1');
      const pageSize = Number(u.searchParams.get('page_size') || '0') || CATEGORIES.length;

      if (state.infiniteCategoryParentId !== null) {
        // Rama "sin fondo": siempre devuelve una página llena, como si hubiera miles de
        // categorías bajo este parent — así `listAllCategories` nunca corta antes del
        // tope de 20 páginas por sí sola (BE-IG-12).
        const items = Array.from({ length: pageSize }, (_, i) => ({
          id: 1_000_000 + (page - 1) * pageSize + i,
          name: `Categoría generada ${(page - 1) * pageSize + i}`,
          parent_category_id: state.infiniteCategoryParentId,
        }));
        return { status: 200, body: { data: items } };
      }

      if (page === 1) return { status: 200, body: { data: CATEGORIES } };
      return { status: 200, body: { data: [] } };
    }
    if (path.endsWith('/users.by')) {
      const username = u.searchParams.get('username');
      const phones = u.searchParams.get('phones');
      if (username) {
        if (username === TECH_USER) {
          return { status: 200, body: { data: { 0: { id: TECH_ID, username: TECH_USER } } } };
        }
        return { status: 200, body: { data: {} } };
      }
      if (phones) {
        const found = state.customerByPhone.get(phones);
        return { status: 200, body: { data: found ? { 0: found } : {} } };
      }
      return { status: 404, body: { error: 'falta username o phones' } };
    }
    if (path.endsWith('/incident') && method === 'POST') {
      if (state.failCreateIncident) {
        return { status: 500, body: { error: 'InvGate no disponible (simulado)' } };
      }
      const id = state.nextIncidentId++;
      const created = { id, status_id: STATUS_ABIERTO };
      state.incidents.set(id, created);
      return { status: 200, body: created };
    }
    if (path.endsWith('/incident') && method === 'GET') {
      const idParam = u.searchParams.get('id');
      if (idParam === LEAK_TEST_ID) {
        // Respuesta NO json (HTML de error), a propósito: fuerza el camino de `sanitize()`
        // en `InvgateService.send()` (BE-IG-09b) — con un `error`/`info` en JSON, `sanitize`
        // ni se llama.
        return { status: 401, body: `<html>Auth failed. Token recibido: ${LEAK_TEST_SECRET}</html>` };
      }
      const incident = state.incidents.get(Number(idParam));
      if (!incident) return { status: 404, body: { error: 'no existe' } };
      return { status: 200, body: incident };
    }
    return { status: 404, body: { error: `ruta no mockeada: ${method} ${path}` } };
  };
}

describe('1.22 Integración InvGate (BE-IG-*)', () => {
  let t: TestApp;
  let invgateService: InvgateService;
  let cipher: SecretsCipher;
  let requests: { url: string; init?: RequestInit }[];
  let restoreFetch: () => void;

  const state: MockState = {
    incidents: new Map(),
    nextIncidentId: 9000,
    customerByPhone: new Map(),
    failCreateIncident: false,
    infiniteCategoryParentId: null,
  };

  // Tenant/rol/usuarios para los tests del catálogo (BE-IG-03/04/12) — se reusan porque son
  // de solo lectura, no mutan estado de negocio.
  let catalogTenant: { id: string };
  let catalogToken: string;
  let sinFlowsToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    invgateService = t.moduleRef.get(InvgateService, { strict: false });
    cipher = t.moduleRef.get(SecretsCipher, { strict: false });

    const mock = installFetchMock(invgateRouter(state));
    requests = mock.requests;
    restoreFetch = mock.restore;

    await setSetting(t.prisma, 'INVGATE_API_URL', BASE_URL);
    await setSetting(t.prisma, 'INVGATE_API_USER', TECH_USER);
    await setSetting(t.prisma, 'INVGATE_API_KEY', SUITE_API_KEY);
    await setSetting(t.prisma, 'INVGATE_DEFAULT_CATEGORY_ID', String(CATEGORY_HARDWARE));
    await setSetting(t.prisma, 'INVGATE_DEFAULT_PRIORITY_ID', String(PRIORITY_MEDIA));
    await setSetting(t.prisma, 'INVGATE_DEFAULT_TYPE_ID', String(TYPE_INCIDENTE));
    await setSetting(t.prisma, 'INVGATE_CATEGORY_PARENT_ID', String(CATALOG_PARENT_ID));

    catalogTenant = await createTenant(t.prisma, { slug: uniqueSlug('ig-catalog') });
    const roleConFlows = await createRole(t.prisma, {
      tenantId: catalogTenant.id,
      name: 'Editor Flujos',
      permissions: ['flows:read'],
    });
    const userConFlows = await createUser(t.prisma, {
      email: uniqueEmail('ig-cat'),
      phone: uniquePhone(),
      memberships: [{ tenantId: catalogTenant.id, roleId: roleConFlows.id }],
    });
    catalogToken = tokenFor(t, userConFlows);

    const roleSinFlows = await createRole(t.prisma, {
      tenantId: catalogTenant.id,
      name: 'Sin Flujos',
      permissions: [],
    });
    const userSinFlows = await createUser(t.prisma, {
      email: uniqueEmail('ig-sin'),
      phone: uniquePhone(),
      memberships: [{ tenantId: catalogTenant.id, roleId: roleSinFlows.id }],
    });
    sinFlowsToken = tokenFor(t, userSinFlows);
  });

  afterAll(async () => {
    restoreFetch();
    await deleteSetting(t.prisma, 'INVGATE_API_URL');
    await deleteSetting(t.prisma, 'INVGATE_API_USER');
    await deleteSetting(t.prisma, 'INVGATE_API_KEY');
    await deleteSetting(t.prisma, 'INVGATE_DEFAULT_CATEGORY_ID');
    await deleteSetting(t.prisma, 'INVGATE_DEFAULT_PRIORITY_ID');
    await deleteSetting(t.prisma, 'INVGATE_DEFAULT_TYPE_ID');
    await deleteSetting(t.prisma, 'INVGATE_CATEGORY_PARENT_ID');
    await t.close();
  });

  it('BE-IG-01: el nodo ticket_create crea el Ticket local y lo empuja a InvGate (best-effort)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig01') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig01'),
      phone: uniquePhone(),
      invgateUserId: '7001',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG01 ${uniqueSlug()}`,
      nodes: [
        {
          id: 'tc',
          type: 'ticket_create',
          data: {
            subject: 'La impresora no imprime',
            description: 'Piso 3, no responde desde ayer',
            priority: 'Alta',
            category: 'Impresoras',
            ticketType: 'Incidente',
          },
        },
      ],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const before = requests.length;
    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: user.phone, body: 'Necesito ayuda con la impresora del piso 3', tenantId: tenant.id });

    // @Post() sin @HttpCode devuelve 201 (default de Nest).
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Ticket #');
    expect(res.body.reply).toContain('creado');

    const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { userId: user.id } });
    expect(ticket.invgateId).not.toBeNull();
    expect(state.incidents.has(Number(ticket.invgateId))).toBe(true);

    const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
    expect(postCall).toBeDefined();
    const params = postCall!.init!.body as URLSearchParams;
    expect(params.get('customer_id')).toBe('7001');
    expect(params.get('creator_id')).toBe(String(TECH_ID));
    expect(params.get('category_id')).toBe(String(CATEGORY_IMPRESORAS));
    expect(params.get('priority_id')).toBe(String(PRIORITY_ALTA));
    expect(params.get('type_id')).toBe(String(TYPE_INCIDENTE));
  });

  it('BE-IG-02: ticket_query de un ticket ya sincronizado trae el status_id real y lo traduce a nombre legible', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig02') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig02'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });

    const remoteId = state.nextIncidentId++;
    state.incidents.set(remoteId, { id: remoteId, status_id: STATUS_RESUELTO });

    const ticket = await t.prisma.ticket.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        subject: 'Ticket ya sincronizado',
        status: 'open', // estado local viejo, tiene que actualizarse con el real de InvGate
        invgateId: String(remoteId),
      },
    });

    // Flujo de un solo nodo `ticket_query`. Sin `assign`: la conversación apunta directo a
    // `currentFlowId`/`currentNodeId`, no pasa por `findActiveFlowForTenant`.
    const flow = await createFlow(t.prisma, {
      name: `IG02 ${uniqueSlug()}`,
      nodes: [{ id: 'tq', type: 'ticket_query', data: {} }],
    });
    await t.prisma.conversation.create({
      data: {
        userId: user.id,
        tenantId: tenant.id,
        channel: 'whatsapp',
        externalId: user.phone,
        status: 'active',
        sessionStartedAt: new Date(),
        currentFlowId: flow.id,
        currentNodeId: 'tq',
        flowState: { lastTicketId: ticket.id },
      },
    });

    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: user.phone, body: '¿Cómo va mi ticket?', tenantId: tenant.id });

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain(`Ticket #${ticket.id}`);
    expect(res.body.reply).toContain('Resuelto');

    const updated = await t.prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.status).toBe('Resuelto'); // se actualiza también localmente
  });

  it('BE-IG-03: GET /invgate/catalog/{categories,priorities,types} con flows:read devuelve el catálogo real', async () => {
    const cats = await withAuth(http(t).get('/invgate/catalog/categories'), catalogToken, catalogTenant.id);
    expect(cats.status).toBe(200);
    expect(cats.body.map((c: { name: string }) => c.name).sort()).toEqual(['Impresoras', 'Teclados']);

    const prios = await withAuth(http(t).get('/invgate/catalog/priorities'), catalogToken, catalogTenant.id);
    expect(prios.status).toBe(200);
    expect(prios.body.map((p: { name: string }) => p.name).sort()).toEqual(['Alta', 'Baja', 'Crítica', 'Media']);

    const types = await withAuth(http(t).get('/invgate/catalog/types'), catalogToken, catalogTenant.id);
    expect(types.status).toBe(200);
    expect(types.body.map((tt: { name: string }) => tt.name).sort()).toEqual(['Incidente', 'Solicitud']);
  });

  it('BE-IG-04: GET /invgate/catalog/* sin flows:read devuelve 403', async () => {
    const res = await withAuth(http(t).get('/invgate/catalog/priorities'), sinFlowsToken, catalogTenant.id);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Permiso denegado: flows:read');
  });

  it('BE-IG-05a: category/priority/ticketType recolectados en la charla se resuelven por NOMBRE (match normalizado)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig05a') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig05a'),
      phone: uniquePhone(),
      invgateUserId: '7030',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG05a ${uniqueSlug()}`,
      nodes: [
        {
          id: 'tc',
          type: 'ticket_create',
          // Mayúsculas/acentos mezclados a propósito: el match es normalizado, no literal.
          data: { subject: 'Necesito una impresora nueva', category: 'impresoras', priority: 'ALTA', ticketType: 'incidente' },
        },
      ],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const before = requests.length;
    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: user.phone, body: 'Necesito una impresora nueva para mi oficina', tenantId: tenant.id });
    expect(res.status).toBe(201);

    const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
    const params = postCall!.init!.body as URLSearchParams;
    expect(params.get('category_id')).toBe(String(CATEGORY_IMPRESORAS));
    expect(params.get('priority_id')).toBe(String(PRIORITY_ALTA));
    expect(params.get('type_id')).toBe(String(TYPE_INCIDENTE));
  });

  it('BE-IG-05b: sin match (o sin dato recolectado) cae al default de /settings, sin romper la creación', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig05b') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig05b'),
      phone: uniquePhone(),
      invgateUserId: '7031',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG05b ${uniqueSlug()}`,
      nodes: [
        {
          id: 'tc',
          // Categoría que no matchea ninguna real; sin priority/ticketType (la charla no los recolectó).
          data: { subject: 'Pedido genérico', category: 'Categoría Que No Existe' },
          type: 'ticket_create',
        },
      ],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const before = requests.length;
    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: user.phone, body: 'Tengo un problema variado', tenantId: tenant.id });
    expect(res.status).toBe(201);

    const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
    const params = postCall!.init!.body as URLSearchParams;
    expect(params.get('category_id')).toBe(String(CATEGORY_HARDWARE)); // INVGATE_DEFAULT_CATEGORY_ID
    expect(params.get('priority_id')).toBe(String(PRIORITY_MEDIA)); // INVGATE_DEFAULT_PRIORITY_ID
    expect(params.get('type_id')).toBe(String(TYPE_INCIDENTE)); // INVGATE_DEFAULT_TYPE_ID
  });

  it('BE-IG-06a: con invgateUserId ya cargado en el User local, se usa directo sin consultar InvGate', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig06a') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig06a'),
      phone: uniquePhone(),
      invgateUserId: '7040',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG06a ${uniqueSlug()}`,
      nodes: [{ id: 'tc', type: 'ticket_create', data: { subject: 'Consulta general', priority: 'Media' } }],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const before = requests.length;
    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: user.phone, body: 'Tengo una consulta general sobre mi cuenta', tenantId: tenant.id });
    expect(res.status).toBe(201);

    const usersByCalls = requests.slice(before).filter((r) => r.url.includes('/users.by'));
    expect(usersByCalls).toHaveLength(0); // no hizo falta preguntarle a InvGate

    const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
    const params = postCall!.init!.body as URLSearchParams;
    expect(params.get('customer_id')).toBe('7040');
  });

  it('BE-IG-06b: sin invgateUserId, resuelve el customer_id por teléfono y lo cachea en el User local', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig06b') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const phone = uniquePhone();
    state.customerByPhone.set(phone, { id: 7050, username: 'cliente_encontrado' });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig06b'),
      phone,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG06b ${uniqueSlug()}`,
      nodes: [{ id: 'tc', type: 'ticket_create', data: { subject: 'Otra consulta', priority: 'Media' } }],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    const before = requests.length;
    const res = await http(t)
      .post('/conversations/simulate')
      .send({ from: phone, body: 'Tengo otra consulta sobre el sistema', tenantId: tenant.id });
    expect(res.status).toBe(201);

    const usersByCalls = requests.slice(before).filter((r) => r.url.includes('/users.by') && r.url.includes('phones'));
    expect(usersByCalls.length).toBeGreaterThan(0);

    const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
    const params = postCall!.init!.body as URLSearchParams;
    expect(params.get('customer_id')).toBe('7050');

    const updated = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.invgateUserId).toBe('7050'); // quedó cacheado para la próxima
  });

  it('BE-IG-07: creator_id es siempre el usuario técnico y el Basic Auth siempre usa sus credenciales', async () => {
    for (const invgateUserId of ['7060', '7061']) {
      const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig07') });
      const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
      const user = await createUser(t.prisma, {
        email: uniqueEmail('ig07'),
        phone: uniquePhone(),
        invgateUserId,
        memberships: [{ tenantId: tenant.id, roleId: role.id }],
      });
      await createFlow(t.prisma, {
        name: `IG07 ${uniqueSlug()}`,
        nodes: [{ id: 'tc', type: 'ticket_create', data: { subject: 'Consulta', priority: 'Media' } }],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      const before = requests.length;
      await http(t)
        .post('/conversations/simulate')
        .send({ from: user.phone, body: 'Tengo una consulta sobre mi equipo', tenantId: tenant.id });

      const postCall = requests.slice(before).find((r) => r.url.endsWith('/api/v1/incident') && r.init?.method === 'POST');
      expect(postCall).toBeDefined();
      const params = postCall!.init!.body as URLSearchParams;
      // Sin importar cuál sea el usuario final (customer_id distinto en cada vuelta), el
      // creator_id es siempre el técnico.
      expect(params.get('creator_id')).toBe(String(TECH_ID));

      const authHeader = (postCall!.init!.headers as Record<string, string>).Authorization;
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
      expect(decoded.startsWith(`${TECH_USER}:`)).toBe(true); // Basic Auth siempre con el usuario técnico
    }
  });

  it('BE-IG-08: si InvGate está caído durante ticket_create, el Ticket local existe igual y la charla sigue (best-effort)', async () => {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('ig08') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Cliente', permissions: [] });
    const user = await createUser(t.prisma, {
      email: uniqueEmail('ig08'),
      phone: uniquePhone(),
      invgateUserId: '7020',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `IG08 ${uniqueSlug()}`,
      nodes: [
        {
          id: 'tc',
          type: 'ticket_create',
          data: { subject: 'El sistema no arranca', priority: 'Alta', category: 'Impresoras', ticketType: 'Incidente' },
        },
      ],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });

    state.failCreateIncident = true;
    try {
      const res = await http(t)
        .post('/conversations/simulate')
        .send({ from: user.phone, body: 'El sistema no arranca esta mañana', tenantId: tenant.id });

      // Best-effort: la charla sigue con normalidad, sin 500 ni timeout expuesto al usuario.
      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Ticket #');
      expect(res.body.reply).toContain('creado');

      const ticket = await t.prisma.ticket.findFirstOrThrow({ where: { userId: user.id } });
      expect(ticket.invgateId).toBeNull(); // no se sincronizó, pero el ticket local existe igual
    } finally {
      state.failCreateIncident = false;
    }
  });

  it('BE-IG-09a: INVGATE_API_KEY vía /settings queda cifrada en BD; el GET nunca la devuelve en claro', async () => {
    const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);
    const adminToken = tokenFor(t, admin);
    const secreto = 'tk_real_del_admin_ABCDEF123456';

    try {
      const patch = await withAuth(http(t).patch('/settings/INVGATE_API_KEY'), adminToken, systemTenant.id).send({
        value: secreto,
      });

      // @Patch() sin @HttpCode devuelve 200 (default de Nest).
      expect(patch.status).toBe(200);
      expect(patch.body.isSet).toBe(true);
      expect(patch.body.value).not.toBe(secreto);
      expect(patch.body.value).toContain('••••••••');
      expect(JSON.stringify(patch.body)).not.toContain(secreto);

      const stored = await t.prisma.setting.findUniqueOrThrow({ where: { key: 'INVGATE_API_KEY' } });
      expect(stored.value.startsWith('enc:v1:')).toBe(true);
      expect(cipher.decrypt(stored.value)).toBe(secreto);

      const get = await withAuth(http(t).get('/settings/INVGATE_API_KEY'), adminToken, systemTenant.id);
      expect(get.status).toBe(200);
      expect(get.body.isSet).toBe(true);
      expect(get.body.value).not.toBe(secreto);
      expect(JSON.stringify(get.body)).not.toContain(secreto);
    } finally {
      await setSetting(t.prisma, 'INVGATE_API_KEY', SUITE_API_KEY); // restaurar para el resto de la suite
    }
  });

  it('BE-IG-09b: un error de la API de InvGate nunca deja el token de INVGATE_API_KEY en el mensaje (sanitize)', async () => {
    await setSetting(t.prisma, 'INVGATE_API_KEY', LEAK_TEST_SECRET);
    try {
      let thrown: Error | undefined;
      try {
        // Llamada directa al provider real (no HTTP): el endpoint que la expone
        // (`getIncident`, usado por `ticket_query`) no propaga el mensaje crudo al usuario,
        // así que se ejercita `InvgateService.send()`/`sanitize()` en el punto exacto donde
        // vive la garantía.
        await invgateService.getIncident(LEAK_TEST_ID);
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).not.toContain(LEAK_TEST_SECRET);
      expect(thrown!.message).toContain('***REDACTED***');
    } finally {
      await setSetting(t.prisma, 'INVGATE_API_KEY', SUITE_API_KEY); // restaurar para el resto de la suite
    }
  });

  // --- BE-IG-10 (robustez, sin número de hallazgo): cachés en memoria que no se invalidan ---
  it.failing(
    'BE-IG-10: corregir INVGATE_API_USER en caliente debería resolver el creator_id sin reiniciar (robustez)',
    async () => {
      // Nota de diseño: NO se usa una segunda `createTestApp()` (patrón de BE-AUTH-25) para
      // esto. `ConversationsService` se suscribe a `whatsapp.simulate.incoming` con
      // `broker.subscribe`, y esa cola vive en el vhost efímero DEL ARCHIVO (uno solo, no uno
      // por app) — con `t` todavía abierto, una segunda app quedaría compitiendo por los
      // mismos mensajes (RabbitMQ reparte round-robin entre consumidores de una cola), y
      // terminaría a veces sirviéndolos el consumidor de `t` (con su `creatorIdCache` ya
      // resuelto de tests anteriores), enmascarando el bug. Se prueba `InvgateService`
      // directo: una instancia propia (no la del DI de `t`, así no se envenena el
      // `creatorIdCache` que el resto del archivo necesita resuelto), construida a mano con
      // el mismo `AppConfigService` real — sigue siendo la lógica real bajo prueba, solo que
      // sin pasar por el motor de flujos (innecesario: el bug vive enteramente adentro de
      // `InvgateService`).
      const appConfig = t.moduleRef.get(AppConfigService, { strict: false });
      const freshInvgate = new InvgateService(appConfig);

      await setSetting(t.prisma, 'INVGATE_API_USER', 'usuario-tecnico-que-no-existe');
      try {
        const first = await freshInvgate.resolveCreatorId();
        expect(first).toBeNull(); // no matchea a nadie en InvGate → cachea `null`

        // Se corrige la configuración desde /settings...
        await setSetting(t.prisma, 'INVGATE_API_USER', TECH_USER);

        const second = await freshInvgate.resolveCreatorId();
        // SEGURO esperado: con la config ya corregida, la próxima resolución encuentra al
        // técnico. Hoy `resolveCreatorId` cachea `null` la primera vez y nunca reintenta
        // (`if (this.creatorIdCache !== undefined) return this.creatorIdCache;`), así que
        // sigue devolviendo `null` aunque la config ya esté bien — solo se arregla
        // reiniciando el proceso.
        expect(second).not.toBeNull();
      } finally {
        await setSetting(t.prisma, 'INVGATE_API_USER', TECH_USER); // restaurar para el resto de la suite
      }
    },
  );

  // --- BE-IG-11 (SEC-20): INVGATE_API_URL con http:// debería exigir HTTPS ---
  it.failing(
    'BE-IG-11: con INVGATE_API_URL en http://, el Basic Auth no debe viajar en claro por la red (SEC-20)',
    async () => {
      await setSetting(t.prisma, 'INVGATE_API_URL', 'http://insecure.invgate.e2e.test');
      const before = requests.length;
      try {
        await withAuth(http(t).get('/invgate/catalog/priorities'), catalogToken, catalogTenant.id);

        const madeInsecureCall = requests.slice(before).some((r) => r.url.startsWith('http://'));
        // SEGURO esperado: ninguna request sale por http:// (esquema rechazado, o forzado a
        // https antes de llamar a `fetch`). Hoy `baseUrl()` solo saca la barra final
        // (`raw?.replace(/\/+$/, '')`), sin validar el esquema — la request sale tal cual.
        expect(madeInsecureCall).toBe(false);
      } finally {
        await setSetting(t.prisma, 'INVGATE_API_URL', BASE_URL); // restaurar para el resto de la suite
      }
    },
  );

  it('BE-IG-12: una rama con más de 4000 categorías se corta en 4000 (20 páginas × 200) sin avisar', async () => {
    state.infiniteCategoryParentId = INFINITE_PARENT_ID;
    await setSetting(t.prisma, 'INVGATE_CATEGORY_PARENT_ID', String(INFINITE_PARENT_ID));
    const before = requests.length;
    try {
      const res = await withAuth(http(t).get('/invgate/catalog/categories'), catalogToken, catalogTenant.id);

      expect(res.status).toBe(200); // no avisa del corte: 200 igual, sin error ni warning visible
      expect(res.body).toHaveLength(4000); // tope silencioso de `listAllCategories`: 20 × 200

      const categoryCalls = requests.slice(before).filter((r) => r.url.includes('incident.attributes.category'));
      const pagesRequested = categoryCalls.map((r) => Number(new URL(r.url).searchParams.get('page')));
      expect(Math.max(...pagesRequested)).toBe(20); // nunca pide la página 21, aunque el mock la serviría
    } finally {
      state.infiniteCategoryParentId = null;
      await setSetting(t.prisma, 'INVGATE_CATEGORY_PARENT_ID', String(CATALOG_PARENT_ID));
    }
  });

  it.skip(
    'BE-IG-13: pnpm --filter api invgate:check chequea conectividad y lista IDs reales del catálogo por consola ' +
      '[BLOQUEADO: requiere una instancia real de InvGate; el script lee apps/api/.env directo (no la BD de test) ' +
      'y le pega a INVGATE_API_URL real — correrlo sin credenciales válidas dependería de la red y de las ' +
      'credenciales reales configuradas en el entorno, no es reproducible ni rápido desde este archivo]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );

  it.skip(
    'BE-IG-14: crear/consultar un ticket end-to-end contra InvGate real ' +
      '[BLOQUEADO: requiere InvGate real — el valor cargado como token resultó ser la contraseña de portal de un ' +
      'usuario, pendiente que el admin genere un token de API real, ver docs/plan-de-pruebas.md BE-PH-01]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );
});
