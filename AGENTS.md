# AGENTS.md

## ⚠️ Regla obligatoria: actualizar el grafo ante todo cambio

**Después de cualquier cambio en el repo — código, docs, schema, configuración — hay que actualizar el grafo de conocimiento antes de dar la tarea por terminada.**

```bash
/graphify . --update
```

Es incremental: solo re-extrae los archivos nuevos o modificados. Si los cambios son
únicamente de código, ni siquiera consume tokens de LLM (extracción AST pura).

Aplica a todos: agentes y personas. Un grafo desactualizado es peor que no tener grafo,
porque el próximo que lo consulte va a razonar sobre una versión del proyecto que ya no
existe. Ya pasó una vez: el módulo Flow/IVR completo quedó fuera del grafo y fuera del
plan de trabajo durante días.

Checklist de cierre de cualquier tarea:
1. `pnpm --filter api run build` (y `--filter web` si tocaste el frontend)
2. Actualizar `docs/plan-de-trabajo.md` si cambió el estado de un hito
3. `/graphify . --update`
4. Commit

---

## Estado del repo

Monorepo pnpm en desarrollo activo. Hitos 0–3 sustancialmente completos.

- `apps/api` — NestJS 11 + Prisma 5.22 + PostgreSQL. Módulos de dominio en `src/modules/`
- `apps/web` — Next.js 16 + React 19 + Tailwind 4. App Router en `src/app/`
- `docs/chatbot.md` — spec original (español), **fuente de verdad** de alcance y arquitectura
- `docs/plan-de-trabajo.md` — estado por hito, documento vivo
- `graphify-out/` — grafo de conocimiento del codebase

Infra externa: PostgreSQL y RabbitMQ en `192.168.0.123`. No hay docker-compose.

## Convenciones confirmadas

- pnpm workspaces: `apps/api` (backend) + `apps/web` (frontend)
- Primer canal: WhatsApp Business API. OTP 2FA por email primero, SMS después
- Nomenclatura backend: `src/modules/<dominio>/` con `<dominio>.module.ts`, `.service.ts`,
  `.controller.ts`, y subcarpetas `dto/`, `guards/`, `decorators/` cuando hacen falta

## Decisiones cerradas (spec §7 — no re-litigar)

- Device fingerprint v1 = **teléfono + User-Agent solamente**
- Broker: **RabbitMQ** (elegido sobre LavinMQ)
- ORM: **Prisma**
- Tablas del modelo inicial: Users, Tenants, Roles, Permissions, Devices, Conversations,
  Tickets, Metrics (+ Settings, Flow, TenantFlow agregadas después)

## Constraints fáciles de violar — respetarlos en todo código generado

- **Multitenant:** el aislamiento por Tenant ID es obligatorio a nivel de BD; toda query
  debe estar scopeada por tenant. Un usuario puede pertenecer a varios tenants.
  El tenant activo **no va en el JWT** — ver "Resolución del tenant" más abajo.
- **RBAC dinámico:** roles y permisos son datos creados desde el backend, no código.
  Nunca hardcodear enums de rol ni chequeos contra nombres de rol fijos. Los menús y
  botones del frontend se arman a partir de la lista de permisos del rol.
- **Abstracción LLM:** la lógica de negocio nunca llama a un SDK de proveedor
  (OpenAI/Gemini/Claude) directamente — siempre vía `LlmService`. Temperature, max tokens,
  system prompt y proveedor son configurables.
- **Desacople de canales:** el orquestador core no puede depender de detalles de WhatsApp.
  Todo I/O de canal pasa por el broker (RabbitMQ, colas persistentes).
- **Invgate:** crear/leer/actualizar tickets va por un usuario técnico dedicado de API,
  nunca con credenciales del usuario final.
- **Secrets:** nunca commiteados y **nunca devueltos por la API en texto plano**.
  Las API keys de LLM se pueden cargar desde `/settings` (decisión explícita del usuario,
  2026-08-03), pero se guardan **cifradas** con AES-256-GCM y son de **solo escritura**:
  el `GET` devuelve un enmascarado y el flag `isSet`, jamás el valor. Ver "Secrets" abajo.
  Las credenciales de Invgate siguen siendo solo env var.

## Flujo de inicio por tenant

`TenantFlow.isStart` (no `Flow.isStart`): un mismo flujo puede estar asignado a varios
tenants y ser "de inicio" solo para algunos, así que el dato no puede vivir a nivel `Flow`.
La invariante "un tenant tiene como máximo un flujo de inicio" se aplica en
`FlowService.applyTenantAssignment` (transacción), no con una constraint de BD — Prisma no
soporta índices únicos parciales en el schema DSL. Si se toca esto: al marcar un flujo como
inicio para un conjunto de tenants hay que desmarcar cualquier OTRO flujo que lo fuera para
esos mismos tenants, sin tocar tenants fuera de la selección actual.

`Flow.isDefault` (preexistente) sigue vivo como fallback de compatibilidad: es un default
*global* del sistema entero, distinto conceptualmente de `isStart` (por tenant).
`findActiveFlowForTenant` primero busca por `isStart`, y solo cae a `isDefault` si el tenant
no tiene ningún flujo de inicio propio.

`GET /tenants/all` (todos los tenants, no solo el activo) está gateado con
`SystemTenantGuard`, que vive en `common/guards/` — se movió ahí desde
`modules/settings/guards/` porque dejó de ser específico de Settings. Cualquier operación
genuinamente cross-tenant (ver todos los tenants, configuración global) usa este guard, no
un permiso RBAC a secas: un permiso RBAC no alcanza porque un admin de tenant podría
auto-asignárselo.

## "Conocido" en el motor de flujos

`ConversationsService.handleMessage` resuelve `identity` (`isKnown`, `roleId`, `roleName`)
consultando `UsersService.findMembershipByPhone(phone, tenantId)` — **contra el registro
real de usuarios (`UserTenant` + `Role`), no contra si existe una fila en `User`**. Cualquier
número que escribe una vez por WhatsApp termina con una fila en `User` (el placeholder que
crea `findOrCreateByPhone`), así que "¿existe un `User` con este teléfono?" nunca sirve para
distinguir conocido de nuevo — siempre da que sí.

Ese chequeo se resuelve una sola vez, en `handleMessage`, **antes** de tocar
`findOrCreateByPhone`, y el resultado (`user` + `identity`) se enhebra por parámetro hasta
`executeNode`'s `case 'start'`. Si algún día hace falta este dato en otro nodo, agregarlo
como parámetro también — no volver a consultarlo ahí adentro. Repetir la consulta dentro del
nodo fue exactamente el bug original: para cuando se preguntaba, el usuario ya existía
porque un paso antes se lo había creado el propio `handleMessage`.

## Broker / RabbitMQ — patrón RPC

`BrokerService.request(queue, message, opts)` publica y **espera de verdad, a través del
broker**, la respuesta correlacionada (`/conversations/simulate` lo usa). Es el patrón RPC
estándar de RabbitMQ: cola de respuesta exclusiva por conexión + `correlationId` por
request. Si tocás esto, tres cosas que ya rompieron el flujo una vez cada una:

- **Nunca llamar `channel.ack()`/`channel.nack()` sin blindar.** Si el canal ya está
  cerrado (RabbitMQ cortó la conexión), esas llamadas tiran una excepción **sincrónica**
  dentro del callback de `consume()` — sin capturarla, tira abajo **todo el proceso Node**,
  no solo el mensaje en curso. Usar siempre `safeAck`/`safeNack`.
- **No declarar colas anónimas** (`assertQueue('', ...)`). RabbitMQ las nombra
  `amq.gen-*`, y `amq.*` es un prefijo reservado — muchos brokers (este incluido) rechazan
  que un cliente declare ahí. Usar un nombre propio (`whatsapp.rpc.reply.<uuid>`, patrón ya
  usado en `ensureReplyConsumer()`).
- **Al reafirmar una cola exclusiva, `publish()` tiene que saltear el `assertQueue`.**
  `publish()` reafirma con `{ durable: true }` a secas; una cola declarada `exclusive: true`
  reafirmada sin esa propiedad es, para RabbitMQ, una declaración con propiedades distintas
  → cierra el canal con 405 (RESOURCE_LOCKED) y la respuesta nunca llega. Por eso
  `publish()` acepta `{ assert: false }` — usarlo siempre que se publique contra una cola
  que el propio código ya declaró (como la de respuesta RPC).

## Fuentes de verdad (`ContextSource`)

Cada flujo puede vincularse a una fuente de verdad externa (MCP remoto, RAG, o webhook de
n8n) que el backoffice administra en `/dashboard/context-sources`. El catálogo de tipos y
campos vive en `context-source-types.catalog.ts` — mismo criterio que `settings.catalog.ts`:
única fuente de verdad de qué tipos y campos son válidos, y `ContextSourcesService` descarta
cualquier key de `config` que no esté declarada ahí para el `type` de esa fuente.

- **Por tenant, no por flujo:** `ContextSource` tiene `tenantId` (como `Area`) para poder
  reusar la misma fuente entre varios flujos de la empresa sin duplicar credenciales.
  `Flow.contextSourceId` es un FK simple y nullable — **un único valor por flujo**, no una
  relación N:N. Ver la limitación conocida más abajo.
- **Secrets dentro de `config` (Json):** los campos marcados `secret: true` en el catálogo se
  cifran con `SecretsCipher` (mismo mecanismo AES-256-GCM que `Setting`) antes de guardarse
  dentro del `Json`, y nunca se devuelven en claro por la API — el GET expone un enmascarado
  más `<campo>IsSet`, igual que los settings marcados `secret`. Un campo `secret` ausente en
  un `PATCH` significa "no tocar" (conserva el cifrado existente); mandarlo explícito en
  `null`/`''` lo borra.
- **Todo I/O externo pasa por el broker**, misma regla que WhatsApp (ver "Desacople de
  canales" en Constraints, y la sección Broker/RabbitMQ más abajo): `ContextSourcesController`
  nunca hace `fetch()` directo contra un MCP/RAG/n8n. "Probar conexión"
  (`POST /context-sources/:id/test-connection`) publica un `BrokerService.request()` a
  `context-source.test-connection`, y `ContextSourceConnectorService` —suscripto a esa cola
  desde `onModuleInit`, mismo patrón que `ConversationsService` con `whatsapp.incoming`— hace
  la llamada real y responde por el canal RPC. Hoy productor y consumidor viven en el mismo
  proceso; es el punto de extensión para cuando la consulta real se dispare desde el motor de
  flujos, potencialmente desde un worker separado.
- **No instalamos nada:** `config` son parámetros de conexión (URL + credenciales) a un
  servicio que ya corre en otro lado. No hay proceso local de MCP, RAG ni n8n en este repo.

**Limitación conocida:** `Flow` puede estar asignado a varios tenants a la vez (`TenantFlow`,
N:N), pero `ContextSource` es por tenant y `Flow.contextSourceId` es un único FK global del
flujo. Un flujo compartido entre dos empresas hoy usa la MISMA fuente de verdad (o ninguna)
para ambas — no hay forma de que cada tenant vea una fuente distinta. Si hace falta, la
solución es una tabla puente `FlowContextSource` con `tenantId` (mismo patrón que
`TenantFlow`), no forzar el FK actual. Ver `docs/plan-de-trabajo.md`, sección "Fuentes de
verdad — Ejecución real".

**Pendiente (deliberadamente fuera de esta etapa):** la ejecución real — que el motor de
conversaciones (`ConversationsService.executeNode`) consulte la fuente vinculada durante una
conversación — no está implementada. Lo que existe hoy es administración (CRUD + probar
conexión) y la vinculación flujo↔fuente. Ver `docs/plan-de-trabajo.md` para el detalle de qué
falta por tipo (handshake MCP, contrato de RAG, cola RPC dedicada para la consulta en vivo).

## Resolución del tenant

El JWT identifica **a la persona y nada más**: `{ sub, email }`. El tenant activo viaja
por el header **`X-Tenant-Id`** en cada request y lo resuelve `TenantGuard`
(`src/common/guards/tenant.guard.ts`), que valida la pertenencia contra `UserTenant` y deja
`request.tenantId` y `request.userTenant` para downstream.

Por qué no va en el JWT: un usuario puede pertenecer a varios tenants, y meter el tenant en
el token obligaba a reemitirlo para cambiar de empresa. En la práctica eso ya estaba roto —
el selector del sidebar cambiaba la UI pero el API seguía operando sobre el tenant viejo.

**`TenantGuard` es un guard y no un interceptor a propósito:** en NestJS los guards corren
antes que los interceptors, y `RolesGuard` necesita el tenant ya resuelto. El orden en los
controladores es siempre:

```ts
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
```

Reglas al escribir un controlador nuevo con datos por tenant:
- Incluí `TenantGuard` en la cadena, después de `JwtAuthGuard` y antes de `RolesGuard`.
  Sin él, `@CurrentTenant()` devuelve `null` y `RolesGuard` tira 403 explícito.
- Tomá el tenant de `@CurrentTenant()`. **Nunca** del body.
- Si el usuario pertenece a un solo tenant, el header es opcional. Con varios, es obligatorio
  y su ausencia devuelve 400.
- En el frontend, `apiFetch` (`lib/api.ts`) manda el header solo desde `localStorage`.
  Cualquier cliente HTTP nuevo tiene que hacer lo mismo.

## Configuración del sistema (`/settings`)

La tabla `Setting` guarda parámetros editables sin redeploy: 2FA (`OTP_ENABLED`,
`OTP_TTL_SECONDS`, `OTP_CODE_LENGTH`), TTL de fingerprint, y proveedor y parámetros de LLM.
Se resuelven en cascada: **BD → env var → default del catálogo** (`AppConfigService`,
`SettingsService`). UI en `/settings` (ruta raíz del frontend, no bajo `/dashboard`).

`OTP_ENABLED` reemplazó al `if (process.env.NODE_ENV === 'development')` que estaba
hardcodeado en `AuthService`. Si nunca se fijó valor, `AppConfigService.otpEnabled()`
mantiene el bypass en desarrollo, así que el comportamiento previo se conserva.

Acceso restringido a superusuario mediante **doble candado**:
1. `SystemTenantGuard` — el tenant activo del JWT debe ser el de sistema (`SYSTEM_TENANT_SLUG`, default `system`)
2. `@RequirePermission('settings', <action>)` — el seed solo se lo asigna al rol SuperAdmin

El corte es por tenant de sistema, no por nombre de rol, para no violar el constraint de
RBAC dinámico. Las claves editables están declaradas en `settings.catalog.ts`: cualquier
key fuera del catálogo se rechaza.

### Secrets en la tabla `Setting`

La spec §5 pedía que las API keys vivieran solo en env vars / vault. El usuario pidió
poder configurar cada proveedor de LLM completo desde el backoffice, así que se hizo una
concesión acotada, con estas reglas que hay que respetar al tocar este código:

- Una clave del catálogo marcada `secret: true` se guarda **cifrada** (AES-256-GCM,
  `SecretsCipher` en `src/config/secrets.cipher.ts`). La clave maestra es
  `SETTINGS_ENCRYPTION_KEY` y vive **solo** en el entorno.
- Sin `SETTINGS_ENCRYPTION_KEY` el backend **rechaza** guardar un secret. Nunca escribir
  una API key en texto plano en la BD como fallback.
- `GET /settings` **nunca** devuelve el valor: expone `value` enmascarado (`sk-•••••abcd`)
  y `isSet: boolean`. Son campos de solo escritura.
- Nunca loguear el valor de un secret. `SettingsService` ya lo evita explícitamente.
- `AppConfigService.get()` descifra de forma transparente, así que los consumidores
  (providers de LLM) reciben el valor en claro sin saber que estaba cifrado.
- Rotar `SETTINGS_ENCRYPTION_KEY` invalida los secrets guardados: el tag GCM deja de
  validar y hay que recargarlos desde `/settings`.

Los providers de LLM **no leen configuración por su cuenta**: `LlmProviderFactory` resuelve
API key, modelo y base URL, y se los pasa armados (`ResolvedProviderConfig`). Por eso ya no
llevan `@Injectable()` — no los instancia Nest.

`LlmModelsService` lista los modelos de cada proveedor consultando su API con la key
guardada (`GET /settings/providers/:provider/models`, caché de 5 min). Nunca falla duro:
ante error devuelve una lista conocida más el motivo, así el dropdown del backoffice no
queda vacío. Al sumar un proveedor nuevo hay que agregarlo también acá y en
`FALLBACK_MODELS`.

**OpenCode Go es el proveedor raro:** opencode (opencode.ai) no es compatible con OpenAI.
Trabaja con sesiones (`POST /session` → `POST /session/{id}/message` → `DELETE`), direcciona
los modelos por `providerID/modelID`, y su SPA devuelve HTML con status 200 en cualquier ruta
desconocida — por eso todo request valida el `content-type` antes de parsear. Su API no
expone `temperature` ni `maxTokens`. Al tocar este provider, dos cosas que no hay que romper:

- De la respuesta se usan **solo las partes de tipo `text`**. Las de tipo `reasoning` son el
  razonamiento interno del modelo y no deben llegarle nunca al usuario final.
- `OPENCODEGO_AGENT` define qué herramientas puede ejecutar opencode. El default de opencode
  es `build`, que **corre herramientas sobre la máquina del servidor**. Para un bot que
  atiende usuarios finales el default nuestro es `plan`. No cambiarlo sin pensarlo.

**Limitación conocida:** `Setting.key` es `@unique` global en el schema, así que hoy los
settings son globales aunque el modelo tenga columna `tenantId`. Para settings por tenant
hace falta migrar a `@@unique([key, tenantId])` y ajustar los `findUnique` de
`AppConfigService` y `LlmProviderFactory`.

## Idioma

Spec, docs, comentarios de código y comunicación con el usuario en **español**.

## Grafo de conocimiento (graphify)

- **Visualización interactiva:** `graphify-out/graph.html` — abrir en el navegador
- **Reporte de auditoría:** `graphify-out/GRAPH_REPORT.md`
- **Datos crudos:** `graphify-out/graph.json` — listo para GraphRAG

### Para agentes futuros

Antes de explorar el codebase a mano para responder sobre arquitectura, relaciones entre
archivos o contenido del proyecto, consultá el grafo:

```bash
graphify query "<pregunta>"
```

Si `graphify-out/graph.json` existe y la pregunta es sobre el codebase (no un comando de
rebuild), salteá detección y extracción: consultá el grafo directamente.

Dos advertencias sobre el grafo, aprendidas en carne propia:
- **Verificá contra el código** antes de afirmar algo importante. El grafo es un mapa, no
  el territorio, y puede estar desactualizado si alguien se salteó la regla de arriba.
- Los labels de comunidad de `GRAPH_REPORT.md` pueden aparecer desalineados respecto de
  los nodos que listan (bug conocido del renderer del reporte). Confiá en los nodos, no en
  el título de la sección.
