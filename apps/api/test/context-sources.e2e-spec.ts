/**
 * 1.9 Fuentes de verdad (context sources) — CRUD y test-connection (BE-CS-*)
 *
 * Vía: endpoints REST reales (`/context-sources/*`) con supertest, sobre la base efímera.
 *
 * `ContextSource` es POR tenant (como Area), cadena estándar de guards
 * (`JwtAuthGuard, TenantGuard, RolesGuard`) con permisos `context-sources:read/create/
 * update/delete` — sin `SystemTenantGuard`. El catálogo (`context-source-types.catalog.ts`)
 * define los tipos (mcp/rag/n8n/broker) y sus campos; `ContextSourcesService` descarta
 * cualquier key de `config` fuera del catálogo para ese `type`. Los campos `secret` se
 * cifran (AES-256-GCM, `SecretsCipher`) dentro del `config` (Json) y nunca salen en claro
 * por la API — el GET enmascara y agrega `<campo>IsSet`.
 *
 * "Probar conexión" (`POST /:id/test-connection`) no hace `fetch` desde el controlador:
 * publica por el broker (RPC) a la cola `context-source.test-connection`, que consume
 * `ContextSourceConnectorService` — vive en el MISMO módulo/proceso (ver
 * `context-sources.module.ts`), así que el viaje RPC completo corre de verdad dentro de la
 * misma app de test, sin mockear nada. Los casos que necesitan una fuente REAL alcanzable
 * (BE-CS-13/16/17/18/19) quedan bloqueados (`it.skip`): BE-CS-18 en particular dispararía
 * un webhook real de n8n. BE-CS-14 (fuente inalcanzable) sí es real y rápido: apunta a un
 * puerto local cerrado — la conexión se rechaza (ECONNREFUSED) en milisegundos, sin
 * esperar el timeout de 20s del connector.
 *
 * Frontera mockeada: NINGUNA. No se mockea el broker ni `ContextSourcesService` (es la
 * lógica bajo prueba); tampoco `fetch` — BE-CS-14 hace una conexión TCP real a un puerto
 * cerrado en loopback, que no requiere red externa.
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
  createContextSource,
  createFlow,
  uniqueEmail,
  uniquePhone,
  uniqueSlug,
} from './support';
import { SecretsCipher } from '../src/config/secrets.cipher';

const CS_PERMS = [
  'context-sources:read',
  'context-sources:create',
  'context-sources:update',
  'context-sources:delete',
];

describe('1.9 Fuentes de verdad — context sources (BE-CS-*)', () => {
  let t: TestApp;
  let cipher: SecretsCipher;

  // Tenant A: acceso completo a context-sources. Se reusa entre tests de solo-lectura;
  // los tests que crean/mutan fuentes usan nombres únicos (uid()) para no pisarse.
  let tenantA: { id: string };
  let tokenA: string;

  // Tenant B: para los casos de aislamiento (BE-CS-02/03/06).
  let tenantB: { id: string };
  let tokenB: string;

  // Tenant C: rol SIN ningún permiso de context-sources (BE-CS-15).
  let tenantC: { id: string };
  let tokenSinPermiso: string;

  beforeAll(async () => {
    t = await createTestApp();
    cipher = t.moduleRef.get(SecretsCipher, { strict: false });

    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('cs-a') });
    const roleA = await createRole(t.prisma, {
      tenantId: tenantA.id,
      name: 'Admin Fuentes',
      permissions: CS_PERMS,
    });
    const userA = await createUser(t.prisma, {
      email: uniqueEmail('cs-a'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenantA.id, roleId: roleA.id }],
    });
    tokenA = tokenFor(t, userA);

    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('cs-b') });
    const roleB = await createRole(t.prisma, {
      tenantId: tenantB.id,
      name: 'Admin Fuentes',
      permissions: CS_PERMS,
    });
    const userB = await createUser(t.prisma, {
      email: uniqueEmail('cs-b'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenantB.id, roleId: roleB.id }],
    });
    tokenB = tokenFor(t, userB);

    tenantC = await createTenant(t.prisma, { slug: uniqueSlug('cs-c') });
    const roleSinPermiso = await createRole(t.prisma, {
      tenantId: tenantC.id,
      name: 'Sin Permisos',
      permissions: [],
    });
    const userSinPermiso = await createUser(t.prisma, {
      email: uniqueEmail('cs-c'),
      phone: uniquePhone(),
      memberships: [{ tenantId: tenantC.id, roleId: roleSinPermiso.id }],
    });
    tokenSinPermiso = tokenFor(t, userSinPermiso);
  });

  afterAll(async () => {
    await t.close();
  });

  it('BE-CS-01: GET /context-sources/types devuelve el catálogo de tipos con sus campos', async () => {
    const res = await withAuth(http(t).get('/context-sources/types'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const types = res.body.map((d: { type: string }) => d.type);
    expect(types.sort()).toEqual(['broker', 'mcp', 'n8n', 'rag']);

    const mcp = res.body.find((d: { type: string }) => d.type === 'mcp');
    expect(mcp.label).toBeDefined();
    const apiKeyField = mcp.fields.find((f: { key: string }) => f.key === 'apiKey');
    expect(apiKeyField.secret).toBe(true);
    expect(apiKeyField.type).toBe('string');
    const serverUrlField = mcp.fields.find((f: { key: string }) => f.key === 'serverUrl');
    expect(serverUrlField.required).toBe(true);
  });

  it('BE-CS-02: GET /context-sources parado en un tenant devuelve solo las suyas, secrets enmascarados', async () => {
    const own = await createContextSource(t.prisma, {
      tenantId: tenantA.id,
      name: `Propia ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query', apiKey: cipher.encrypt('rag_live_supersecreto123'), topK: 5 },
    });
    const ajena = await createContextSource(t.prisma, {
      tenantId: tenantB.id,
      name: `Ajena ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.otra.test/query' },
    });

    const res = await withAuth(http(t).get('/context-sources'), tokenA, tenantA.id);

    expect(res.status).toBe(200);
    const ids = res.body.map((s: { id: string }) => s.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(ajena.id);

    const found = res.body.find((s: { id: string }) => s.id === own.id);
    expect(found.config.apiKeyIsSet).toBe(true);
    expect(found.config.apiKey).not.toBe('rag_live_supersecreto123');
    expect(found.config.apiKey).not.toContain('supersecreto123'); // nunca en claro
    expect(JSON.stringify(res.body)).not.toContain('rag_live_supersecreto123');
  });

  it('BE-CS-03: GET /context-sources/:id de una fuente de otra empresa devuelve 404', async () => {
    const ajena = await createContextSource(t.prisma, {
      tenantId: tenantB.id,
      name: `SoloB ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.otra.test/query' },
    });

    const res = await withAuth(http(t).get(`/context-sources/${ajena.id}`), tokenA, tenantA.id);

    expect(res.status).toBe(404);
  });

  it('BE-CS-04: POST con type válido descarta cualquier key de config fuera del catálogo', async () => {
    const res = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `RAG Config ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query', topK: 7, bogusField: 'no debería persistir' },
    });

    // @Post() sin @HttpCode devuelve 201 (default de Nest).
    expect(res.status).toBe(201);
    expect(res.body.config.endpointUrl).toBe('https://rag.acme.test/query');
    expect(res.body.config.topK).toBe(7);
    expect(res.body.config.bogusField).toBeUndefined();

    const stored = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: res.body.id } });
    expect((stored.config as Record<string, unknown>).bogusField).toBeUndefined();
  });

  it('BE-CS-05: POST con un type fuera de la lista devuelve 400', async () => {
    const res = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `Tipo Invalido ${Date.now()}`,
      type: 'inventado',
      config: {},
    });

    expect(res.status).toBe(400);
  });

  it('BE-CS-06: POST con un name ya usado en la empresa devuelve 409; el mismo name en otra empresa 201', async () => {
    const name = `Duplicado ${Date.now()}`;
    const primera = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/uno' },
    });
    expect(primera.status).toBe(201);

    const segunda = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/dos' },
    });
    expect(segunda.status).toBe(409);

    const enOtraEmpresa = await withAuth(http(t).post('/context-sources'), tokenB, tenantB.id).send({
      name,
      type: 'rag',
      config: { endpointUrl: 'https://rag.otra.test/uno' },
    });
    expect(enOtraEmpresa.status).toBe(201);
  });

  it('BE-CS-07: POST con un campo secret lo guarda cifrado (nunca en claro); el GET lo enmascara', async () => {
    const secreto = 'rag_live_valorSecreto999';
    const create = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `Con Secreto ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query', apiKey: secreto },
    });

    expect(create.status).toBe(201);
    expect(JSON.stringify(create.body)).not.toContain(secreto);
    expect(create.body.config.apiKeyIsSet).toBe(true);

    // El valor persistido en la base está cifrado con el prefijo real de SecretsCipher,
    // nunca el texto plano.
    const stored = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: create.body.id } });
    const storedApiKey = (stored.config as Record<string, unknown>).apiKey as string;
    expect(storedApiKey).not.toBe(secreto);
    expect(storedApiKey.startsWith('enc:v1:')).toBe(true);
    expect(cipher.decrypt(storedApiKey)).toBe(secreto);

    const get = await withAuth(http(t).get(`/context-sources/${create.body.id}`), tokenA, tenantA.id);
    expect(get.body.config.apiKeyIsSet).toBe(true);
    expect(get.body.config.apiKey).not.toBe(secreto);
    expect(JSON.stringify(get.body)).not.toContain(secreto);
  });

  it('BE-CS-08: PATCH sin enviar un campo secret ya cargado conserva el secreto cifrado', async () => {
    const secreto = 'rag_live_conservame777';
    const create = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `Conserva Secreto ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query', apiKey: secreto, topK: 3 },
    });
    expect(create.status).toBe(201);
    const before = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: create.body.id } });
    const encryptedBefore = (before.config as Record<string, unknown>).apiKey;

    // PATCH manda config con OTRO campo (topK) pero sin la key `apiKey`: "campo ausente = no tocar".
    const patch = await withAuth(http(t).patch(`/context-sources/${create.body.id}`), tokenA, tenantA.id).send({
      config: { endpointUrl: 'https://rag.acme.test/query', topK: 9 },
    });

    // @Patch() sin @HttpCode devuelve 200 (default de Nest).
    expect(patch.status).toBe(200);
    expect(patch.body.config.apiKeyIsSet).toBe(true);
    expect(patch.body.config.topK).toBe(9);

    const after = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: create.body.id } });
    expect((after.config as Record<string, unknown>).apiKey).toBe(encryptedBefore); // exactamente el mismo cifrado
  });

  it('BE-CS-09: PATCH con un campo secret explícito en null borra ese secreto', async () => {
    const secreto = 'rag_live_borrame555';
    const create = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `Borra Secreto ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query', apiKey: secreto },
    });
    expect(create.status).toBe(201);
    expect(create.body.config.apiKeyIsSet).toBe(true);

    const patch = await withAuth(http(t).patch(`/context-sources/${create.body.id}`), tokenA, tenantA.id).send({
      config: { apiKey: null },
    });

    expect(patch.status).toBe(200);
    expect(patch.body.config.apiKeyIsSet).toBe(false);
    expect(patch.body.config.apiKey).toBe('');

    const after = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: create.body.id } });
    expect((after.config as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it('BE-CS-10: PATCH intentando mandar type es rechazado (no está en el UpdateDto); el type nunca cambia', async () => {
    const create = await withAuth(http(t).post('/context-sources'), tokenA, tenantA.id).send({
      name: `Tipo Inmutable ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query' },
    });
    expect(create.status).toBe(201);

    // `UpdateContextSourceDto` no declara `type`; el ValidationPipe global tiene
    // forbidNonWhitelisted:true, así que mandarlo devuelve 400 (no lo ignora en silencio).
    const patchConType = await withAuth(http(t).patch(`/context-sources/${create.body.id}`), tokenA, tenantA.id).send({
      name: 'Nuevo Nombre',
      type: 'mcp',
    });
    expect(patchConType.status).toBe(400);

    // Un PATCH legítimo (sin `type`) sí cambia lo que declara el DTO, y el type queda intacto.
    const patchValido = await withAuth(http(t).patch(`/context-sources/${create.body.id}`), tokenA, tenantA.id).send({
      name: 'Nuevo Nombre Valido',
    });
    expect(patchValido.status).toBe(200);
    expect(patchValido.body.name).toBe('Nuevo Nombre Valido');

    const stored = await t.prisma.contextSource.findUniqueOrThrow({ where: { id: create.body.id } });
    expect(stored.type).toBe('rag');
  });

  it('BE-CS-11: DELETE de una fuente vinculada a un flujo es rechazado (409), no se borra', async () => {
    const source = await createContextSource(t.prisma, {
      tenantId: tenantA.id,
      name: `Vinculada ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query' },
    });
    await createFlow(t.prisma, { name: `Flujo con fuente ${Date.now()}`, contextSourceId: source.id });

    const res = await withAuth(http(t).delete(`/context-sources/${source.id}`), tokenA, tenantA.id);

    // El servicio NO deja que el FK SetNull se dispare solo: cuenta los flujos que la usan
    // y bloquea el borrado con 409 antes de tocar la base (ver ContextSourcesService.remove).
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('1');
    expect(res.body.message.toLowerCase()).toContain('flujo');

    const stillThere = await t.prisma.contextSource.findUnique({ where: { id: source.id } });
    expect(stillThere).not.toBeNull();
  });

  it('BE-CS-12: DELETE de una fuente sin uso la elimina (200)', async () => {
    const source = await createContextSource(t.prisma, {
      tenantId: tenantA.id,
      name: `Sin Uso ${Date.now()}`,
      type: 'rag',
      config: { endpointUrl: 'https://rag.acme.test/query' },
    });

    const res = await withAuth(http(t).delete(`/context-sources/${source.id}`), tokenA, tenantA.id);

    // @Delete() sin @HttpCode devuelve 200 (default de Nest, no 204).
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const gone = await t.prisma.contextSource.findUnique({ where: { id: source.id } });
    expect(gone).toBeNull();
  });

  it.skip(
    'BE-CS-13: test-connection de una fuente alcanzable responde {ok:true,...} dentro de TEST_TIMEOUT_MS [BLOQUEADO: requiere un servidor HTTP real alcanzable desde el entorno de test]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );

  it(
    'BE-CS-14: test-connection de una fuente inalcanzable devuelve {ok:false} sin colgarse',
    async () => {
      // Puerto local sin nada escuchando: la conexión se rechaza (ECONNREFUSED) en
      // milisegundos, real y sin mockear fetch — no hace falta esperar los 20s del
      // AbortController del connector para este caso.
      const source = await createContextSource(t.prisma, {
        tenantId: tenantA.id,
        name: `Inalcanzable ${Date.now()}`,
        type: 'rag',
        config: { endpointUrl: 'http://127.0.0.1:39917/nope' },
      });

      const res = await withAuth(
        http(t).post(`/context-sources/${source.id}/test-connection`),
        tokenA,
        tenantA.id,
      );

      // @Post() sin @HttpCode devuelve 201 (default de Nest), incluso para esta acción
      // que semánticamente no "crea" nada.
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(false);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.length).toBeGreaterThan(0);
    },
    15000,
  );

  it('BE-CS-15: operar sin el permiso context-sources correspondiente devuelve 403 "Permiso denegado"', async () => {
    const resGet = await withAuth(http(t).get('/context-sources'), tokenSinPermiso, tenantC.id);
    expect(resGet.status).toBe(403);
    expect(resGet.body.message).toBe('Permiso denegado: context-sources:read');

    const resPost = await withAuth(http(t).post('/context-sources'), tokenSinPermiso, tenantC.id).send({
      name: 'No debería crearse',
      type: 'rag',
      config: {},
    });
    expect(resPost.status).toBe(403);
    expect(resPost.body.message).toBe('Permiso denegado: context-sources:create');
  });

  it.skip(
    'BE-CS-16: test-connection de una fuente MCP comprueba la URL con las cabeceras configuradas [BLOQUEADO: requiere un servidor MCP real respondiendo]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );

  it.skip(
    'BE-CS-17: test-connection de una fuente RAG comprueba alcanzabilidad HTTP contra la URL configurada [BLOQUEADO: requiere un servicio RAG real respondiendo]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );

  it.skip(
    'BE-CS-18: test-connection de una fuente n8n hace un POST real al webhook y devuelve el resultado [BLOQUEADO: requiere un webhook n8n de PRUEBA real — el POST real dispara el workflow, nunca usar uno productivo]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );

  it.skip(
    'BE-CS-19: test-connection de una fuente broker publica en la cola configurada y espera respuesta por el broker [BLOQUEADO: requiere un consumidor real suscripto a la cola configurada]',
    async () => {
      // Intencionalmente vacío: ver motivo en el título.
    },
  );
});
