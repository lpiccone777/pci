# Fundación de tests e2e — contrato para escribir specs

Toda la infraestructura compartida vive acá. Un spec nuevo **no** reinventa el setup: importa
desde `./support` (o `../support` según la profundidad) y usa estos helpers.

Ejemplo canónico completo: **`apps/api/test/auth.e2e-spec.ts`**. Miralo antes de escribir uno.

## Cómo se corre

- Backend/chatbot: `pnpm --filter api test:e2e` (todo) o `pnpm --filter api test:e2e -- <archivo>`
  (uno solo, ej. `-- rbac.e2e-spec`).
- `global-setup.ts` crea por corrida una **base Postgres descartable** (migrate + seed) y un
  **vhost RabbitMQ efímero**. La base real nunca se toca. El seed deja SOLO: tenant `system`,
  rol `SuperAdmin` (catálogo completo, 60 permisos) y `admin@pci.local` / `changeme123`.

## Convención de vínculo caso↔test (OBLIGATORIA)

El **ID del caso va en el título**. Es el único vínculo con el plan.

```ts
it('BE-RBAC-02: acceder sin el permiso requerido devuelve 403', async () => { … });
```

- Un caso puede tener varios `it` (comparten el prefijo del ID).
- **Invertido** (`❌` por diseño, SEC-*/robustez): `it.failing('BE-XXX-NN: … (SEC-NN)', …)`. El
  assert verifica el comportamiento **SEGURO** que hoy NO existe → hoy falla → `it.failing` lo da
  verde. Cuando se corrija, el assert pasará y `it.failing` gritará "sacá el marcador". **Nunca**
  dar vuelta el assert para verificar el comportamiento inseguro actual.
- **Bloqueado** (requiere un tercero real vivo): `it.skip('BE-XXX-NN: … [BLOQUEADO: requiere <qué>]', …)`.
  Se escribe el test pero queda skipeado con el motivo. No cuenta como verde.

## API de la fundación (`./support`)

### App

```ts
const t = await createTestApp();                 // app real + ValidationPipe global + EmailService grabador
const t = await createTestApp({ recordEmail:false });          // usa el SmtpEmailService real
const t = await createTestApp({ customize:(b)=>b.overrideProvider(LlmService).useValue(fakeLlm) });
// t.app, t.prisma, t.moduleRef, t.email (RecordingEmailService), t.close()
```

Levantá la app una vez en `beforeAll`, cerrala en `afterAll`.

### Auth

```ts
const token = tokenFor(t, user);                 // firma un access token (15m) sin pasar por el login
const token = tokenForWithExpiry(t, user, '-10s'); // token ya vencido
withAuth(http(t).get('/users'), token, tenantId);  // setea Authorization + X-Tenant-Id
loginViaApi(t, email, password, userAgent?);       // POST /auth/login real (con User-Agent)
http(t);                                           // agente supertest crudo: request(t.app.getHttpServer())
```

### Fixtures (Apéndice C) — `scenario.ts`

```ts
const tenant = await createTenant(t.prisma, { slug: uniqueSlug('acme') });
const role   = await createRole(t.prisma, { tenantId: tenant.id, name: 'Soporte N1',
                 permissions: ['users:read','users:create','areas:read'] });   // 'recurso:accion'
const area   = await createArea(t.prisma, { tenantId: tenant.id, name: 'Soporte' });
const user   = await createUser(t.prisma, { email: uniqueEmail(), phone: uniquePhone(),
                 memberships: [{ tenantId: tenant.id, roleId: role.id, areaId: area.id }] });
const flow   = await createFlow(t.prisma, { name:'F', nodes:[...], edges:[...],
                 assign:[{ tenantId: tenant.id, isStart:true, roleIds:[role.id] }] });
const skill  = await createSkill(t.prisma, { tenantId: tenant.id, name:'S', promptText:'...' });
const cs     = await createContextSource(t.prisma, { tenantId: tenant.id, name:'C', type:'broker', config:{...} });
const { admin, tenant: systemTenant } = await getSystemContext(t.prisma);   // el superadmin del seed
await setSetting(t.prisma, 'OTP_ENABLED', 'true');   // settings son globales: limpiar en afterEach
await deleteSetting(t.prisma, 'OTP_ENABLED');
```

### Mocks de frontera — `mocks.ts` (solo terceros; NUNCA la lógica bajo prueba)

```ts
const fakeLlm = new FakeLlmService().setReply('hola');   // frontera LLM (para tests del CHATBOT)
fakeLlm.setResponder((msgs) => /cancelar/i.test(last(msgs)) ? 'cancelar' : 'seguir');
const { requests, restore } = installFetchMock((url) =>   // frontera HTTP (Meta/Twilio/Gupshup/InvGate)
  url.includes('graph.facebook') ? { status:200, body:{ messages:[{id:'wamid'}] } } : { status:404 });
// t.email: RecordingEmailService — t.email.codeFor(to) extrae el código OTP del último mail
```

## Reglas duras (aprendidas al validar la fundación)

1. **`@Post()` devuelve 201 por default en Nest**, no 200. Salvo `@HttpCode(200)` explícito en el
   controlador. Verificá el status REAL leyendo el controlador; si el plan dice 200 pero el código
   devuelve 201, el test asserta 201 (el código es la fuente de verdad) y lo dejás comentado.
2. **`mockRestore()`/`mockReset()` limpian `mock.calls`.** Leé lo que capturó el spy ANTES de
   restaurarlo.
3. **El `ValidationPipe` global ya está aplicado** por `createTestApp` (whitelist +
   forbidNonWhitelisted + transform). Los casos de "400 por campo fuera del DTO" funcionan.
4. **Campos únicos GLOBALES de `User`** (`email`, `phone`, `internalPhone`, `invgateUserId`) y el
   `slug` de `Tenant`: usá `uniqueEmail()/uniquePhone()/uniqueSlug()` o valores propios del spec —
   nunca un literal que otro archivo pueda repetir (todos los specs comparten la misma base).
5. **Settings son globales** (`Setting.key` único): seteá en `beforeEach`, limpiá en `afterEach`.
6. **Fundá cada assert leyendo el código real** del endpoint/guard/nodo (orientate con
   `graphify query "<pregunta>"`, pero confirmá en el código). Nunca por el nombre del caso.
7. **Mockeá solo la frontera externa.** El endpoint, el guard, el motor de flujos se ejercitan de
   verdad. Mockear la lógica bajo prueba vacía el test.
8. El header del tenant es `X-Tenant-Id`. La cadena estándar es
   `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)`; sin `X-Tenant-Id` y con >1 membresía → 400;
   permiso faltante → 403 "Permiso denegado: recurso:acción".
