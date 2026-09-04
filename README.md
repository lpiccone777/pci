# PCI Chatbot — Soporte Omnicanal con IA

Chatbot de soporte inteligente con arquitectura multitenant, RBAC dinámico y capacidad de conectarse a múltiples canales de mensajería (iniciando con WhatsApp). El sistema funciona como asistente virtual de primera línea, resolviendo incidencias vía LLM o derivando a agentes humanos mediante tickets en Invgate.

---

## 🚀 Requisitos previos

| Herramienta | Versión recomendada | Notas |
|-------------|---------------------|-------|
| Node.js | 20.x LTS | [Descargar](https://nodejs.org/) |
| pnpm | 9.x o superior | `npm install -g pnpm` |
| PostgreSQL | 15+ | Servidor compartido o local |
| RabbitMQ | 3.12+ | Servidor compartido o local |
| Git | 2.40+ | — |

### Opcional (para desarrollo local)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) si prefieres levantar PostgreSQL y RabbitMQ en contenedores.

---

## 📦 Instalación inicial

### 1. Clonar el repositorio

```bash
git clone <url-del-repo>
cd pci-chatbot
```

### 2. Instalar dependencias

Este proyecto usa **pnpm workspaces**. Instala todas las dependencias desde la raíz:

```bash
pnpm install
```

Esto instalará dependencias para `apps/api` (NestJS) y `apps/web` (Next.js) automáticamente.

### 3. Configurar variables de entorno

Copia el archivo de ejemplo en cada app:

```bash
cp .env.example apps/api/.env
cp .env.example apps/web/.env
```

Edita los archivos `.env` con las credenciales reales. Como mínimo necesitas:

```env
# --- Base de datos ---
DATABASE_URL=postgresql://USUARIO:PASSWORD@localhost:5432/pci_chatbot

# --- Broker ---
RABBITMQ_URL=amqp://USUARIO:PASSWORD@localhost:5672

# --- Seguridad ---
JWT_SECRET=un-seguro-muy-largo-y-aleatorio
OTP_TTL_SECONDS=300
DEVICE_FINGERPRINT_TTL_DAYS=30

# --- LLM (configurar al menos un proveedor) ---
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

# --- Invgate ---
INVGATE_API_URL=https://tu-instancia.invgate.net/api
INVGATE_API_USER=usuario-tecnico
INVGATE_API_KEY=...

# --- WhatsApp Business API ---
WHATSAPP_API_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
```

> ⚠️ **Nunca commitees archivos `.env` con credenciales reales.** Están en `.gitignore` por defecto.

### 4. Configurar la base de datos

```bash
cd apps/api

# Generar el cliente Prisma
npx prisma generate

# Ejecutar migraciones (crear tablas)
npx prisma migrate dev --name init

# (Opcional) Sembrar datos de prueba
pnpm db:seed
```

### 5. Iniciar el proyecto en modo desarrollo

Desde la **raíz del monorepo** puedes levantar ambas aplicaciones:

```bash
# Terminal 1 — Backend API
pnpm dev:api

# Terminal 2 — Frontend Web
pnpm dev:web
```

O por separado:

```bash
cd apps/api && pnpm start:dev      # NestJS en http://localhost:3000
cd apps/web && pnpm dev            # Next.js en http://localhost:3001
```

---

## 🏗️ Estructura del proyecto

```
pci-chatbot/
├── apps/
│   ├── api/                        # Backend — NestJS
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # Modelo de datos
│   │   │   ├── migrations/         # Migraciones aplicadas
│   │   │   └── seed.ts             # Datos iniciales (tenant, SuperAdmin, settings)
│   │   ├── src/
│   │   │   ├── common/             # Interceptor de tenant, decorators compartidos
│   │   │   ├── config/             # AppConfigService (cascada BD → env → default)
│   │   │   ├── prisma/             # PrismaService/PrismaModule (global)
│   │   │   └── modules/
│   │   │       ├── auth/           # Registro, login, OTP 2FA, JWT, fingerprint
│   │   │       ├── users/          # Gestión de usuarios
│   │   │       ├── tenants/        # Multitenant
│   │   │       ├── rbac/           # Roles, permisos, guard y decorator
│   │   │       ├── settings/       # Configuración del sistema (solo superusuario)
│   │   │       ├── conversations/  # Orquestador: motor IVR + fallback LLM
│   │   │       ├── flow/           # CRUD de flujos conversacionales (ReactFlow)
│   │   │       ├── llm/            # Capa de abstracción LLM + 5 providers
│   │   │       ├── channels/       # Conectores de canal (WhatsApp)
│   │   │       ├── broker/         # RabbitMQ (productores/consumidores)
│   │   │       ├── devices/        # ⏳ stub — el fingerprint hoy vive en auth/
│   │   │       ├── invgate/        # ⏳ stub — integración pendiente
│   │   │       └── metrics/        # ⏳ stub — auditoría pendiente
│   │   └── .env
│   └── web/                        # Frontend — Next.js
│       ├── src/
│       │   ├── app/                # App Router (login, dashboard, flows, roles, settings…)
│       │   ├── components/         # Sidebar, auth guard, nodos/aristas de ReactFlow
│       │   ├── hooks/              # useAuth / AuthProvider
│       │   └── lib/                # Cliente HTTP con inyección de JWT
│       └── .env
├── docs/
│   ├── chatbot.md                  # Especificación completa del proyecto
│   └── plan-de-trabajo.md          # Estado por hito (documento vivo)
├── graphify-out/                   # Grafo de conocimiento del codebase
├── AGENTS.md                       # Convenciones y constraints para agentes
├── package.json                    # Scripts del monorepo
├── pnpm-workspace.yaml             # Configuración de workspaces
└── .env.example                    # Variables de entorno de ejemplo
```

---

## 🔧 Scripts disponibles

### Raíz del monorepo

| Script | Descripción |
|--------|-------------|
| `pnpm dev:api` | Levanta el backend NestJS en modo watch |
| `pnpm dev:web` | Levanta el frontend Next.js en modo desarrollo |
| `pnpm build` | Compila todas las aplicaciones |

### Backend (`apps/api`)

| Script | Descripción |
|--------|-------------|
| `pnpm start:dev` | NestJS con hot-reload |
| `pnpm build` | Compilación de producción |
| `pnpm test` | Ejecuta tests unitarios |
| `pnpm test:e2e` | Ejecuta tests end-to-end |
| `pnpm lint` | ESLint con auto-fix |
| `pnpm format` | Prettier sobre archivos fuente |
| `pnpm db:seed` | Ejecuta el seed de Prisma |

### Frontend (`apps/web`)

| Script | Descripción |
|--------|-------------|
| `pnpm dev` | Next.js con hot-reload |
| `pnpm build` | Compilación de producción |
| `pnpm start` | Servidor de producción |
| `pnpm lint` | ESLint |

---

## 🗄️ Modelo de datos principal

El sistema gestiona las siguientes entidades clave (ver `apps/api/prisma/schema.prisma`):

- **Users, Tenants, Roles, Permissions** — RBAC dinámico y multitenant
- **Devices** — Fingerprint de dispositivos con expiración configurable
- **Conversations, Messages** — Historial de chats por canal
- **Tickets** — Sincronización con Invgate
- **Metrics** — Registro de cada interacción para futuros dashboards
- **Flows** — Flujos conversacionales diseñados con ReactFlow
- **Settings** — Configuración por tenant

---

## 🔐 Convenciones importantes del proyecto

### Multitenant
Todo dato está aislado por `tenantId`. Cada query a base de datos debe incluir el filtro de tenant. Un usuario puede pertenecer a múltiples tenants.

El **tenant activo viaja por el header `X-Tenant-Id`**, no dentro del JWT. El token identifica a la persona (`{ sub, email }`) y nada más; `TenantGuard` valida en cada request que el usuario pertenezca al tenant pedido. Así, cambiar de empresa en el selector del sidebar no requiere volver a loguearse.

Los controladores que manejan datos por tenant usan siempre esta cadena, en este orden:

```ts
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
```

`TenantGuard` es un guard y no un interceptor porque en NestJS los guards corren primero, y `RolesGuard` necesita el tenant ya resuelto. Si el usuario pertenece a un solo tenant el header es opcional; con varios es obligatorio.

### RBAC dinámico
Los roles y permisos se crean desde el backend, no están hardcodeados. El frontend construye menús y botones en función del array de permisos del rol del usuario.

### Capa de abstracción LLM
Nunca llames directamente a los SDK de OpenAI, Gemini o Claude desde la lógica de negocio. Siempre usa el servicio de LLM del backend (`apps/api/src/llm/`), que permite cambiar de proveedor sin impacto.

### Desacoplamiento de canales
El core no conoce detalles de WhatsApp. Toda comunicación con canales externos fluye a través de RabbitMQ.

### Invgate
Las operaciones de ticket usan un **usuario técnico** con credenciales API, nunca las credenciales del usuario final.

### Secrets
Las API keys de LLM e Invgate solo se configuran mediante variables de entorno. No se commitean nunca, y **nunca** se guardan en la tabla `Setting` ni se exponen por `/settings`.

---

## 👥 Gestión de usuarios (`/dashboard/users`)

ABM de usuarios en dos modos: **por empresa** (el tenant activo del sidebar) o **multiempresa**, desde la vista **"Todas las empresas"** del selector.

| Método | Ruta | Permiso | Notas |
|--------|------|---------|-------|
| `GET` | `/users` | `users:read` | Usuarios del tenant activo, con el rol que tienen *en ese* tenant |
| `GET` | `/users/all` | `users:read` + tenant de sistema | Todas las empresas — solo superadmin (`SystemTenantGuard`) |
| `GET` | `/users/mine` | por empresa | Todas las empresas del propio usuario (las que puede ver) |
| `GET` | `/users/:id` | `users:read` | |
| `GET` | `/users/:id/memberships` | por empresa | Persona + sus membresías, para poblar el editor multiempresa |
| `GET` | `/users/check-availability` | por empresa | Chequea en vivo si un dato único ya está en uso |
| `POST` | `/users` | `users:create` | Alta en el tenant activo (`email`, `firstName`, `lastName`, `password`, `roleId` obligatorios) |
| `POST` | `/users/multi` | por empresa | Alta de una persona en varias empresas a la vez |
| `PATCH` | `/users/:id` | `users:update` | Edita nombre, apellido, teléfono, interno, rol o contraseña en el tenant activo. El email no se edita |
| `PATCH` | `/users/:id/full` | por empresa | Edita datos de la persona + sus membresías en varias empresas |
| `DELETE` | `/users/:id` | `users:delete` | Da de baja del tenant activo |

> **"por empresa"** = son rutas cross-tenant (los destinos vienen en el body o del propio usuario, no del header `X-Tenant-Id`), así que no llevan un `@RequirePermission` fijo: la autorización se valida **empresa por empresa dentro del servicio** —que puedas crear, editar o borrar usuarios en cada una—.

**La vista "Todas las empresas" es consolidada:** una fila por membresía, con columna *Empresa* y filtro. El superadmin (`/users/all`) ve todo el sistema; un usuario común (`/users/mine`) ve solo las empresas donde su rol tiene `users:read`.

**Alta y edición son multiempresa.** Desde el editor das de alta o modificás a una persona en varias empresas de una vez, cada una con su propio rol y área. Ya no hace falta cambiar de empresa en el sidebar para sumar a alguien a otra: elegís los destinos en el mismo formulario. Si el email ya existe en el sistema, en vez de fallar se reutiliza la persona y se le agrega la membresía nueva.

**Nombre y apellido son campos separados** (`firstName` / `lastName`). La migración `20260803120000_split_user_name` partió la columna `name` preservando los datos existentes.

**El rol es obligatorio.** Todo usuario entra a una empresa con un rol asignado (`UserTenant.roleId`), y el backend valida que el rol pertenezca a esa empresa — si no, se podrían filtrar permisos entre empresas. Si la empresa todavía no tiene roles, la pantalla avisa y bloquea el alta.

**Cuatro datos son únicos en todo el sistema:** email, teléfono, interno telefónico e ID de Invgate. El formulario los chequea en vivo (`/users/check-availability`) y, si el valor ya está tomado, avisa **quién lo usa** —o "un usuario de otra empresa" si está en una empresa que no administrás—.

**El interno telefónico** (`internalPhone`) es un campo opcional nuevo por persona, pensado para un futuro voicebot que enrute por interno; hoy solo se carga. Vive en la persona y no en la membresía: es el mismo sin importar en qué empresa esté.

**La baja nunca borra la fila.** Quitar a alguien de una empresa borra su membresía; si con eso queda sin ninguna, se le da de baja lógica: se le marca `deletedAt` y se le agrega un sufijo con la fecha y hora (`_20260811-143205`) al nombre, al apellido y a los cuatro campos únicos —email, teléfono, interno e identificador de Invgate—. Ese sufijo es lo que **libera esos datos**: se pueden volver a usar en un alta nueva sin que el sistema los rechace.

**No hay reactivación.** Quien vuelve, vuelve como una persona nueva: se lo da de alta otra vez y arranca sin historial. El historial de la persona anterior (conversaciones, tickets y métricas) sigue apuntando a la fila dada de baja, así que la auditoría queda intacta. Un usuario dado de baja tampoco puede iniciar sesión, y su sesión abierta se corta en el siguiente `/auth/me`. Tampoco podés darte de baja a vos mismo.

---

## 💬 Probar el bot sin WhatsApp

### Chat interactivo por consola

```bash
pnpm dev:api                  # en una terminal
pnpm --filter api chat        # en otra
```

Escribís y te contesta, igual que si fuera WhatsApp. Por defecto resuelve solo el tenant (la empresa más antigua) y el teléfono de prueba.

| Comando | Qué hace |
|---------|----------|
| `/estado` | Muestra en qué flujo y nodo quedó la conversación, y las variables del `flowState` |
| `/reset` | Cierra la conversación: la próxima arranca desde el inicio del flujo |
| `/salir` | Termina |

Opciones: `pnpm --filter api chat -- --tenant <id> --from +5491100000001 --api http://localhost:3001`

Con `--route` no se fija ninguna empresa: el mensaje se rutea por la **membresía del teléfono** (`--from`), igual que un canal real — una empresa → directo, varias → te muestra el **selector de empresa** (respondés con el número), ninguna → el tenant de sistema. Sirve para probar el ruteo nuevo sin WhatsApp.

### Un solo mensaje, por HTTP

```powershell
Invoke-RestMethod -Uri "http://localhost:3001/conversations/simulate" -Method Post `
  -ContentType "application/json" -Body (@{
    from     = "+5491100000001"
    body     = "hola, no puedo entrar al sistema"
    tenantId = "<id-del-tenant>"
  } | ConvertTo-Json)
```

`tenantId` es **opcional**: si lo omitís, el mensaje se rutea por la membresía del teléfono (`from`) igual que un canal real —incluido el selector de empresa para números multitenant, que vuelve como texto en `reply`—; si lo pasás, prueba el flujo de esa empresa puntual y saltea el ruteo.

`POST /conversations/simulate` **devuelve la respuesta del bot** en el campo `reply`. A diferencia de una llamada directa, el mensaje pasa por **RabbitMQ de punta a punta**: publica en una cola propia (`whatsapp.simulate.incoming`, separada de la real `whatsapp.incoming`) y espera —a través del broker, no en memoria— la respuesta que el mismo `ConversationsService.handleMessage` publica de vuelta. Es la simulación real, no un atajo.

Internamente usa el patrón RPC estándar de RabbitMQ: `correlationId` + una cola de respuesta exclusiva de esa conexión (`BrokerService.request()` en `broker.service.ts`). Si no llega respuesta en 90 segundos, el endpoint devuelve `504 Gateway Timeout` con el motivo.

> El endpoint no tiene autenticación. Está bien mientras el proyecto no sea funcional, pero **hay que cerrarlo antes de exponer el API** (ver deuda técnica en el plan de trabajo).

### Qué esperar

Si el tenant tiene un flujo IVR activo, manda el flujo; si no, responde el orquestador LLM. Con `/estado` ves cuál de los dos está actuando: `flujo: (ninguno)` significa que contesta el LLM directamente.

---

## ⚙️ Configuración del sistema (`/settings`)

Parámetros que se pueden cambiar **sin redeploy**, guardados en la tabla `Setting`. El valor efectivo se resuelve en cascada: **BD → variable de entorno → default del catálogo**.

### Autenticación y 2FA

| Clave | Tipo | Default | Qué controla |
|-------|------|---------|--------------|
| `OTP_ENABLED` | booleano | `true` | Si está desactivado, el login emite el JWT sin pedir OTP |
| `OTP_TTL_SECONDS` | número (60–3600) | `300` | Validez del código OTP |
| `OTP_CODE_LENGTH` | número (4–8) | `6` | Cantidad de dígitos del código |

> Si `OTP_ENABLED` nunca se fijó (ni en BD ni en `.env`), en `NODE_ENV=development` queda **desactivado**. Antes esto era un `if (process.env.NODE_ENV === 'development')` hardcodeado en `AuthService`; ahora es un parámetro explícito y conmutable desde la UI.

### Dispositivos

| Clave | Tipo | Default | Qué controla |
|-------|------|---------|--------------|
| `DEVICE_FINGERPRINT_TTL_DAYS` | número (1–365) | `90` | Días antes de volver a pedir 2FA |

### LLM — general

| Clave | Tipo | Default | Qué controla |
|-------|------|---------|--------------|
| `LLM_PROVIDER` | enum | `openai` | Proveedor activo: `openai`, `gemini`, `claude`, `openrouter`, `opencodego` |
| `LLM_TEMPERATURE` | número (0–2) | `0.7` | Temperature de las completions |
| `LLM_MAX_TOKENS` | número | `1024` | Máximo de tokens de respuesta |
| `LLM_SYSTEM_PROMPT` | texto | — | System prompt por defecto |

### LLM — configuración por proveedor

Cada proveedor tiene su propio grupo en la pantalla, con su API key, su modelo y —donde aplica— su host:

| Proveedor | Claves |
|-----------|--------|
| OpenAI | `OPENAI_API_KEY` 🔒, `OPENAI_MODEL`, `OPENAI_BASE_URL` (opcional, para proxies) |
| Gemini | `GEMINI_API_KEY` 🔒, `GEMINI_MODEL` |
| Claude | `ANTHROPIC_API_KEY` 🔒, `ANTHROPIC_MODEL` |
| OpenRouter | `OPENROUTER_API_KEY` 🔒, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL` |
| OpenCode Go | `OPENCODEGO_API_URL` (host), `OPENCODEGO_API_KEY` 🔒, `OPENCODEGO_MODEL` |

`GET /settings/providers/status` devuelve qué proveedor está activo y a cuáles les falta configuración. La pantalla lo usa para avisarte *antes* de que falle un mensaje real: si elegís `opencodego` sin cargar el host, te lo dice ahí mismo.

### Selección de modelo

El campo **Modelo** es un dropdown que se llena consultando la API del propio proveedor:

`GET /settings/providers/:provider/models` (agregá `?refresh=true` para saltear la caché de 5 minutos)

| Proveedor | Endpoint consultado | Necesita la key cargada |
|-----------|--------------------|--------------------------|
| OpenAI | `{base}/models` | sí |
| OpenRouter | `{base}/models` | **no** — el catálogo es público (~340 modelos) |
| Gemini | `v1beta/models` | sí — filtra los que soportan `generateContent` |
| Claude | `api.anthropic.com/v1/models` | sí |
| OpenCode Go | `{host}/config/providers` | no |

Si la consulta falla —falta la key, timeout, host mal configurado, API no compatible— **el dropdown no queda vacío**: cae a una lista conocida y muestra en amarillo por qué no pudo consultar. Se filtran los modelos que no sirven para chat (embeddings, whisper, tts, dall-e, moderation).

> **opencode no es compatible con OpenAI.** No expone `/models`, y su interfaz web responde **HTML con status 200** a cualquier ruta desconocida — por eso un `fetch` ingenuo parece exitoso y recién falla al parsear. El catálogo real está en `GET {host}/config/providers`, con la forma `{ providers: [{ id, models: { "<modelId>": {...} } }] }`. Devolvemos los modelos como `providerID/modelID` porque opencode los direcciona por ese par y un mismo modelo puede venir de varios proveedores configurados en esa instancia.
>
> Por eso `requestJson()` valida el `content-type` antes de parsear: sin eso el usuario veía `Unexpected token '<'`, que no dice nada. Ahora dice que la URL apunta a una interfaz web y no a la API.

### OpenCode Go: cómo funciona el provider

opencode trabaja con **sesiones**, no con completions sueltas. Cada consulta hace:

```
POST   /session                    → crea la sesión
POST   /session/{id}/message       → { model: {providerID, modelID}, agent, system, parts: [{type:'text', text}] }
DELETE /session/{id}               → limpia
```

**Sesión efímera por consulta, a propósito.** `LlmProvider` es una interfaz sin estado: recibe el historial completo y devuelve texto. Mantener una sesión de opencode por `Conversation` obligaría a persistir el `sessionID` y a romper esa interfaz para todos los proveedores. Como igual mandamos el historial en cada llamada, el contexto no se pierde: lo administra nuestro orquestador.

La respuesta trae partes de varios tipos (`step-start`, `reasoning`, `text`, `step-finish`). **Solo se usan las de tipo `text`** — `reasoning` es el razonamiento interno del modelo y no debe llegarle al usuario.

> ⚠️ **El agent importa por seguridad.** El default de opencode es `build`, que *ejecuta herramientas* sobre la máquina donde corre el servidor. Para un bot que atiende usuarios finales eso es un riesgo, así que `OPENCODEGO_AGENT` viene con default **`plan`**, que no permite edición. Los agents disponibles se listan con `GET {host}/agent`.

> ⚠️ **`temperature` y `maxTokens` no aplican.** La API de mensajes de opencode no los expone, así que esos parámetros de `/settings` no tienen efecto con este proveedor. El `systemPrompt` sí se respeta.

opencode es un asistente de programación: si el system prompt no establece una persona clara, sus respuestas van a sonar a asistente de código. Con un system prompt de soporte bien escrito responde como corresponde — verificado contra los agents `build`, `general` y `plan`.

La opción **"Otro — escribir a mano"** del dropdown permite poner un modelo que no esté en la lista, y si el valor guardado no aparece en el catálogo se agrega igual como opción marcada `(actual)`, para no perderlo nunca. Al guardar una API key o un host, la lista se refresca sola.

Al entrar a la pantalla solo se consultan los modelos del **proveedor activo**: consultar los cinco sería una ráfaga de llamadas externas para configurar uno solo. Los demás tienen un botón **Buscar modelos**.

### 🔒 Manejo de las API keys

Las claves marcadas con 🔒 son **secrets** y tienen tratamiento especial:

- Se guardan **cifradas** en la BD con AES-256-GCM. La clave maestra es `SETTINGS_ENCRYPTION_KEY` y vive **solo** en `apps/api/.env`.
- Son de **solo escritura**: `GET /settings` nunca devuelve el valor, solo un enmascarado (`sk-•••••abcd`) y `isSet: true`. Por eso el campo aparece vacío en la pantalla aunque haya una key cargada — escribir algo la reemplaza, dejarlo vacío no la toca.
- **Sin `SETTINGS_ENCRYPTION_KEY` el backend rechaza guardarlas.** Preferimos fallar antes que dejar una API key legible en la base. Generala así:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ Si rotás `SETTINGS_ENCRYPTION_KEY`, los secrets ya guardados dejan de poder descifrarse (el tag GCM no valida) y hay que volver a cargarlos.

Esto es una desviación deliberada de la spec §5, que pedía las API keys solo en env vars o vault. Se aceptó para poder configurar los proveedores desde el backoffice, acotando el riesgo con cifrado en reposo y campos de solo escritura. Las credenciales de **Invgate siguen siendo solo env var**.

El catálogo vive en `apps/api/src/modules/settings/settings.catalog.ts`. Cualquier clave fuera del catálogo se rechaza con `400`.

### Pantalla de configuración

La UI está en **`/settings`** (ruta raíz, fuera de `/dashboard`, aunque comparte el sidebar). Muestra los parámetros agrupados, con un badge por clave indicando de dónde sale el valor efectivo —`guardado en BD`, `desde .env` o `valor por defecto`— y un botón **Restaurar** que borra la fila de BD para que la clave vuelva a resolverse por env o default.

El ítem "Configuración" del sidebar solo aparece si el usuario tiene `settings:read` **y** su tenant activo es el de sistema (`NEXT_PUBLIC_SYSTEM_TENANT_SLUG`, que debe coincidir con `SYSTEM_TENANT_SLUG` del backend).

### Endpoints

| Método | Ruta | Permiso |
|--------|------|---------|
| `GET` | `/settings` | `settings:read` |
| `GET` | `/settings/:key` | `settings:read` |
| `POST` | `/settings` | `settings:create` |
| `PATCH` | `/settings/:key` | `settings:update` |
| `DELETE` | `/settings/:key` | `settings:delete` — borra la fila de BD; la clave vuelve a env/default |

`GET /settings` devuelve, por cada clave, el valor efectivo y su `source` (`db` / `env` / `default`), para que el backoffice muestre qué está realmente sobrescrito.

### Acceso: solo superusuario

Doble candado, ambos obligatorios:

1. **`SystemTenantGuard`** — el tenant activo del JWT debe ser el tenant de sistema (`SYSTEM_TENANT_SLUG`, default `system`, creado por el seed).
2. **`@RequirePermission('settings', <action>)`** — el seed asigna los permisos `settings:*` únicamente al rol `SuperAdmin`.

El primer candado es el que importa: como `Setting.key` es único a nivel global, un cambio afecta a todos los tenants. Sin él, cualquier admin de tenant con `roles:create` + `permissions:create` podría auto-asignarse `settings:update` y tocar la configuración de todos. El corte es por tenant de sistema y no por nombre de rol, para no violar el constraint de RBAC dinámico.

> **Limitación conocida:** `Setting.key` es `@unique` global en el schema, así que hoy los settings son globales aunque el modelo tenga columna `tenantId`. Para settings por tenant hay que migrar a `@@unique([key, tenantId])` y ajustar los `findUnique` de `AppConfigService` y `LlmProviderFactory`.

---

## 🐛 Solución de problemas comunes

### Error de conexión a PostgreSQL
- Verifica que `DATABASE_URL` incluya el nombre correcto de base de datos.
- Asegúrate de que la base de datos `pci_chatbot` exista (`CREATE DATABASE pci_chatbot;`).

### Error de conexión a RabbitMQ
- Confirma que RabbitMQ esté corriendo y accesible en el puerto 5672.
- Si usas Docker: `docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management`

### Prisma no encuentra el esquema
Ejecuta siempre `npx prisma generate` desde `apps/api` después de cualquier cambio en `schema.prisma`.

---

## 📚 Documentación adicional

- [Especificación completa del proyecto](./docs/chatbot.md)
- [Grafo de conocimiento del codebase](./graphify-out/GRAPH_REPORT.md)
- [Prisma ORM docs](https://www.prisma.io/docs/)
- [NestJS docs](https://docs.nestjs.com/)
- [Next.js docs](https://nextjs.org/docs/)

---

## 🕸️ Grafo de conocimiento

El repo mantiene un grafo navegable del codebase en `graphify-out/`:

- `graph.html` — visualización interactiva, se abre en cualquier navegador
- `GRAPH_REPORT.md` — reporte de comunidades y auditoría
- `graph.json` — datos crudos, listos para GraphRAG

Para preguntarle algo al grafo en vez de leer el código a mano:

```bash
graphify query "¿cómo se procesa un mensaje entrante de WhatsApp?"
```

### ⚠️ Ante todo cambio, actualizá el grafo

**Todo cambio en el repo — código, docs, schema o configuración — obliga a actualizar el grafo antes de dar la tarea por terminada:**

```bash
/graphify . --update
```

Es incremental: solo re-extrae lo que cambió, y si los cambios son puramente de código no consume tokens de LLM (extracción AST). Un grafo desactualizado es peor que no tener grafo, porque quien lo consulte después va a razonar sobre un proyecto que ya no existe.

---

## 🤝 Contribución

1. Crea una rama desde `main`: `git checkout -b feature/nombre-feature`
2. Realiza tus cambios siguiendo las convenciones del proyecto (ver [AGENTS.md](./AGENTS.md)).
3. Asegúrate de que `pnpm lint` y `pnpm test` pasen en la app correspondiente.
4. Actualiza `docs/plan-de-trabajo.md` si cambió el estado de algún hito.
5. **Actualiza el grafo:** `/graphify . --update`
6. Abre un Pull Request con descripción clara del cambio.

---

## 📄 Licencia

Proyecto privado — PCI.
