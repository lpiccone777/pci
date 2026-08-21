# 🧪 Plan de pruebas — PCI Chatbot

> **Actualizado hasta el commit `c2ebde8`** en la rama `juang-dev` — «Merge pull request #6 from
> lpiccone777/martin-dev» (2026-08-18). Incluye los canales Twilio y Gupshup (WhatsApp y SMS), la
> integración con InvGate y el modelo Skill por flujo.

Documento de casos de prueba del sistema. Tres secciones independientes:

- **[Sección 1 — Backend](#-sección-1--backend):** los módulos REST, la mecánica del
  broker RabbitMQ, la recepción del webhook y la **auditoría de seguridad**.
- **[Sección 2 — Chatbot](#-sección-2--chatbot):** el recorrido conversacional del motor
  de flujos IVR nodo por nodo, y el flujo de un mensaje de punta a punta.
- **[Sección 3 — Frontend](#-sección-3--frontend):** el panel Next.js pantalla por pantalla
  (login/OTP, ABM multiempresa, editor de flujos, `/settings`), el control de acceso por
  permisos en la UI, las validaciones en vivo y el comportamiento responsive.

Y tres apéndices: la **auditoría de seguridad** (A), las **matrices de comprobación** de
permisos y aislamiento (B), y el **juego de datos de prueba** sobre el que corre todo el plan (C).

Es un plan de **diseño**: describe qué probar, con qué precondición y qué resultado se
espera. No incluye la ejecución contra la infraestructura ni código de tests automatizados.

**Alcance:** cubre el **backend**, el **motor del chatbot** y la **capa de frontend web**
(Next.js). Su cobertura —incluida la superficie de seguridad propia del cliente— vive en la
Sección 3.

---

### Prioridad de un caso

La prioridad se asigna **por bloque**, no caso por caso: dentro de un bloque los casos comparten
riesgo, y una columna extra en 565 filas sería ruido más que ayuda. La columna **P** del tablero
la fija para cada bloque.

- **`P0` — bloqueante.** Autenticación, permisos, aislamiento entre empresas, secretos, datos de
  partida, y el camino por el que pasa toda conversación (pipeline, arranque, nodos y el
  recorrido de punta a punta). Si algo de acá falla, el sistema no se libera 🔴

- **`P1` — importante.** El resto de lo funcional: ABM, editor de flujos, broker, canales,
  proveedores de modelo, pantallas del panel. Un fallo acá se registra y se decide, no frena
  automáticamente 🟠

- **`P2` — deseable.** Comportamiento responsive. Se ejecuta si hay margen 🟢

**Los 35 casos invertidos son `P0` por definición**, sin importar en qué bloque
estén: describen el comportamiento seguro que hoy no existe. Liberar con alguno en `❌` es una
decisión de riesgo tomada a propósito, no un descuido del tablero.

### Entorno de pruebas

- **PostgreSQL** y **RabbitMQ** accesibles (en desarrollo, `localhost`; la infra compartida
  vive en otra máquina). La URL del broker es `RABBITMQ_URL`; sin ella el módulo no arranca.
- **Seed aplicado** (`pnpm --filter api db:seed`): deja el tenant de sistema, el rol
  `SuperAdmin`, el usuario `admin@pci.local` y los settings base. Es idempotente.
- **`SETTINGS_ENCRYPTION_KEY`** cargada en el entorno para poder probar secretos.
- **`JWT_SECRET`** cargada (si falta, el backend no arranca).
- **Escenario de datos armado** según el **Apéndice C**: empresas, roles, personas, áreas,
  flujos y fuentes de verdad concretos. Las precondiciones de cada bloque los dan por
  existentes; sin ese escenario la mayoría de los casos no son ejecutables tal como están
  escritos.

### Herramientas de ejecución

- **REST** (Postman/Insomnia/`curl`): para todos los casos `BE-*`. Recordar el header
  `Authorization: Bearer <token>` y, cuando el usuario pertenece a varias empresas, el header
  `X-Tenant-Id`.
- **`POST /conversations/simulate`** con `{ from, body, tenantId }`: inyecta un mensaje que
  atraviesa RabbitMQ de punta a punta. Es la vía principal para los casos `CHAT-*`.
- **Chat por consola** (`pnpm --filter api chat`): REPL sobre el mismo endpoint `simulate`.
  Comandos `/reset`, `/estado`, `/salir`. Útil para recorrer flujos a mano.

### Smoke test de arranque (antes de todo)

Antes de correr el plan completo conviene pasar esta secuencia mínima: si algo de acá falla, el
resto de los casos no son ejecutables y no tiene sentido seguir. No agrega IDs nuevos —reusa casos
que ya existen— sino que fija el orden de arranque:

1. **Build de la API** (`pnpm --filter api run build`): compila sin errores.
2. **Migraciones + seed** sobre la base de trabajo (BE-DAT-01, BE-DAT-02): el esquema queda al día
   y el seed deja el tenant de sistema, el rol `SuperAdmin`, `admin@pci.local` y los settings base.
3. **Salud del proceso** (BE-APP-01): `GET /` responde 200 con RabbitMQ conectado (sin `RABBITMQ_URL`
   el módulo del broker no arranca).
4. **Login del administrador** (BE-AUTH-01) y **`GET /auth/me`** (BE-AUTH-13): se obtiene un token y
   el catálogo completo de permisos del SuperAdmin.

Recién con estos cuatro pasos en verde se monta el escenario del **Apéndice C** y se arranca con el
resto del plan.

---

## 📊 Resumen de cobertura (casos por bloque)

Foto de cobertura. Los números son la **cantidad de casos** por bloque y la columna **P**
es la prioridad del bloque.
Total del plan: **568 casos** · Backend 312 · Chatbot 142 · Frontend 114 · de los cuales **275 son `P0`**
(259 por la prioridad del bloque + los 16 casos invertidos que caen en bloques `P1`: BE-FLW-14, BE-FLW-16,
BE-WHK-08, BE-TWA-10, BE-GUP-06, BE-SMS-07, BE-SMS-09, BE-SMS-10, BE-IG-10, BE-IG-11, BE-SKL-08, BE-SKL-09,
BE-SKL-10, CHAT-LLMF-03, CHAT-LLMF-11 y CHAT-LLMF-12).

| Bloque | P (prioridad) | Casos |
|--------|:-:|------:|
| **Backend (§1)** | | **312** |
| 1.1 Autenticación | 🔴 P0 | 28 |
| 1.2 RBAC | 🔴 P0 | 24 |
| 1.3 Multitenant | 🔴 P0 | 13 |
| 1.4 Tenants | 🟠 P1 | 11 |
| 1.5 Usuarios | 🔴 P0 | 26 |
| 1.6 Áreas | 🟠 P1 | 23 |
| 1.7 Configuración y secretos | 🔴 P0 | 20 |
| 1.8 Flujos | 🟠 P1 | 19 |
| 1.9 Fuentes de verdad | 🟠 P1 | 19 |
| 1.10 LLM | 🟠 P1 | 20 |
| 1.11 Broker | 🟠 P1 | 13 |
| 1.12 Webhook WhatsApp | 🟠 P1 | 10 |
| 1.13 Salida WhatsApp | 🟠 P1 | 9 |
| 1.14 Canal de email | 🔴 P0 | 8 |
| 1.15 Datos, seed y migraciones | 🔴 P0 | 5 |
| 1.16 Endpoints públicos | 🟠 P1 | 3 |
| 1.17 Seguridad transversal | 🔴 P0 | 3 |
| 1.18 Placeholders | 🚧 | 6 |
| 1.19 Canal WhatsApp — Twilio | 🟠 P1 | 11 |
| 1.20 Canal WhatsApp — Gupshup | 🟠 P1 | 7 |
| 1.21 Canal SMS (Twilio y Gupshup) | 🟠 P1 | 10 |
| 1.22 Integración InvGate | 🟠 P1 | 14 |
| 1.23 Skills | 🟠 P1 | 10 |
| **Chatbot (§2)** | | **142** |
| 2.1 Pipeline | 🔴 P0 | 8 |
| 2.2 Arranque de flujo | 🔴 P0 | 5 |
| 2.3 Nodos del motor | 🔴 P0 | 82 |
| 2.4 Encadenamiento | 🟠 P1 | 5 |
| 2.5 Espera en dos fases | 🟠 P1 | 3 |
| 2.6 Conocido vs desconocido | 🔴 P0 | 4 |
| 2.7 LLM dentro/fuera | 🟠 P1 | 12 |
| 2.8 Cierre y cancelación | 🟠 P1 | 3 |
| 2.9 Interpolación | 🟠 P1 | 3 |
| 2.10 End-to-end | 🔴 P0 | 5 |
| 2.11 Cierre por inactividad | 🟠 P1 | 4 |
| 2.12 Concurrencia y carga | 🟠 P1 | 4 |
| 2.13 Placeholders | 🚧 | 4 |
| **Frontend (§3)** | | **114** |
| 3.1 Infraestructura | 🔴 P0 | 15 |
| 3.2 Login y OTP | 🔴 P0 | 7 |
| 3.3 Dashboard | 🟠 P1 | 2 |
| 3.4 Usuarios | 🟠 P1 | 14 |
| 3.5 Roles | 🟠 P1 | 10 |
| 3.6 Tenants | 🟠 P1 | 5 |
| 3.7 Áreas | 🟠 P1 | 5 |
| 3.8 Configuración | 🟠 P1 | 15 |
| 3.9 Fuentes de verdad | 🟠 P1 | 10 |
| 3.10 Flujos (editor) | 🟠 P1 | 21 |
| 3.11 Responsive | 🟢 P2 | 4 |
| 3.12 Seguridad de UI | 🔴 P0 | 6 |
| **TOTAL** | | **568** |

> **Nota:** 35 casos arrancan en `❌` **por diseño** (describen el comportamiento seguro deseado, hoy
> no implementado) y pasan a `✅` al corregir el hallazgo — no son regresión. 26 están ligados a los
> **21 hallazgos `SEC-*`** (varios `SEC-*` cubren más de un caso: `SEC-16` agrupa BE-TWA-10 / BE-GUP-06 /
> BE-SMS-09, y `SEC-17` agrupa BE-SKL-08 / BE-SKL-09). Los otros **9** son de **robustez o calidad**, sin
> número de hallazgo: BE-EML-03 (canal de email caído), BE-MT-12 y FE-INF-13 (menú del superusuario),
> CHAT-N-LLM-04 (nodo LLM sin blindar), BE-SMS-07 (Gupshup SMS descarta el menú), BE-IG-10 (cachés de
> InvGate sin invalidar en caliente), BE-SKL-10 (`isActive` de Skill sin efecto en el motor) y
> CHAT-LLMF-11 / CHAT-LLMF-12 (prompt injection y alucinación desde la fuente de verdad). El escenario de
> datos sobre el que corre todo el plan está en el **Apéndice C**; las matrices de comprobación
> transversales, en el **Apéndice B**.

---

# 🖥️ Sección 1 — Backend

Cadena de guards estándar de los controladores con datos por tenant:
`@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)`. Saneo global de payloads con
`ValidationPipe` (`whitelist + forbidNonWhitelisted + transform`): todo campo fuera del DTO
devuelve **400**.

## 1.1 Autenticación — login, JWT, OTP/2FA, fingerprint

**Precondición:** existe un usuario con contraseña conocida y membresía en al menos un
tenant. Los endpoints de auth (`/auth/register`, `/auth/login`, `/auth/verify-otp`) son
públicos; `/auth/me` requiere `JwtAuthGuard`. `/auth/login` y `/auth/verify-otp` exigen el
header `User-Agent` (401 si falta).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-AUTH-01 | Login con email y contraseña correctos, con `OTP_ENABLED=false` | 200, `step: authenticated`, `accessToken` + `refreshToken`, sin `passwordHash` |
| BE-AUTH-02 | Login con contraseña incorrecta | 401 "Credenciales inválidas" |
| BE-AUTH-03 | Login con email inexistente | 401 "Credenciales inválidas" (mismo mensaje que 02, no revela si el email existe) |
| BE-AUTH-04 | Login de un usuario dado de baja (`deletedAt` seteado) | 401, no entra aunque la contraseña sea válida |
| BE-AUTH-05 | Login sin header `User-Agent` | 401 |
| BE-AUTH-06 | Login con `OTP_ENABLED=true`, primer dispositivo (sin devices previos) | Emite tokens y registra el fingerprint del device |
| BE-AUTH-07 | Login con `OTP_ENABLED=true` desde un device nuevo de un usuario que ya tiene devices | `step: otp_required`, no emite tokens, envía código por email |
| BE-AUTH-08 | Login con `OTP_ENABLED=true` con fingerprint ya válido | Emite tokens sin pedir OTP |
| BE-AUTH-09 | `verify-otp` con el código correcto dentro del TTL | 200, `step: authenticated`, registra el fingerprint del nuevo device |
| BE-AUTH-10 | `verify-otp` con código vencido | 401 "Código expirado", borra la entrada |
| BE-AUTH-11 | `verify-otp` con código inexistente | 401 "Código inválido o expirado" |
| BE-AUTH-12 | `verify-otp` de un usuario dado de baja entre pedir y verificar | 401 "Usuario no encontrado" |
| BE-AUTH-13 | `GET /auth/me` con token válido | 200 con tenants y **permisos efectivos** (catálogo completo si es SuperAdmin) |
| BE-AUTH-14 | `GET /auth/me` sin token o con token inválido | 401 |
| BE-AUTH-15 | Registro (`/auth/register`) con email ya en uso entre activos | 401 "El email ya está registrado" |
| BE-AUTH-16 | Registro con contraseña de menos de 8 caracteres | 400 (validación `@MinLength(8)`) |
| BE-AUTH-17 | Usar el `refreshToken` como `Bearer` en un endpoint protegido | **401**: el refresh token no vale como access token (los tipos de token se diferencian). ⚠️ Hoy **pasa como válido** (SEC-06): el caso queda en `❌` hasta diferenciar el tipo de token |
| BE-AUTH-18 | Fijar `OTP_CODE_LENGTH=5` y disparar el flujo de OTP | El código de 5 dígitos **se acepta**: la validación usa la longitud configurada (4–8), no un fijo. ⚠️ Hoy el DTO exige `@Length(6,6)` y lo **rechaza** (SEC-13), dejando el 2FA inutilizable con longitud ≠ 6: `❌` hasta validar contra el valor configurado |
| BE-AUTH-19 | Probar códigos de OTP por fuerza bruta contra `verify-otp` | **Debe** estar acotado: código atado al usuario/sesión, límite de intentos por código e IP, expiración tras N fallos y generación con CSPRNG. ⚠️ Hoy el código de 6 dígitos se busca **sólo por el código**, sin límite de intentos ni rate limit y con generador no criptográfico (SEC-01): `❌` hasta acotarlo |
| BE-AUTH-20 | Inspeccionar el identificador de dispositivo (fingerprint) | **Debe** ser un hash (SHA-256) de las señales, no reversible. ⚠️ Hoy es una codificación **reversible** de teléfono + User-Agent (SEC-07): `❌` hasta hashearlo |
| BE-AUTH-21 | Disparar un OTP sin SMTP configurado y revisar los logs | El cuerpo del email (con el código) **no** se escribe en los logs, ni en desarrollo. ⚠️ Hoy sin SMTP se **loguea** el OTP (SEC-10): `❌` hasta no volcar el cuerpo |
| BE-AUTH-22 | Usar un token válido de un usuario dado de baja **después** de la baja | **Debe** rechazarse (401) en la estrategia JWT. ⚠️ Hoy la validación del token **no** filtra la baja lógica (queda contenido por el guard de tenant) (SEC-14): `❌` hasta rechazarlo por defensa en profundidad |
| BE-AUTH-23 | Registro (`/auth/register`) con un email nuevo y contraseña de ≥8 caracteres | 201, crea la persona con la contraseña hasheada (bcrypt) y **sin** membresías ni tokens; la respuesta no incluye `passwordHash`. El registro es **público** (ver la nota "El registro de cuentas es público y sin freno" en el Apéndice A) |
| BE-AUTH-24 | Usar un access token **vencido** (pasados los 15 min de vida) en un endpoint protegido | 401: la estrategia JWT rechaza el token expirado por su `exp` (independiente de SEC-06, que es sobre el refresh token) |
| BE-AUTH-25 | Reiniciar el proceso de la API entre el login que generó el OTP y el `verify-otp` (o correr dos instancias detrás de un balanceador) | 401 "Código inválido o expirado": el OTP vive en un `Map` en memoria (`otpStore`), no en Redis/BD, así que un reinicio lo pierde y no se comparte entre instancias. Limitación conocida de robustez/escala documentada, no un fallo de seguridad |
| BE-AUTH-26 | Cualquier request autenticado con token válido | `SlidingSessionInterceptor` (global) reemite un JWT fresco de 15 min en el header **`X-Access-Token`**; con actividad continua la sesión ya no vence. `main.ts` lo expone por CORS (`exposedHeaders`) para que el front pueda leerlo. No pisa el `Authorization` de la request en curso |
| BE-AUTH-27 | El interceptor sobre una ruta pública (login/OTP/webhook) o sin `request.user` | **No** reemite: corre **después** de los guards, así que sólo actúa en rutas ya autenticadas |
| BE-AUTH-28 | Sesión deslizante: token robado mantenido vivo con tráfico; usuario **deshabilitado** (no borrado); `logout` | **Debe** haber un **techo absoluto** de sesión y **revocación** server-side, y rechazar al usuario deshabilitado. ⚠️ Hoy: sin max-lifetime (con actividad la sesión **no vence nunca**), sin blocklist (el `logout` sólo limpia el `localStorage` del cliente; el JWT sigue válido hasta su `exp`), y `JwtStrategy` valida **existencia** pero no un flag de deshabilitado (SEC-19): `❌`. Mitigante real: un usuario **borrado** sí deja de deslizar (el `findUnique` falla) |

## 1.2 RBAC dinámico — roles y permisos

**Precondición:** roles y permisos son datos (no enums). El seed asigna al `SuperAdmin` el
catálogo completo (60 permisos = 15 recursos × 4 acciones; el 15º recurso es `skills`, sumado
por el PR de Skills). Un endpoint sin `@RequirePermission` **permite** (el guard sólo corta
cuando hay permiso declarado).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-RBAC-01 | Acceder a un endpoint con el permiso requerido | 200 |
| BE-RBAC-02 | Acceder a un endpoint sin el permiso requerido | 403 "Permiso denegado: recurso:acción" |
| BE-RBAC-03 | SuperAdmin (rol protegido en tenant de sistema) accede a cualquier endpoint con permiso | Pasa sin mirar permisos individuales |
| BE-RBAC-04 | Endpoint con `TenantGuard` ausente en la cadena | `RolesGuard` tira 403 "Tenant no resuelto" |
| BE-RBAC-05 | Crear un rol y asignarle un permiso del catálogo | 201/200, el permiso surte efecto en la siguiente request sin reiniciar |
| BE-RBAC-06 | Asignar a un rol un permiso **fuera del catálogo** (`recurso:acción` inexistente) | 400, se rechaza |
| BE-RBAC-07 | `PUT /roles/:id/permissions` con el conjunto completo (reemplazo masivo) | Reemplaza en transacción; toca solo permisos del catálogo |
| BE-RBAC-08 | Modificar permisos del **rol protegido** (SuperAdmin de sistema) | Rechazado (`assertNotProtected`) |
| BE-RBAC-09 | Cambiar los permisos de un rol y volver a llamar a `/auth/me` | Los permisos nuevos se reflejan (lectura desde BD, sin caché) |
| BE-RBAC-10 | `GET /roles/all` o `/roles/by-tenant/:id` desde un tenant que no es el de sistema | 403 (`SystemTenantGuard`) |
| BE-RBAC-11 | Frontend: el menú y los botones se arman según los permisos de `/auth/me` | Ítems sin permiso no se muestran; ítems `systemTenantOnly` sólo con tenant de sistema activo |
| BE-RBAC-12 | `GET /roles` parado en un tenant | Roles de ese tenant con `userCount`, `permissionCount` (sólo los del catálogo) e `isProtected` |
| BE-RBAC-13 | `GET /roles/:id` de un rol del tenant vs. de otro tenant | El del tenant: 200. El de otro tenant: 404 "Rol no encontrado" (aislamiento por `findEntity`) |
| BE-RBAC-14 | `GET /roles/:id/users` | Usuarios que tienen ese rol (id, email, nombre); pide `roles:read` |
| BE-RBAC-15 | `GET /roles/all` y `GET /roles/by-tenant/:id` desde el tenant de sistema (positivo de BE-RBAC-10) | `all` = roles de todas las empresas (excluye las dadas de baja); `by-tenant` = los de la empresa del path |
| BE-RBAC-16 | `GET /roles/mine` | Roles de las empresas donde el usuario tiene `roles:read`; `[]` si en ninguna |
| BE-RBAC-17 | `GET /roles/catalog` | El catálogo de permisos (15 recursos × 4 acciones; el 15º es `skills`) con el que se dibuja la matriz del backoffice |
| BE-RBAC-18 | `PATCH /roles/:id` renombrando un rol común | 200; nombre único por empresa (repetido → 409 "Ya existe un rol llamado X en esta empresa") |
| BE-RBAC-19 | `PATCH /roles/:id` sobre el rol protegido (SuperAdmin de sistema) | 409 (`assertNotProtected`): no se puede renombrar |
| BE-RBAC-20 | `DELETE /roles/:id` de un rol **sin** usuarios asignados | 200, lo elimina |
| BE-RBAC-21 | `DELETE /roles/:id` de un rol **con** usuarios asignados | 409 "No se puede eliminar X: N usuarios lo tienen asignado…" (la FK de `UserTenant.role` no cascadea) |
| BE-RBAC-22 | `DELETE /roles/:id` del rol protegido | 409 (`assertNotProtected`) |
| BE-RBAC-23 | `DELETE /roles/permissions/:id` (quitar un permiso puntual) | Quita esa fila `RolePermission` del rol; el cambio se refleja en la siguiente request sin reiniciar |
| BE-RBAC-24 | `GET /roles/:roleId/permissions` | Lista los pares `resource`/`action` de ese rol; pide `permissions:read` |

## 1.3 Multitenant — aislamiento y resolución de tenant

**Precondición:** hay usuarios con 1 y con varios tenants. El tenant activo viaja por el
header `X-Tenant-Id`; `TenantGuard` valida la pertenencia contra `UserTenant` y deja
`request.tenantId`. El JWT **no** lleva tenant.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-MT-01 | Usuario con 1 tenant, sin header | OK, usa el único tenant |
| BE-MT-02 | Usuario con 1 tenant, con header que coincide | OK |
| BE-MT-03 | Usuario con **varios** tenants, sin header | 400 "indicá cuál usar en el header X-Tenant-Id" |
| BE-MT-04 | Usuario con varios tenants, header de un tenant al que **pertenece** | OK, opera sobre ese tenant |
| BE-MT-05 | Header de un tenant al que **no** pertenece (usuario común) | 403 "No tenés acceso a este tenant" |
| BE-MT-06 | Header de un tenant al que no pertenece, pero el usuario **es de sistema** | OK, opera con el rol de sistema sobre la empresa pedida |
| BE-MT-07 | Usuario de sistema con header de una empresa **inexistente o dada de baja** | 404 "La empresa indicada no existe" |
| BE-MT-08 | Usuario sin ninguna membresía activa | 403 "El usuario no pertenece a ningún tenant" |
| BE-MT-09 | **Aislamiento de datos:** listar recursos por tenant (roles, usuarios, flujos) parado en el tenant A | Sólo devuelve datos del tenant A, nunca del B |
| BE-MT-10 | Membresía en un tenant que está dado de baja | No cuenta como pertenencia (queries filtran `tenant.deletedAt: null`) |
| BE-MT-11 | Enviar `tenantId` en el body en lugar del header | Se ignora; el tenant sale de `@CurrentTenant()` |
| BE-MT-12 | El **superusuario del sistema** parado en una empresa común (header con el id de esa empresa) llama a **todas** las operaciones con candado de superusuario: configuración, ABM de empresas, y las vistas de todas las empresas de usuarios, roles, áreas y flujos | **Debe** responder 200 en todas, **por el mismo mecanismo que ya deja pasar al resto del menú**: cuando el superusuario se para en una empresa de la que no es miembro, `TenantGuard` le deja como vínculo activo el de la **empresa de sistema** (BE-MT-06), y de ese vínculo salen sus permisos. El candado tiene que leer ese vínculo —igual que `RolesGuard` con todos los demás ítems—, no la empresa elegida en el selector. Un administrador de empresa común sigue recibiendo 403 aunque se auto-asigne el permiso: no tiene vínculo con la empresa de sistema y no puede dárselo. Todas son **globales por naturaleza** (la configuración es única en toda la base y las vistas de todas las empresas no dependen de cuál esté elegida), así que devuelven lo mismo esté parado donde esté. ⚠️ Hoy el candado es el único de la cadena que mira la **empresa activa** en vez del vínculo, y devuelve 403 en todas apenas el superusuario sale de la empresa de sistema: `❌` hasta que lea lo mismo que el resto. **Las dos pantallas del menú (Configuración y Tenants) son el síntoma visible; el resto viaja con el mismo cambio** porque el candado es una sola pieza compartida |
| BE-MT-13 | Un usuario que **es miembro del tenant de sistema pero con un rol común** (no SuperAdmin) manda el header de una empresa de la que **no** es miembro | 403 "No tenés acceso a este tenant". Complemento adversarial de BE-MT-06: pertenecer al tenant de sistema **no** alcanza para pararse en cualquier empresa; solo el rol protegido `SuperAdmin` hereda ese poder. `TenantGuard.resolveAsSystemUser` corta por el **rol** (`isProtectedRole`), no por la mera pertenencia al tenant de sistema, así que este usuario recibe el mismo 403 que un usuario ajeno (BE-MT-05). Sin esta distinción, cualquier miembro de la empresa de sistema operaría como superusuario — exactamente el hueco que cerró el PR |

## 1.4 Tenants — gestión y doble candado de superusuario

**Precondición:** las operaciones cross-tenant (`/tenants/all`, alta/edición/baja) exigen
`SystemTenantGuard` (tenant activo = sistema) **más** el permiso `tenants:*`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-TEN-01 | `GET /tenants` parado en un tenant | Sólo el tenant activo (con conteos de usuarios/roles/áreas) |
| BE-TEN-02 | `GET /tenants/all` desde el tenant de sistema con permiso | Todos los tenants; con `?includeDeleted=true` incluye los dados de baja |
| BE-TEN-03 | `GET /tenants/all` desde un tenant que no es el de sistema | 403 |
| BE-TEN-04 | Crear un tenant desde el tenant de sistema | 201 |
| BE-TEN-05 | Crear un tenant con un slug ya en uso (aunque el dueño esté de baja) | 409 "Ya existe una empresa con el slug X" |
| BE-TEN-06 | Editar el **name** de la empresa de sistema | Permitido (cosmético) |
| BE-TEN-07 | Cambiar el **slug** de la empresa de sistema | 409 (de él dependen los cortes de superusuario) |
| BE-TEN-08 | Baja lógica de un tenant | Marca `deletedAt`, no borra físico; el slug queda ocupado |
| BE-TEN-09 | Baja lógica de la empresa de sistema | 409, no se puede |
| BE-TEN-10 | Restaurar un tenant dado de baja | OK; restaurar uno ya activo o inexistente → 404 |
| BE-TEN-11 | Editar `name` y `slug` de una empresa **común** (no la de sistema) | 200, actualiza ambos; slug ya en uso (aunque sea de una dada de baja) → 409 |

## 1.5 Usuarios — multiempresa, baja lógica, datos únicos

**Precondición:** una persona = 1 fila `User` + N membresías `UserTenant`. Cuatro campos son
**únicos globales**: `email`, `phone`, `internalPhone` (interno telefónico), `invgateUserId`.
Las operaciones multiempresa (`/users/multi`, `/users/:id/full`) autorizan **por empresa**
dentro del servicio (empresas en el body), no por header.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-USR-01 | Alta de usuario en el tenant activo (`POST /users`) | 201, con rol y área válidos del tenant |
| BE-USR-02 | Alta multiempresa (`POST /users/multi`) con varias empresas en el body | Crea la persona + N membresías atómicamente |
| BE-USR-03 | Alta multiempresa con una empresa repetida en el body | 400 |
| BE-USR-04 | Alta multiempresa en una empresa donde el solicitante **no** puede gestionar usuarios | 403 (autorización por empresa), salvo que sea superusuario |
| BE-USR-05 | Alta con un email ya en uso por un usuario **activo** | 409, cuerpo `{ field, conflict }` |
| BE-USR-06 | Alta con phone / internalPhone / invgateUserId ya en uso | 409 en cada caso |
| BE-USR-07 | Conflicto de dato único: el solicitante **puede ver** al ocupante | El 409 revela `{ canView:true, userId, name }` (quién lo usa) |
| BE-USR-08 | Conflicto de dato único: el solicitante **no puede ver** al ocupante | El 409 revela sólo que está en uso (`canView:false`, sin id ni nombre) |
| BE-USR-09 | `GET /users/check-availability` de un dato libre | `{ available:true }` |
| BE-USR-10 | `check-availability` de un dato en uso | `{ available:false, conflict }` según visibilidad |
| BE-USR-11 | `check-availability` sin permiso de gestión en ninguna empresa | 403 |
| BE-USR-12 | Baja lógica de un usuario con una sola membresía | Baja lógica: sufija los campos únicos y libera esos valores |
| BE-USR-13 | Baja del usuario en un tenant cuando tiene otras membresías | `{ deleted:false }`, sigue activo en las demás |
| BE-USR-14 | Intentar darse de baja a uno mismo | 400 |
| BE-USR-15 | Reusar un email/phone que había quedado libre por una baja | Permitido: entra como persona nueva sin historial (no hay reactivación) |
| BE-USR-16 | Alta de dos usuarios con datos que colisionarían en el mismo segundo | El sufijo de baja incorpora el userId para no chocar |
| BE-USR-17 | `GET /users/all` desde el tenant de sistema | Una fila por membresía, cross-tenant |
| BE-USR-18 | `GET /users` parado en un tenant | Usuarios de ese tenant con su rol y área ahí; excluye a los dados de baja; pide `users:read` |
| BE-USR-19 | `GET /users/mine` de un usuario con `users:read` en varias empresas | Una fila por membresía de esas empresas (con la empresa); `[]` si no tiene `users:read` en ninguna |
| BE-USR-20 | `GET /users/:id` de una membresía del tenant vs. de otro tenant | La del tenant: datos + rol + área. La de otro tenant (o persona de baja): 404 "El usuario no existe en este tenant" |
| BE-USR-21 | `GET /users/:id/memberships` como editor | Datos de la persona + **sólo** las membresías de empresas que administra (`users:read`); el superusuario ve todas |
| BE-USR-22 | `GET /users/:id/memberships` sin compartir ninguna empresa visible (no superusuario) | 403 "No tenés permiso para ver a este usuario" |
| BE-USR-23 | `PATCH /users/:id` cambiando rol y área del tenant | 200, actualiza la membresía; un rol o área de **otro** tenant → 400 |
| BE-USR-24 | `PATCH /users/:id` con phone/internalPhone/invgateUserId ya en uso por otro activo | 409 (la validación se excluye a sí mismo: reguardar sus propios datos no choca) |
| BE-USR-25 | `PATCH /users/:id` con `areaId` vacío/`null` vs. ausente | Vacío/`null` deja al usuario sin área; que la clave no venga = no se toca el área |
| BE-USR-26 | `PATCH /users/:id/full` (edición multiempresa): agrega, cambia rol/área y quita empresas | Diff atómico; cada operación pide su permiso en ESA empresa (create/update/delete); si queda sin ninguna → baja lógica; quitarse a uno mismo → 400 |

## 1.6 Áreas — CRUD por empresa y aislamiento

**Precondición:** un área es una agrupación de usuarios **dentro de una empresa** (para
auditoría/métricas; no interviene en el motor de flujos). Cadena estándar
`@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)` con permisos `areas:read/create/update/delete`.
El nombre es **único por empresa** (`@@unique([name, tenantId])`) y el chequeo de la app es
**sin distinguir mayúsculas** (única barrera contra "Soporte"/"soporte"). El borrado es
**físico**, no baja lógica, y está bloqueado si el área tiene usuarios asignados.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-ARE-01 | `GET /areas` parado en un tenant | Sólo las áreas de ese tenant, cada una con `userCount` (usuarios asignados) |
| BE-ARE-02 | `GET /areas` sin el permiso `areas:read` | 403 "Permiso denegado: areas:read" |
| BE-ARE-03 | `GET /areas/all` desde el tenant de sistema con permiso | Todas las áreas de todas las empresas, con su empresa; **excluye** las de empresas dadas de baja |
| BE-ARE-04 | `GET /areas/all` desde un tenant que no es el de sistema | 403 (`SystemTenantGuard`) |
| BE-ARE-05 | `GET /areas/mine` de un usuario con `areas:read` en varias empresas | Áreas de todas sus empresas (con la empresa de cada una), sin header ni tenant de sistema |
| BE-ARE-06 | `GET /areas/mine` de un usuario sin `areas:read` en ninguna empresa | `[]` (lista vacía), **no** 403 (la autorización es por-empresa dentro del servicio) |
| BE-ARE-07 | `GET /areas/by-tenant/:tenantId` desde el tenant de sistema | Áreas de la empresa indicada en el path (para el alta multiempresa de usuarios) |
| BE-ARE-08 | `GET /areas/by-tenant/:tenantId` desde un tenant que no es el de sistema | 403 (`SystemTenantGuard`) |
| BE-ARE-09 | `GET /areas/:id` de un área del tenant activo | 200 con el área |
| BE-ARE-10 | `GET /areas/:id` de un área de **otra** empresa (id existente, otro tenant) | 404 "El área no existe en este tenant" (aislamiento por tenant) |
| BE-ARE-11 | `GET /areas/:id/users` de un área del tenant | Usuarios asignados (id, email, nombre, apellido); pide `areas:read`, **no** `users:read` |
| BE-ARE-12 | `POST /areas` con un nombre nuevo | 201; el nombre se guarda `trim()`-eado; el tenant sale del header, nunca del body |
| BE-ARE-13 | `POST /areas` con un nombre ya usado en la empresa (aunque cambien mayúsculas: "Soporte" vs "soporte") | 409 "Ya existe un área con ese nombre en este tenant" |
| BE-ARE-14 | `POST /areas` con el mismo nombre en **otra** empresa | 201: el nombre sólo es único dentro de la empresa |
| BE-ARE-15 | `POST /areas` sin `name` (o vacío) | 400 "El nombre del área es obligatorio" |
| BE-ARE-16 | `POST /areas` con `name` de más de 80 caracteres, o con un campo fuera del DTO | 400 (`@MaxLength(80)` / whitelist) |
| BE-ARE-17 | `PATCH /areas/:id` cambiando el nombre a uno libre | 200, actualiza; el chequeo de unicidad se excluye a sí mismo |
| BE-ARE-18 | `PATCH /areas/:id` a un nombre ya usado por **otra** área de la empresa | 409 |
| BE-ARE-19 | `PATCH /areas/:id` de un área de otra empresa | 404 (valida pertenencia antes de tocar) |
| BE-ARE-20 | `DELETE /areas/:id` de un área **sin** usuarios asignados | 200 `{ deleted:true }`; borrado físico |
| BE-ARE-21 | `DELETE /areas/:id` de un área **con** usuarios asignados | 409 "…tiene N usuario(s) asignado(s). Reasignalos antes de eliminarla." (no borra) |
| BE-ARE-22 | `DELETE /areas/:id` de un área de otra empresa | 404 (aislamiento) |
| BE-ARE-23 | **Aislamiento:** crear/editar/borrar parado en la empresa A nunca afecta áreas de la B | Toda operación queda scopeada por el tenant activo del header |

## 1.7 Configuración y secretos (`/settings`)

**Precondición:** doble candado (`SystemTenantGuard` + `@RequirePermission('settings', …)`).
Las claves válidas son sólo las del catálogo. Los secretos se cifran con AES-256-GCM y son de
**solo escritura**.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-SET-01 | `GET /settings` como SuperAdmin de sistema | Catálogo resuelto con `source: db/env/default` y `updatedAt` |
| BE-SET-02 | `GET /settings` desde un tenant que no es el de sistema | 403 |
| BE-SET-03 | `POST /settings` con una key **fuera del catálogo** | 400 con la lista de keys válidas |
| BE-SET-04 | Fijar un valor `number` fuera del rango min/max del catálogo | 400 |
| BE-SET-05 | Fijar un valor `enum` fuera de `allowedValues` | 400 |
| BE-SET-06 | Guardar una API key (`secret: true`) con `SETTINGS_ENCRYPTION_KEY` presente | Se guarda cifrada (`enc:v1:…`), nunca en texto plano |
| BE-SET-07 | Guardar un secreto **sin** `SETTINGS_ENCRYPTION_KEY` | 400, se rechaza (nunca fallback a texto plano) |
| BE-SET-08 | `GET` de un setting secreto | Devuelve `value` **enmascarado** (`sk-•••••abcd`) + `isSet:true`, jamás el valor real |
| BE-SET-09 | Guardar un secreto vacío | 400 (usar `DELETE` para limpiarlo) |
| BE-SET-10 | Rotar `SETTINGS_ENCRYPTION_KEY` y leer un secreto viejo | `isSet:true` + "(no se pudo descifrar)" (el tag GCM ya no valida) |
| BE-SET-11 | Cascada de resolución: valor en BD tapa a env; sin BD usa env; sin env usa default | El `source` reportado refleja de dónde salió cada valor |
| BE-SET-12 | Verificar que ningún log escribe el valor de un secreto | Sólo "Secret actualizado: KEY (cifrado)", nunca el valor |
| BE-SET-13 | `DELETE /settings/:key` de una key con valor en BD | Vuelve a resolver por env/default |
| BE-SET-14 | `GET /settings/providers/status` | Devuelve `{ active, encryptionConfigured, providers[] }`: por cada proveedor (openai, gemini, claude, openrouter, opencodego, minimax) si está `ready` y qué claves le `missing`, y cuál es el `active` |
| BE-SET-15 | `GET /settings/:key` de una key del catálogo vs. una key inexistente | La del catálogo: valor resuelto con `source` (los secretos, enmascarado + `isSet`); una key fuera del catálogo: 400 con la lista de keys válidas |
| BE-SET-16 | `PATCH /settings/:key` | Equivale a `POST /settings` (`upsert`): fija el valor con las mismas validaciones (catálogo, rango, enum, secreto cifrado) |
| BE-SET-17 | `DELETE /settings/:key` de una key **sin** valor en BD | 404 "…no tiene valor en BD (usa env var o default)" |
| BE-SET-18 | Guardar los secretos de los canales nuevos e InvGate (`TWILIO_AUTH_TOKEN`, `GUPSHUP_API_KEY`, `GUPSHUP_SMS_PASSWORD`, `INVGATE_API_KEY`) | Se guardan **cifrados** (AES-256-GCM); el `GET` los enmascara + `isSet`. Los identificadores **no** secretos (`TWILIO_ACCOUNT_SID`, `GUPSHUP_SMS_USERID`, `INVGATE_API_USER`, números `*_FROM`, `*_TENANT_ID`) van en claro |
| BE-SET-19 | Selectores de proveedor `WHATSAPP_PROVIDER` (`meta`/`twilio`/`gupshup`) y `SMS_PROVIDER` (`twilio`/`gupshup`) | Cascada estándar BD → env → default (`meta`/`twilio`); un valor fuera del enum → 400 (`allowedValues`). ⚠️ A diferencia de `LLM_PROVIDER`, se leen **una sola vez al arrancar**: cambiarlos no re-suscribe los consumers sin reiniciar (ver BE-TWA-02) |
| BE-SET-20 | Descripciones de `TWILIO_ACCOUNT_SID` e `INVGATE_API_USER` | Dicen "solo escritura por consistencia" pero están `secret:false`: el `GET` los devuelve **en claro**. Inocuo (un SID no es sensible), pero la descripción sugiere algo que el flag no cumple — anotar la discrepancia |

## 1.8 Flujos — CRUD y asignación por tenant

**Precondición:** `Flow` (definición) + `TenantFlow`/`TenantFlowRole` (asignación por empresa y
rol). `TenantFlow.isStart` marca el flujo de inicio por (empresa + rol); `Flow.isDefault` es el
fallback global. La invariante "un flujo de inicio por (empresa + rol)" se mantiene en
transacción.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-FLW-01 | Crear un flujo | 201; nace sin empresas asignadas |
| BE-FLW-02 | Guardar un flujo con campos de ReactFlow no declarados (`measured`, `selected`) | 400 (los filtra la whitelist); sólo persisten los campos del DTO |
| BE-FLW-03 | `GET /flows` parado en un tenant | Sólo los flujos asignados a ese tenant |
| BE-FLW-04 | `GET /flows/all` desde el tenant de sistema | Todos los flujos, tengan o no empresas |
| BE-FLW-05 | Asignar un flujo como inicio a `(empresa A, rol R)` cuando ya había otro de inicio para ese par | El anterior deja de ser inicio para `(A, R)`; no toca otros pares |
| BE-FLW-06 | Asignar con empresas repetidas en el payload | Colapsa la repetición uniendo sus roles (no rompe el índice único) |
| BE-FLW-07 | Marcar un flujo como `isDefault` | Desmarca el default anterior (default global único) |
| BE-FLW-08 | `findActiveFlowForTenant` con rol que tiene inicio propio | Devuelve ese flujo si está activo |
| BE-FLW-09 | Rol sin flujo de inicio propio | Cae al default global activo; si no hay, `null` |
| BE-FLW-10 | Flujo de inicio existente pero `isActive:false` | No se usa: cae a default o a LLM |
| BE-FLW-11 | `GET /flows/:id` de un flujo | 200 con el flujo (nodos, aristas y sus asignaciones de empresa/rol); 404 "Flujo no encontrado" si no existe |
| BE-FLW-12 | `PATCH /flows/:id` editando nodos/aristas | 200; persiste `nodes`/`edges` (los campos ausentes no se tocan); sigue filtrando por la whitelist como BE-FLW-02 |
| BE-FLW-13 | `DELETE /flows/:id` de un flujo | 200 "Flujo eliminado"; borrado físico (el cascade limpia sus `TenantFlow`/roles) |
| BE-FLW-14 | `GET`/`PATCH`/`DELETE /flows/:id` con el id de un flujo de **otra** empresa | **Debe** cortar (403/404): las operaciones por id tendrían que scopear por la empresa activa (o el tenant de sistema). ⚠️ Hoy operan **sin filtrar** por empresa (SEC-03): `❌` hasta gatearlas |
| BE-FLW-15 | Crear/editar un flujo con `context` fuera de la lista (distinto de `none`/`invgate`/`internal_kb`/`other`) | 400 (`@IsIn(FLOW_CONTEXT_VALUES)`); un `context` válido se persiste |
| BE-FLW-16 | `POST /flows/:id/assign-tenants` y `POST /flows/:id/default` con el id de un flujo de **otra** empresa | **Debe** cortar (mismo criterio que BE-FLW-14): operan por id sin scope de tenant. ⚠️ Hoy también operan **sin filtrar** (SEC-03): `❌` hasta gatearlas |
| BE-FLW-17 | Vincular una Skill a un flujo con `skillId` (y desvincular con `skillId:null`) | 200; `findById` incluye `skill { id, name, promptText }` y en runtime el `promptText` se concatena al system prompt base (`buildBasePrompt`). Reemplaza en el editor al dropdown viejo `context` (que sobrevive `@IsIn(FLOW_CONTEXT_VALUES)`, DEPRECATED, sólo por compatibilidad — BE-FLW-15). El aislamiento por empresa del `skillId` se cubre en BE-SKL-08/09 |
| BE-FLW-18 | `GET /flows/mine` (vista "Todas mis empresas") de un usuario con `flows:read` **solo en la empresa B**, parado en la **A** (header) donde **no** lo tiene | 200 con los flujos de B, **no 403**. La autorización es por-empresa adentro de `FlowService.findMine` (filtra cada empresa por su `flows:read`), no sobre el tenant activo — por eso `/flows/mine` **no** lleva `@RequirePermission`, igual que `/areas/mine` (BE-ARE-05), `/users/mine` (BE-USR-19) y `/roles/mine` (BE-RBAC-16). Reponer el decorator lo evaluaría contra el rol de A y cortaría con 403 a quien sí tiene el permiso en otra empresa: regresión que este caso detecta |
| BE-FLW-19 | `GET /flows/mine` de un usuario **sin `flows:read` en ninguna** de sus empresas | 200 con `[]`, **no 403** (mismo criterio que BE-ARE-06 / BE-USR-19). La ausencia de permiso da lista vacía, no error: otra red de seguridad contra un `@RequirePermission` repuesto en el controlador |

## 1.9 Fuentes de verdad (context sources)

**Precondición:** `ContextSource` es **por tenant** (como `Area`), con `type` ∈
`{mcp, rag, n8n, broker}` y un `config` (Json) cuyos campos válidos define el catálogo
(`context-source-types.catalog.ts`). Cadena estándar `@UseGuards(JwtAuthGuard, TenantGuard,
RolesGuard)` con permisos `context-sources:read/create/update/delete` (**no** lleva
`SystemTenantGuard`: es por empresa). El nombre es único por empresa (`@@unique([name, tenantId])`).
Los campos marcados `secret` en el catálogo se cifran (AES-256-GCM) dentro del `config` y son de
**solo escritura**. "Probar conexión" y la consulta en vivo salen por el **broker** (RPC), nunca
por `fetch` directo desde el controlador.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-CS-01 | `GET /context-sources/types` | Catálogo de tipos (`mcp`/`rag`/`n8n`/`broker`) con sus campos (label, tipo, `secret`, `helpText`), para armar el formulario dinámico |
| BE-CS-02 | `GET /context-sources` parado en un tenant | Sólo las fuentes de ese tenant; los campos `secret` van enmascarados + `<campo>IsSet`, nunca el valor |
| BE-CS-03 | `GET /context-sources/:id` de una fuente de **otra** empresa | 404 (aislamiento por tenant) |
| BE-CS-04 | `POST /context-sources` con `type` válido y `config` del catálogo | 201; descarta cualquier key de `config` fuera del catálogo para ese `type` |
| BE-CS-05 | `POST /context-sources` con un `type` fuera de la lista | 400 (`@IsIn(CONTEXT_SOURCE_TYPE_VALUES)`) |
| BE-CS-06 | `POST /context-sources` con un `name` ya usado en la empresa | 409 (único por empresa); el mismo nombre en otra empresa → 201 |
| BE-CS-07 | `POST` con un campo `secret` en `config` (y `SETTINGS_ENCRYPTION_KEY` presente) | Se guarda cifrado dentro del `config`, nunca en texto plano; el `GET` posterior lo enmascara |
| BE-CS-08 | `PATCH /context-sources/:id` **sin** enviar un campo `secret` que ya estaba cargado | Conserva el secreto cifrado (campo ausente = "no tocar") |
| BE-CS-09 | `PATCH` enviando un campo `secret` explícito en `null`/`''` | Borra ese secreto |
| BE-CS-10 | `PATCH` intentando cambiar el `type` | El `type` no se toca (no está en el `UpdateDto`): sólo cambian `name`/`config`/`isActive` |
| BE-CS-11 | `DELETE /context-sources/:id` de una fuente **vinculada a un flujo** | Verificar el comportamiento real: el FK `Flow.contextSourceId` es `SetNull`, y el servicio puede además informar qué flujos la usan antes de borrar |
| BE-CS-12 | `DELETE /context-sources/:id` de una fuente sin uso | 200, la elimina |
| BE-CS-13 | `POST /context-sources/:id/test-connection` de una fuente alcanzable | Publica por el broker (RPC), responde `{ ok:true, message, latencyMs, statusCode? }` dentro de `TEST_TIMEOUT_MS` (20s) |
| BE-CS-14 | `test-connection` de una fuente inalcanzable o que no responde | `{ ok:false, message }` con el motivo; no cuelga (corta a los 20s) |
| BE-CS-15 | Cualquier operación sin el permiso `context-sources:*` correspondiente | 403 "Permiso denegado: context-sources:acción" |
| BE-CS-16 | `test-connection` de una fuente de tipo **MCP** | Comprueba que la URL del servidor responde, mandando las cabeceras configuradas (incluida la credencial descifrada); informa el código de estado y la latencia |
| BE-CS-17 | `test-connection` de una fuente de tipo **RAG** | Mismo mecanismo que MCP: alcance HTTP contra la URL configurada. No valida el contrato de consulta, sólo que el servicio está arriba |
| BE-CS-18 | `test-connection` de una fuente de tipo **n8n** | ⚠️ **Hace un POST real al webhook**: probar la conexión puede **disparar el workflow**. Usar siempre una URL de prueba (ver Apéndice C), nunca la productiva. Devuelve el resultado del webhook |
| BE-CS-19 | `test-connection` de una fuente de tipo **broker** | No sale por HTTP: publica en la cola configurada y espera respuesta por el broker (modo correlacionado o cola fija según la fuente); si nadie consume, corta por timeout con `ok:false` |

## 1.10 LLM — proveedores y modelos

**Precondición:** la lógica de negocio nunca llama al SDK del proveedor directo, siempre vía
`LlmService`. La API key, modelo y base URL las resuelve `LlmProviderFactory`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-LLM-01 | `chat()` con proveedor OpenAI configurado y key válida | Devuelve la respuesta del modelo |
| BE-LLM-02 | Proveedor sin API key (los que la requieren) | 400 al resolver la config |
| BE-LLM-03 | OpenCode Go sin `OPENCODEGO_API_URL` (`baseUrl`) | 400 (para este proveedor la base URL es obligatoria, la key no) |
| BE-LLM-04 | Alias de proveedor (`google`→gemini, `anthropic`→claude, `opencode`→opencodego) | Resuelve al proveedor correcto |
| BE-LLM-05 | Proveedor desconocido en `LLM_PROVIDER` | Warn + fallback a OpenAI |
| BE-LLM-06 | `GET /settings/providers/:provider/models` con key válida | Lista de modelos con `source: api` (caché de 5 min) |
| BE-LLM-07 | Mismo endpoint con `?refresh=true` | Saltea la caché y reconsulta |
| BE-LLM-08 | Proveedor caído o timeout (8s) al listar modelos | `source: fallback` + motivo. Para la mayoría cae a una lista conocida; **excepción `opencodego`**, cuyo `FALLBACK_MODELS` es vacío a propósito (los modelos dependen de la instancia) → la UI cae al campo de texto libre |
| BE-LLM-09 | Proveedor cuya SPA responde HTML 200 en `/models` | Detecta el content-type y responde con mensaje claro, no crashea |
| BE-LLM-10 | Merge de parámetros (`temperature`, `maxTokens`, `systemPrompt`): caller > BD > env > default | Prevalece el más específico |
| BE-LLM-11 | OpenCode Go: respuesta con partes `reasoning` y `text` | Sólo el `text` llega; el `reasoning` nunca se expone |
| BE-LLM-12 | OpenCode Go: `OPENCODEGO_AGENT` por defecto | Es `plan` (no `build`), no ejecuta herramientas sobre el server |
| BE-LLM-13 | `chat()` con proveedor **Claude** (alias `anthropic`) y key válida | Usa el SDK de Anthropic: separa el mensaje `system` del resto de los turnos, aplica `maxTokens` (default 1024) y `temperature` (default 0.7), y devuelve **sólo** las partes de tipo `text` de la respuesta (ignora las que no lo son) |
| BE-LLM-14 | `chat()` con proveedor **Gemini** (alias `google`) y key válida | Gemini **no** tiene rol `system`: mapea `assistant`→`model` y todo lo demás (incluido `system`) a `user`, manda todos los turnos menos el último como `history` y el último con `sendMessage`. Verificar el borde de un historial que arranca con un `system` (queda como turno `user`) y dejar documentado cómo arma los turnos |
| BE-LLM-15 | `chat()` con proveedor **OpenRouter** y key válida | Usa el SDK de OpenAI contra `https://openrouter.ai/api/v1` (o la `baseUrl` configurada); formato OpenAI estándar (`temperature`/`maxTokens` con default 0.7/1024) |
| BE-LLM-16 | `chat()` con proveedor **MiniMax** y key válida | Mismo camino OpenAI-compatible que OpenAI/OpenRouter, sólo cambia la base URL por defecto: `https://api.minimax.io/v1` (o la `baseUrl` configurada) |
| BE-LLM-17 | Respuesta de MiniMax M2.x que trae un bloque de razonamiento `<think>…</think>` | `LlmService.chat()` (**único** punto de entrada de todo el LLM) lo filtra **siempre** (`stripThinking`), sin importar el proveedor. `MiniMaxProvider` además pide `reasoning_split` para que el razonamiento venga en un campo aparte que se ignora. El razonamiento interno **nunca** llega al usuario final |
| BE-LLM-18 | Respuesta con un `<think>` **abierto sin cerrar** (el modelo se quedó sin tokens a mitad del razonamiento) | `stripThinking` corta desde el tag abierto; la respuesta puede quedar **vacía** — deliberado: mejor vacío que mostrar el razonamiento crudo |
| BE-LLM-19 | Clasificadores de intención (cierre de charla, cancelación, opción de menú) con un modelo de razonamiento obligatorio | Con `maxTokens = CLASSIFIER_MAX_TOKENS` (**300**, antes 10-20) el razonamiento no agota el presupuesto y el clasificador llega a emitir la palabra. ⚠️ Antes del fix devolvían siempre "no" en silencio: la charla nunca cerraba, nunca cancelaba y nunca matcheaba una opción por interpretación LLM |
| BE-LLM-20 | Nodo `message` normal con `LLM_MAX_TOKENS` bajo y un modelo razonador | ⚠️ La respuesta puede llegar **vacía** al usuario final (el `<think>` se come el presupuesto y `stripThinking` corta): modo de falla a tener en cuenta. Para los clasificadores está contemplado (cae al default); para el chat conversacional no |

## 1.11 Broker RabbitMQ — mecánica

**Precondición:** `RABBITMQ_URL` apunta a un broker de test. Colas del sistema:
`whatsapp.incoming` (entrada real), `whatsapp.simulate.incoming` (simulate/RPC),
`whatsapp.outgoing` (salida real), `whatsapp.rpc.reply.<uuid>` (respuesta RPC, exclusiva por
conexión).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-BRK-01 | `request()` a una cola con un consumidor que responde | Resuelve con la respuesta correlacionada por `correlationId`, a través del broker |
| BE-BRK-02 | `request()` sin respuesta dentro del timeout (30s por defecto) | Rechaza con "Sin respuesta de 'cola' después de Nms" y limpia el pending |
| BE-BRK-03 | `request()` cuando RabbitMQ no está conectado | Lanza "No se pudo publicar: RabbitMQ no está conectado", limpia el pending |
| BE-BRK-04 | `publish()` sin canal disponible | Devuelve `false`, no lanza |
| BE-BRK-05 | `publish()` contra la reply queue exclusiva con `{ assert: false }` | No reafirma la cola; no dispara 405 RESOURCE_LOCKED |
| BE-BRK-06 | Caída de la conexión de RabbitMQ | Reintenta cada 5s; re-suscribe los handlers; recrea la reply queue |
| BE-BRK-07 | Requests RPC en vuelo durante una caída | Expiran por su propio timeout (no se recuperan) |
| BE-BRK-08 | `ack`/`nack` sobre un canal ya cerrado | `safeAck`/`safeNack` lo capturan; el proceso Node **no** se cae |
| BE-BRK-09 | Mensaje con JSON inválido en una cola | El consumer lo captura (try/catch), no tira el proceso |
| BE-BRK-10 | Verificar que la reply queue tiene nombre propio (`whatsapp.rpc.reply.*`) | Nunca usa cola anónima `amq.gen-*` (prefijo reservado, el broker la rechaza) |
| BE-BRK-11 | `requestViaQueue()` contra una cola de respuesta **fija** (un RAG que no ecoa `correlationId`, ej. DonQuijote) | Publica y espera la respuesta en la cola fija declarada; la resuelve por FIFO cuando no puede correlacionar por `correlationId` |
| BE-BRK-12 | Dos consumidores compitiendo por la misma cola de respuesta fija | RabbitMQ reparte por round-robin sin mirar `correlationId`: la respuesta puede ir al proceso equivocado y el otro expira. Limitación de `fixedQueue` (un solo consumidor a la vez), sin fix de código |
| BE-BRK-13 | Mensajes viejos sin consumir en una cola de respuesta fija | El fallback FIFO (`resolveOldestPendingForQueue`) puede drenar basura de sesiones previas y atribuirla a la pregunta actual (motivo por el que se pide eco de `correlationId` al RAG) |

## 1.12 Webhook de WhatsApp — recepción

**Precondición:** `webhooks/whatsapp` sin `JwtAuthGuard` (Meta no manda token propio). El GET
valida el verify token; el POST publica en `whatsapp.incoming`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-WHK-01 | GET de verificación con `hub.verify_token` correcto y `mode=subscribe` | Devuelve el `challenge` como cuerpo de la respuesta (Content-Type `text/html` por el default de Nest para un string) |
| BE-WHK-02 | GET de verificación con token incorrecto | 403 "verify_token inválido" |
| BE-WHK-03 | POST con un mensaje de texto | 200 `{ status: ok }`, publica `{ from: +<num>, body }` en `whatsapp.incoming` |
| BE-WHK-04 | POST con una respuesta interactiva (botón/lista) | Publica el `id` de la opción como `body` |
| BE-WHK-05 | POST con un tipo no soportado (imagen, audio) | Se ignora ese mensaje (warn), 200 igual |
| BE-WHK-06 | POST sin `messages` (ej. `statuses` de entrega) | 200 `{ status: ok }`, no genera nada |
| BE-WHK-07 | POST sin tenant configurado ni tenant en el sistema | 200 `{ status: ignored }`, loguea error |
| BE-WHK-08 | POST con `X-Hub-Signature-256` **ausente o inválida** | **Se rechaza** (401/403) antes de encolar: la firma se valida con el App Secret de Meta. ⚠️ Hoy se **procesa igual** sin validar firma (SEC-04): `❌` hasta validar `X-Hub-Signature-256` |
| BE-WHK-09 | POST con `X-Hub-Signature-256` **válida** | 200 `{ status: ok }`, publica en `whatsapp.incoming` (el camino legítimo sigue funcionando tras sumar la validación) |
| BE-WHK-10 | POST **sin** `WHATSAPP_TENANT_ID` pero con al menos una empresa en el sistema | Asigna el mensaje al tenant **más antiguo** (fallback de desarrollo) y publica en `whatsapp.incoming` |

## 1.13 Conector de salida de WhatsApp (`WhatsAppService`)

**Precondición:** `WhatsAppService` consume la cola `whatsapp.outgoing` y llama a la Cloud API
de Meta (`graph.facebook.com/{version}/{phoneNumberId}/messages`). La mecánica se prueba **sin
Meta** (mockeando `fetch` o inspeccionando el payload armado y el manejo de error); el envío
real de punta a punta contra Meta es el placeholder BE-PH-04.

> **Desde el PR de canales hay tres conectores de salida de WhatsApp intercambiables** — Meta
> (este bloque), **Twilio** (§1.19) y **Gupshup** (§1.20) — que consumen la misma cola
> `whatsapp.outgoing`. Cuál de los tres se suscribe lo decide el setting `WHATSAPP_PROVIDER`
> (default `meta`), leído una sola vez al arrancar. El motor de conversaciones no sabe cuál está
> activo. La selección de proveedor y sus bordes se cubren en BE-TWA-01/02 y BE-GUP-01.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-WAO-01 | Encolar un mensaje en `whatsapp.outgoing` | `WhatsAppService` (suscripto en `onModuleInit`) lo consume y llama a `sendText(to, body, interactive?)` |
| BE-WAO-02 | `sendText` sin `WHATSAPP_API_TOKEN` o sin `WHATSAPP_PHONE_NUMBER_ID` | Warn y **no** envía (retorna sin lanzar): el consumer no se rompe |
| BE-WAO-03 | `sendText` de texto libre con credenciales | POST a `graph.facebook.com/{version}/{phoneNumberId}/messages` con `Authorization: Bearer` y payload `{ type:'text', text:{ body } }` |
| BE-WAO-04 | `sendText` interactivo de **botones** | `buildInteractivePayload` arma `type:'button'` con `action.buttons[].reply{ id, title }` |
| BE-WAO-05 | `sendText` interactivo de **lista** | Arma `type:'list'` con `action.button` + `sections[0].rows[]` (id/title/description) |
| BE-WAO-06 | Destinatario con `WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES` (`from:to`) | `resolveRecipient` mapea el número normalizado al override; sin override, normaliza a E.164 (sólo dígitos) |
| BE-WAO-07 | La API de WhatsApp no responde / timeout (10s) | Loguea el error y **lanza** (el broker hace `safeNack`: descarta el mensaje, no lo re-encola) |
| BE-WAO-08 | La API responde **no-ok** (ej. 131030 por formato de número) | Loguea `status` + detalle (primeros 500 chars) y lanza `WhatsApp API error <status>` |
| BE-WAO-09 | Sin `WHATSAPP_API_VERSION` configurada | Usa `v26.0` por defecto en la URL |

## 1.14 Canal de email (SMTP)

**Precondición:** el email es el canal por el que se entrega el **código del segundo factor** y
por el que se notifica a los agentes en una transferencia. Toda su configuración (host, puerto,
conexión segura, usuario, contraseña y remitente) se resuelve en cascada BD → env → default,
igual que el resto de `/settings`; la contraseña está marcada como secreto. Sin host
configurado el envío cae a escribir el mensaje en consola, que es el comportamiento normal en
desarrollo.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-EML-01 | Disparar un envío **sin** host configurado | No falla: registra el aviso y sigue. El cuerpo del mensaje **no** debería escribirse (hoy sí se escribe, junto con el código del segundo factor — ver BE-AUTH-21 y SEC-10) |
| BE-EML-02 | Disparar un envío con host válido y credenciales correctas | El mensaje llega; el log deja constancia del destinatario y el asunto, nunca del cuerpo |
| BE-EML-03 | **Login con segundo factor y un servidor de correo configurado pero caído** (host inalcanzable o credenciales inválidas) | **Debe** cortar con un error controlado ("no pudimos enviarte el código, probá de nuevo") y no dejar un código huérfano vivo. ⚠️ Hoy el fallo del envío **se propaga sin capturar**: el login devuelve 500 con el código ya guardado en memoria: `❌` hasta blindar el envío |
| BE-EML-04 | Mismo fallo del servidor de correo, pero durante una **notificación de transferencia a agente** dentro de una conversación | La conversación no se rompe: el usuario recibe respuesta igual y el fallo del aviso queda en el log |
| BE-EML-05 | Envío **sin** remitente configurado | Usa el remitente por defecto del sistema, no falla por falta de `from` |
| BE-EML-06 | Puerto y "conexión segura" tomados de la configuración | Puerto 587 por defecto con conexión segura desactivada; con 465 y conexión segura activada también conecta |
| BE-EML-07 | Host configurado **sin** usuario ni contraseña | Conecta sin autenticación (servidor interno de relay), no exige credenciales |
| BE-EML-08 | La contraseña del servidor de correo, leída desde la API | Enmascarada + el indicador de "cargada", nunca en claro; tampoco aparece en logs (mismo trato que las claves de los proveedores de modelo) |

## 1.15 Datos, seed y migraciones

**Precondición:** todo el plan corre sobre el escenario del **Apéndice C**, montado encima de
una base recién migrada con el seed aplicado. Estos casos verifican ese punto de partida, que
el resto de las secciones da por hecho.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-DAT-01 | Aplicar las migraciones sobre una base **vacía** | Se aplican todas en orden, sin error ni intervención manual; el esquema queda al día |
| BE-DAT-02 | Correr el seed sobre la base recién migrada | Deja la empresa de sistema, el rol de superusuario con el catálogo completo, el usuario administrador y los valores de configuración iniciales |
| BE-DAT-03 | Correr el seed **dos veces seguidas** | Es idempotente: no duplica filas ni pisa cambios hechos a mano sobre esos registros |
| BE-DAT-04 | Dar de baja una empresa y revisar sus datos | Sus roles, áreas, usuarios y flujos dejan de aparecer en las vistas de todas las empresas, pero las filas siguen existiendo: la baja es lógica, nunca borrado físico |
| BE-DAT-05 | Borrar un flujo y un área (borrados **físicos**) | El borrado en cascada limpia lo dependiente (asignaciones de empresa y rol del flujo) y no deja filas huérfanas apuntando a lo borrado |

## 1.16 Endpoints públicos (`AppController`)

**Precondición:** rutas sin prefijo ni guards. `GET /` es de salud; `/privacy-policy` y
`/company` sirven HTML para completar la ficha de la app en Meta for Developers.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-APP-01 | `GET /` | 200 con el saludo (`AppService.getHello`) |
| BE-APP-02 | `GET /privacy-policy` | 200 con `Content-Type: text/html`; devuelve la política de privacidad |
| BE-APP-03 | `GET /company` | 200 con `Content-Type: text/html`; devuelve el sitio de empresa |

## 1.17 Seguridad transversal — casos de aceptación de hallazgos abiertos

Casos para los hallazgos de seguridad que no tienen un hogar funcional único (afectan a varios
endpoints o a la configuración del proceso). Como el resto de los casos negativos de seguridad,
expresan el comportamiento **seguro deseado**: hoy quedan en `❌` y pasan a `✅` al corregirlos.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-SEC-01 | `POST /conversations/simulate` sin autenticación (y con el tenant en el body) | **Debe** exigir auth (o una key de servicio), tomar el tenant del header validado y tipar el body como DTO. ⚠️ Hoy no tiene guard, toma el tenant del body y el body no pasa por la validación global (SEC-02): `❌` hasta protegerlo. Su ejercicio funcional legítimo es CHAT-E2E-01 |
| BE-SEC-02 | Ráfaga de requests a `login`/`verify-otp` (y al resto de endpoints) | **Debe** haber throttling por IP/usuario, más estricto en auth → el exceso recibe 429. ⚠️ Hoy no hay rate limiting en ningún endpoint (SEC-05), lo que vuelve práctico SEC-01: `❌` hasta agregarlo |
| BE-SEC-03 | Request con un `Origin` arbitrario y credenciales | **Debe** aceptarse sólo si el origen está en una lista conocida. ⚠️ Hoy CORS **refleja** cualquier `Origin` y habilita credenciales (SEC-12): `❌` hasta restringir la lista |

## 1.18 Módulos e integraciones pendientes — placeholders 🚧

Casos redactados para lo que **todavía no está implementado**. Marcados para no confundir
cobertura real con cobertura futura.

| ID | Escenario | Detalle |
|----|-----------|---------|
| BE-PH-01 | Módulo `invgate`: crear/leer/actualizar tickets vía el usuario técnico de API | ✅ **Ya no es placeholder:** el PR implementó el módulo. Cobertura real en §1.21 (`BE-IG-*`). Lo único que sigue bloqueado es la validación end-to-end contra una instancia InvGate real (ver BE-IG-14): falta un token de API real (el cargado resultó ser la contraseña de portal de un usuario) |
| BE-PH-02 | Módulo `metrics`: registro y consulta de métricas de conversación | Módulo vacío. Definir casos al implementarlo (Hito 4) |
| BE-PH-03 | Módulo `devices`: endpoints de gestión de dispositivos | Módulo vacío (la lógica de fingerprint hoy vive en `auth`) |
| BE-PH-04 | Envío **end-to-end real** contra la Cloud API de Meta | La mecánica del conector **ya está implementada** y cubierta en §1.13 (`BE-WAO-*`). Sólo lo que depende de Meta: validar el envío de punta a punta con `WHATSAPP_API_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` y el sandbox |
| BE-PH-05 | Nodo `webhook` del flujo con llamada HTTP real | Hoy es stub. Al implementarlo: cubrir SSRF, timeout y validación de URL (ver SEC en apéndice) |
| BE-PH-06 | Envío **end-to-end real** de SMS por Twilio | La mecánica del conector ya está en §1.21 (`BE-SMS-*`). Bloqueado: falta un número de Twilio habilitado para SMS (el sandbox de WhatsApp no sirve). Cuando llegue: validar el envío de punta a punta |

## 1.19 Canal WhatsApp — Twilio (`TwilioWhatsAppService` + `TwilioWebhookController`)

**Precondición:** alternativa a la Cloud API de Meta, activada con `WHATSAPP_PROVIDER=twilio`
(se lee **una sola vez al arrancar**). Recepción por `POST webhooks/twilio`; salida consumiendo
`whatsapp.outgoing`, el **mismo contrato de colas** que Meta, así que `ConversationsService` no
sabe cuál proveedor está activo. Credenciales: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
(secreto) y `TWILIO_WHATSAPP_FROM`. Los menús nativos van por la **Content API** (un Content
Template pre-creado por **forma** de menú, cacheado en la tabla `TwilioContentTemplate` por
`shapeHash`, con un `Map` en memoria como capa L1).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-TWA-01 | Arrancar con `WHATSAPP_PROVIDER=twilio` | Sólo `TwilioWhatsAppService` se suscribe a `whatsapp.outgoing`; Meta y Gupshup loguean "inactivo" y no consumen (evita que dos consumidores compitan por la cola en round-robin) |
| BE-TWA-02 | Cambiar `WHATSAPP_PROVIDER` en `/settings` sin reiniciar | **No** re-suscribe: el valor se lee sólo al arrancar. Choca con el texto de `/settings` que promete "aplican sin reiniciar" (documentado en la descripción del propio setting) |
| BE-TWA-03 | `POST webhooks/twilio` con un mensaje de texto | 200; normaliza el `from` y publica `{ from, body, channel:'whatsapp' }` en `whatsapp.incoming` |
| BE-TWA-04 | `POST webhooks/twilio` con la respuesta a un botón/lista (Content) | Publica el **`id`** de la opción como `body` (mismo contrato que Meta, BE-WHK-04) |
| BE-TWA-05 | Encolar en `whatsapp.outgoing` un texto simple (provider=twilio) | `TwilioWhatsAppService` lo consume y hace el `POST` a la API de Twilio desde `TWILIO_WHATSAPP_FROM` (prefijo `whatsapp:`) |
| BE-TWA-06 | Encolar un menú (≤3 botones / lista) por primera vez | Crea un Content Template por **forma** de menú: hash de la forma (tipo + botones/filas, **sin** el body) → busca en memoria → en `TwilioContentTemplate` → si no está, lo crea en Twilio y lo persiste. El body viaja como variable `{{1}}` |
| BE-TWA-07 | Segundo menú con la **misma forma** pero distinto texto de body | Reusa el mismo `ContentSid` (el hash no incluye el body): no crea un template nuevo |
| BE-TWA-08 | La Content API falla al crear o enviar el template | Degrada a **texto numerado** en vez de perder el mensaje |
| BE-TWA-09 | `sendText` sin `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_FROM` | Warn y **no** envía (retorna sin lanzar): el consumer no se rompe (paridad con BE-WAO-02) |
| BE-TWA-10 | `POST webhooks/twilio` **sin** `X-Twilio-Signature` válida | **Debe** rechazarse validando el HMAC con el auth token antes de encolar. ⚠️ Hoy **acepta cualquier POST** sin validar firma (SEC-16): `❌`. Agravante: el webhook está activo **aunque `WHATSAPP_PROVIDER`≠twilio** |
| BE-TWA-11 | Carrera: dos requests crean el mismo Content Template a la vez | `P2002` en `shapeHash` único; el que pierde usa el `ContentSid` **huérfano** que él creó (válido en Twilio, distinto del persistido en BD). Documentar la divergencia memoria-vs-BD y el template sin uso en la cuenta de Twilio |

## 1.20 Canal WhatsApp — Gupshup (`GupshupWhatsAppService` + `GupshupWebhookController`)

**Precondición:** otra alternativa a Meta, activada con `WHATSAPP_PROVIDER=gupshup`. Recepción
por `POST webhooks/gupshup`; salida consumiendo `whatsapp.outgoing`. A diferencia de Twilio, los
interactivos van **inline** (`quick_reply`/`list`), sin templates pre-creados. Credenciales:
`GUPSHUP_API_KEY` (secreto), `GUPSHUP_WHATSAPP_SOURCE` y `GUPSHUP_APP_NAME`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-GUP-01 | Arrancar con `WHATSAPP_PROVIDER=gupshup` | Sólo `GupshupWhatsAppService` se suscribe a `whatsapp.outgoing` |
| BE-GUP-02 | `POST webhooks/gupshup` con texto | 200; publica `{ from:+<num>, body, channel:'whatsapp' }` (agrega el prefijo `+` al número) |
| BE-GUP-03 | Encolar un menú | `buildInteractiveMessage` lo traduce a `quick_reply` (≤3) o `list` y lo manda inline en el mismo request |
| BE-GUP-04 | El usuario toca una opción | Vuelve el **`id`** de la opción como `body` |
| BE-GUP-05 | `sendText` sin `GUPSHUP_API_KEY`/`SOURCE`/`APP_NAME` | Warn y **no** envía; no rompe el consumer |
| BE-GUP-06 | `POST webhooks/gupshup` sin ninguna verificación de autenticidad | **Debe** verificar que el POST viene de Gupshup. ⚠️ Hoy **acepta cualquier POST** (SEC-16): `❌` |
| BE-GUP-07 | Menú de tipo lista con `buttonText` | Reusa `buttonText` como header/título de la lista, sin equivalente real en el tipo interno `WhatsAppInteractive`; el propio comentario del código pide **confirmarlo contra tráfico real** antes de producción |

## 1.21 Canal SMS (Twilio y Gupshup) — canal propio

**Precondición:** SMS es un **canal independiente**, no un fallback de WhatsApp. Colas propias
`sms.incoming`/`sms.outgoing` y `Conversation` con `channel:'sms'` separada: un mismo usuario
puede tener charla activa por WhatsApp **y** por SMS a la vez. El proveedor lo decide
`SMS_PROVIDER` (`twilio` default / `gupshup`), leído al arrancar. Twilio **reusa** la cuenta de
Twilio-WhatsApp (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`) y sólo cambia el número
(`TWILIO_SMS_FROM`). Gupshup usa su API legacy (`GUPSHUP_SMS_USERID` + `GUPSHUP_SMS_PASSWORD`
secreto). SMS **no** tiene interactivo: los menús se degradan a texto numerado.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-SMS-01 | `handleMessage` con un mensaje `channel:'sms'` | Resuelve/crea la `Conversation` del canal `sms` (independiente de la de `whatsapp` del mismo usuario) y rutea la respuesta a `sms.outgoing` (`${channel}.outgoing`) |
| BE-SMS-02 | `SMS_PROVIDER=twilio` | Sólo `TwilioSmsService` consume `sms.outgoing`; Gupshup inactivo |
| BE-SMS-03 | `SMS_PROVIDER=gupshup` | Sólo `GupshupSmsService` consume `sms.outgoing` |
| BE-SMS-04 | `POST webhooks/twilio-sms` con texto | Publica `{ from, body, channel:'sms' }` en `sms.incoming` |
| BE-SMS-05 | `POST webhooks/gupshup-sms` | Mapea **best-effort** los campos candidatos (`phno`/`mobile`/`from`/`sender`, `text`/`msg`/`message`) y publica en `sms.incoming`. ⚠️ Puede **no funcionar** hasta ajustarlo con tráfico real (reconocido en el propio código) |
| BE-SMS-06 | Menú del flujo enviado por **Twilio SMS** | Se degrada a texto numerado (`appendInteractiveAsText`), conservando el orden para que el índice tipeado matchee el `case 'menu'` |
| BE-SMS-07 | Menú del flujo enviado por **Gupshup SMS** | ⚠️ **Bug real:** `GupshupSmsService` **descarta** el `interactive` (sólo manda el `body`): el usuario recibe "Elegí una opción:" **sin las opciones** y no sabe qué tipear. **Debe** anexar las opciones numeradas como Twilio SMS: `❌` hasta emparejarlo (robustez, sin número de hallazgo) |
| BE-SMS-08 | Twilio SMS reusando la cuenta de WhatsApp | Usa `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, saca el prefijo `whatsapp:` y envía desde `TWILIO_SMS_FROM` |
| BE-SMS-09 | `POST webhooks/twilio-sms` o `webhooks/gupshup-sms` sin firma/autenticación | **Debe** rechazar. ⚠️ Hoy ambos aceptan cualquier POST (SEC-16): `❌` |
| BE-SMS-10 | Gupshup SMS legacy: inspeccionar la request de salida | ⚠️ Manda `userid`/`password` en la **query string** de un `GET` → pueden filtrarse a logs de proxies (SEC-21): `❌`. La verificación de éxito (`startsWith('success')` sobre texto plano) es frágil |

## 1.22 Integración InvGate (`InvgateService` + catálogo)

**Precondición:** cliente HTTP contra la API real de InvGate Service Desk — **Basic Auth**, base
`INVGATE_API_URL` + prefijo `/api/v1`, writes **form-encoded**, timeout de 15s. Autentica siempre
con el **usuario técnico dedicado** (`INVGATE_API_USER`/`INVGATE_API_KEY`, key secreta), nunca con
credenciales del usuario final. **Best-effort:** si InvGate falla, el `Ticket` local existe igual y
la charla no se corta. El catálogo real se expone en `GET /invgate/catalog/{categories,priorities,types}`
con permiso `flows:read` (no un permiso propio).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-IG-01 | Nodo Generar Ticket (`ticket_create`) | Crea el `Ticket` **local** y luego lo empuja a InvGate (`syncTicketToInvgate`), best-effort |
| BE-IG-02 | `ticket_query` de un ticket ya sincronizado | Trae el `status_id` real de InvGate y lo traduce a nombre legible (`getStatusName`); actualiza el estado local |
| BE-IG-03 | `GET /invgate/catalog/{categories,priorities,types}` con `flows:read` | Devuelve el catálogo **real** de la instancia, para armar los dropdowns del editor de flujos |
| BE-IG-04 | `GET /invgate/catalog/*` sin `flows:read` | 403 |
| BE-IG-05 | Resolución de `category`/`priority`/`ticketType` por **nombre** | El nodo guarda el nombre; `resolveXId` lo matchea contra el catálogo (match **exacto**, normalizado sin acentos/mayúsculas). Sin match → default de `/settings` (`INVGATE_DEFAULT_*`) |
| BE-IG-06 | Resolución del `customer_id` del usuario final | Por el `invgateUserId` guardado, o búsqueda por teléfono (`findUserByPhone`), cacheado en el `User` local |
| BE-IG-07 | `creator_id` en cada ticket | Siempre el usuario técnico (`INVGATE_API_USER`), nunca el usuario final; el Basic Auth usa siempre las credenciales del técnico |
| BE-IG-08 | InvGate caído o mal configurado durante `ticket_create` | Best-effort: `warn`, el `Ticket` local ya existe y la charla sigue (timeout de 15s, no re-encola) |
| BE-IG-09 | `INVGATE_API_KEY` leída desde `/settings` | Enmascarada + `isSet`, nunca en claro; cifrada AES-256-GCM; nunca logueada (`sanitize` redacta el token de los errores) |
| BE-IG-10 | Cambiar `INVGATE_API_URL`/`INVGATE_API_USER` en `/settings` en caliente y crear un ticket | **Debería** tomar la config nueva sin reiniciar. ⚠️ Hoy los cachés en memoria (`creatorId`/`status`/`priority`/`type`/`category`) **no se invalidan**; peor, `resolveCreatorId` **cachea `null` permanente**: si al arranque el técnico no matcheó, corregirlo en `/settings` **no crea tickets** hasta reiniciar: `❌` (robustez, sin número de hallazgo) |
| BE-IG-11 | `INVGATE_API_URL` con esquema `http://` | **Debe** exigirse HTTPS: con `http://` el Basic Auth viaja en **texto claro** por la red (SEC-20): `❌` |
| BE-IG-12 | Rama de catálogo con más de 4000 categorías bajo el `parent` | `listCategoriesByParent` corta a 4000 (20 páginas × 200) **sin avisar** → faltarían opciones sin error. Documentar el tope silencioso |
| BE-IG-13 | Script `pnpm --filter api invgate:check` (`invgate-check.mjs`) | Chequea conectividad y lista IDs reales del catálogo por consola (fuera de Nest); falla con mensaje claro si faltan credenciales o si la auth da 401. Acepta `--find-user <valor> --by phone\|username\|email` |
| BE-IG-14 | Crear/consultar ticket **end-to-end** contra InvGate real | Placeholder (ver BE-PH-01): el valor cargado como token resultó ser la contraseña de portal de un usuario; pendiente que el admin genere un token de API real |

## 1.23 Skills (`SkillsService` + `SkillsController`)

**Precondición:** una `Skill` es **texto de contexto libre por empresa** (`promptText`, hasta 8000
caracteres) que se concatena al system prompt base (`buildBasePrompt`). CRUD en `/skills` con la
cadena estándar `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)` y permisos
`skills:read/create/update/delete` (**por empresa**, sin `SystemTenantGuard`). Único
`[name, tenantId]`. Se vincula a un flujo con `Flow.skillId` (FK nullable, `onDelete: SetNull`).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-SKL-01 | `GET /skills` parado en un tenant | Sólo las skills de ese tenant |
| BE-SKL-02 | `POST /skills` con `name` y `promptText` | 201; scopeada por `@CurrentTenant()` (nunca por el body) |
| BE-SKL-03 | `POST /skills` con un `name` ya usado en la empresa | 409 (único por empresa); el mismo `name` en otra empresa → 201 |
| BE-SKL-04 | `GET`/`PATCH`/`DELETE /skills/:id` de una skill de **otra** empresa | 404 (`getOwned` filtra por `tenantId`) |
| BE-SKL-05 | `PATCH /skills/:id` cambiando el `promptText` | 200; actualiza |
| BE-SKL-06 | `DELETE /skills/:id` de una skill **vinculada a un flujo** | 200; `Flow.skillId` queda en `null` (`onDelete: SetNull`), el flujo no se rompe |
| BE-SKL-07 | Cualquier operación sin el permiso `skills:*` | 403 "Permiso denegado: skills:acción" |
| BE-SKL-08 | Un `Flow` compartido (`TenantFlow` N:N) entre la empresa **A** (dueña de la skill) y **B**; una charla del tenant **B** pasa por ese flujo | **No debe** filtrar: la skill de A no tendría que inyectarse en las conversaciones de B. ⚠️ Hoy `findById` carga `skill.promptText` **sin re-chequear el tenant en curso** → el texto de A entra en el prompt de B. A diferencia de la fuente de verdad (que falla-seguro por tenant), la skill **filtra en silencio** (SEC-17): `❌` |
| BE-SKL-09 | `POST`/`PATCH /flows` con un `skillId` de **otra** empresa | **Debe** rechazar (no pertenece al tenant activo). ⚠️ Hoy `FlowService.create/update` propagan `skillId` por spread **sin validar pertenencia**; la FK sólo valida existencia (SEC-17): `❌` |
| BE-SKL-10 | Marcar una Skill como `isActive:false` y usar un flujo vinculado a ella | **Debería** dejar de concatenarse. ⚠️ Hoy el motor **no chequea `isActive`** (`findById` ni lo trae): el texto se inyecta igual. El flag es letra muerta en el motor: `❌` (robustez, sin número de hallazgo) |

---

# 💬 Sección 2 — Chatbot

El motor de flujos es `ConversationsService`. Cada mensaje entra por `handleMessage` (misma
lógica para el canal real y para `simulate`), que resuelve identidad y conversación, y ejecuta
el flujo activo encadenando nodos hasta toparse con una espera, un cierre o el fin.

**Precondición general:** hay un tenant con un flujo de inicio asignado a un rol, y usuarios
conocidos (con membresía) y desconocidos (sin membresía). Todos los casos se ejecutan con
`POST /conversations/simulate` (o el chat por consola).

## 2.1 Pipeline de un mensaje (`handleMessage`)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-PIPE-01 | Primer mensaje de un número nuevo | Crea contacto placeholder, crea conversación, ejecuta el flujo |
| CHAT-PIPE-02 | Mensaje dirigido a un tenant **dado de baja** (canal real) | Se ignora en silencio (`return ''`), sin crear usuario ni gastar LLM |
| CHAT-PIPE-03 | Mismo caso pero por `simulate` (con `replyTo`) | Responde un aviso, no cuelga al llamador |
| CHAT-PIPE-04 | Segundo mensaje dentro de la ventana de reanudación (12h) tras cerrar | Reabre la conversación cerrada, mantiene historial |
| CHAT-PIPE-05 | Mensaje tras vencer la ventana de reanudación | Crea una conversación nueva |
| CHAT-PIPE-06 | Se persiste el mensaje del usuario y luego el del asistente | Ambos quedan en `Message` con `senderType` correcto |
| CHAT-PIPE-07 | Dos mensajes del mismo teléfono, uno con `channel:'whatsapp'` y otro con `channel:'sms'` | Cada uno resuelve/crea **su propia** `Conversation` (una por canal), no se pisan; la respuesta de cada uno va a `${channel}.outgoing`. `handleMessage` es channel-aware (el resto del motor de flujos/LLM no sabe de canales) |
| CHAT-PIPE-08 | Mensaje entrante **sin** `channel` explícito | Default `whatsapp` (retrocompatible): resuelve la conversación de WhatsApp y rutea a `whatsapp.outgoing` |

## 2.2 Arranque de flujo por tenant y rol

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-START-01 | Usuario **conocido** cuyo rol tiene flujo de inicio | Arranca ese flujo |
| CHAT-START-02 | Usuario **desconocido** (sin membresía) | No hay rol → cae al flujo `isDefault` global |
| CHAT-START-03 | Rol conocido sin flujo de inicio propio | Cae al default global |
| CHAT-START-04 | No hay flujo de inicio ni default activo | `executeFlow` devuelve `null` → responde el orquestador LLM |
| CHAT-START-05 | Mismo teléfono, conocido en el tenant A y desconocido en el B | En A arranca su flujo; en B va por la rama de desconocido |

## 2.3 Nodos del motor — uno por uno

**Precondición:** flujos armados a propósito para aislar cada tipo de nodo. `data` = la
config del nodo en el editor.

### `start`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-START-01 | Entrada de un usuario conocido | Saluda "¡Hola {nombre}! Bienvenido de nuevo."; siembra `userName/userEmail/userRole…` en el estado; enruta por el handle `known` |
| CHAT-N-START-02 | Entrada de un usuario desconocido | Usa `data.text` o saludo genérico; enruta por el handle `unknown` |
| CHAT-N-START-03 | Conocido sin `firstName` cargado | Saluda sin romper (dejar registrado el saludo con espacio de más como cosmético) |
| CHAT-N-START-04 | `start` sin aristas `known`/`unknown` ni `*TargetNodeId` | Cae a la primera arista saliente |

### `message`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-MSG-01 | Nodo con `data.text` | Emite el texto y avanza al siguiente sin esperar |
| CHAT-N-MSG-02 | Nodo sin `data.text` | No acumula respuesta; avanza igual |

### `end`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-END-01 | Nodo `end` con texto | Emite el texto y cierra la conversación (reabrible 12h) |
| CHAT-N-END-02 | Nodo `end` sin texto | Cierra igual, sin texto de despedida |

### `device_validation` (OTP por email dentro del flujo)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-DEV-01 | Usuario sin email real (o `@local.pci` autogenerado) | Mensaje de error y cierre (no puede validar sin email) |
| CHAT-N-DEV-02 | Dispositivo ya validado y vigente | Pasa transparente, sigue de largo |
| CHAT-N-DEV-03 | Dispositivo no validado | Envía código por email, queda esperando el código |
| CHAT-N-DEV-04 | Código correcto dentro del TTL | Registra el device (`expiresAt`), sigue de largo |
| CHAT-N-DEV-05 | Código incorrecto | "Ese código no es correcto…", sigue esperando |
| CHAT-N-DEV-06 | Código vencido mientras se espera | Reenvía uno nuevo con aviso "Ese código venció…" |
| CHAT-N-DEV-07 | Dispositivo validado pero con **otro** `userId` | No lo da por válido, pide validar |
| CHAT-N-DEV-08 | Fijar `OTP_CODE_LENGTH` ≠ 6 y disparar la validación de dispositivo | El código enviado hereda la longitud configurada (`otpCodeLength()`) y el TTL de `OTP_TTL_SECONDS`, no un fijo. Nota: se genera con `Math.random()` (no criptográfico) como el OTP de login (SEC-01), pero acá el código está atado a la sesión del flujo (`__deviceValidationCode`), así que **no** es forzable como aquel |

### `menu` (interactivo, dos fases, con fallback LLM)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-MENU-01 | Primera llegada con ≤3 opciones | Muestra el menú como **botones** (título truncado a 20) y espera |
| CHAT-N-MENU-02 | Primera llegada con 4–10 opciones | Muestra el menú como **lista** (título truncado a 24) |
| CHAT-N-MENU-03 | Primera llegada con 0 o >10 opciones | Cae a texto numerado (`1. …`) |
| CHAT-N-MENU-04 | Respuesta por número (`2`) | Matchea la opción 2, enruta por su handle |
| CHAT-N-MENU-05 | Respuesta por label o por value exactos | Matchea y enruta igual |
| CHAT-N-MENU-06 | Respuesta en lenguaje natural equivalente a una opción | El LLM (`interpretMenuChoice`) la mapea y enruta |
| CHAT-N-MENU-07 | Respuesta de cancelación coloquial | El LLM la interpreta como cancelación → cierra la gestión |
| CHAT-N-MENU-08 | Respuesta que no matchea ninguna opción ni es cancelación | Entra en **fallback LLM**: el menú queda "secuestrado", los siguientes mensajes van al LLM |
| CHAT-N-MENU-09 | El LLM falla (proveedor caído) al interpretar la opción | No corta la charla: el catch trata el mensaje como no-cancelación y la conversación pasa al **fallback LLM** (mismo camino que CHAT-N-MENU-08), no vuelve a insistir con el menú |
| CHAT-N-MENU-10 | Opción con `sourceHandle` sin arista pero con `targetNodeId` | Enruta por `targetNodeId` |
| CHAT-N-MENU-11 | Submenú al que se llegó eligiendo una opción de otro menú (pila `__menuStack` no vacía) | Se agrega automáticamente la opción sintética **"Volver"** (`__volver`), sin cablearla en el editor |
| CHAT-N-MENU-12 | Menú raíz del flujo (pila `__menuStack` vacía) | **No** ofrece "Volver" (no hay menú anterior al cual regresar) |
| CHAT-N-MENU-13 | Elegir "Volver" (por número, por label, o "volvé"/"atrás" interpretado por el LLM) | Desapila el tope y regresa a ese menú; si el menú anterior es de **otro flujo** (se llegó por `subflow`), cruza el límite reusando el mecanismo de cambio de flujo |
| CHAT-N-MENU-14 | Un menú que ya tiene 10 opciones y le toca sumar "Volver" | Se pasa del límite de lista de WhatsApp y cae a **texto plano numerado** (sin límite, sin romper) |

### `input`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-INP-01 | Primera llegada | Muestra la pregunta (`data.text`) y espera |
| CHAT-N-INP-02 | Respuesta con `data.variableName` seteado | Guarda el valor en el estado y avanza |
| CHAT-N-INP-03 | Respuesta sin `variableName` | Avanza sin guardar |
| CHAT-N-INP-04 | Respuesta que parece cancelación, confirmada por el LLM | Cancela la gestión (`cancelFlow`) |
| CHAT-N-INP-05 | Respuesta que parece cancelación pero el LLM dice continuar | Guarda el texto y avanza |

### `condition`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-CND-01 | Condición `keyword` que matchea el mensaje | Enruta al `targetNodeId` de esa condición |
| CHAT-N-CND-02 | Condición `regex` válida que matchea | Enruta a su target |
| CHAT-N-CND-03 | Condición `variable` con la variable "truthy" en el estado | Enruta a su target |
| CHAT-N-CND-04 | Ninguna condición matchea, con `defaultTargetNodeId` | Enruta al default |
| CHAT-N-CND-05 | Ninguna matchea, sin default | Cae a la primera arista saliente |
| CHAT-N-CND-06 | Condición `regex` con patrón **inválido** (ej. `[`) | La compilación está **protegida** (try/catch): la condición no matchea y el flujo sigue (cae a default o a la primera arista), sin tirar excepción; conviene además acotar/validar la regex del editor (ReDoS). ⚠️ Hoy lanza **excepción no capturada** y rompe el flujo (SEC-09): `❌` hasta blindar la compilación |
| CHAT-N-CND-07 | Condición `keyword` con valor vacío | `includes("")` siempre da true (dejar documentado el borde) |
| CHAT-N-CND-08 | Condición `keyword` o `variable` con el campo `value` **ausente** (no cargado en el editor) | **Debe** ignorar esa condición y seguir (cae a default o a la primera arista), sin romper. ⚠️ Hoy `cond.value.toLowerCase()` corre sobre `undefined` y lanza una excepción **no capturada** que corta la charla — mismo patrón que la regex inválida (SEC-09) y el subflujo inexistente (SEC-15): `❌` hasta blindar la evaluación de condiciones |
| CHAT-N-CND-09 | Condición con un `type` **desconocido** (ni `keyword`/`regex`/`variable`) | Se ignora (no matchea); el flujo cae a `defaultTargetNodeId` o a la primera arista. Borde de configuración inválida, no rompe |

### `ticket_create` / `ticket_query`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-TKC-01 | `ticket_create` con subject/description de `data` o del estado | Crea el ticket con `userId`+`tenantId`, guarda `lastTicketId`, responde "Ticket #… creado" |
| CHAT-N-TKC-02 | `ticket_create` sin subject explícito | Usa los primeros 100 caracteres del mensaje |
| CHAT-N-TKC-03 | `ticket_create` tomando `priority` y `description` del nodo o del estado | `priority` = `data.priority` (o `medium` por defecto); `description` = `data.description` → `flowState.description` → mensaje, en ese orden |
| CHAT-N-TKC-04 | La creación del ticket falla (BD caída) dentro del nodo | Documenta el límite: `prisma.ticket.create` no está protegido, la excepción se propaga y hoy corta la charla (mismo patrón de robustez que CHAT-N-LLM-04 / SEC-15). Aplica a cualquier nodo con I/O de BD |
| CHAT-N-TKQ-01 | `ticket_query` con `lastTicketId` del propio tenant | Devuelve asunto y estado del ticket |
| CHAT-N-TKQ-02 | `ticket_query` sin ticket disponible | "No encontré el ticket solicitado." |
| CHAT-N-TKQ-03 | `ticket_query` con una variable de ticket que apunta a un ticket de **otro tenant** | **No lo devuelve**: la consulta filtra por el tenant (y por dueño cuando corresponde) → "No encontré el ticket solicitado." ⚠️ Hoy lo **devuelve igual** (SEC-08): `❌` hasta filtrar por tenant |
| CHAT-N-TKC-05 | `ticket_create` con `category`/`priority`/`ticketType` elegidos **por nombre** en el editor | Crea el `Ticket` local y lo sincroniza a InvGate **best-effort**; los nombres se resuelven contra el catálogo real (BE-IG-05). Si InvGate falla, el ticket local queda igual y la charla sigue (BE-IG-08) |
| CHAT-N-TKC-06 | `ticket_create` cuando el usuario final **no** matchea un `customer_id` de InvGate | El ticket **local** se crea igual; la sincronización a InvGate se saltea con `warn` (no corta la charla) |
| CHAT-N-TKQ-04 | `ticket_query` de un ticket **sincronizado** con InvGate | `refreshInvgateStatus` trae el estado real y lo traduce a nombre legible; si InvGate no responde, cae al estado local (best-effort) |

### `transfer_agent`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-TRF-01 | `methods` incluye `ticket` y hay assignee | Crea ticket asignado (round robin), guarda `lastTicketId` |
| CHAT-N-TRF-02 | `methods` incluye `email` | Notifica a assignee + watchers + collaborators (deduplicados) |
| CHAT-N-TRF-03 | `methods` con `ticket` pero sin assignees | No crea ticket (requiere assignee) |
| CHAT-N-TRF-04 | Varias conversaciones pasan por el mismo nodo de transferencia | El round robin rota; verificar que hoy el índice es **global por nodo**, no por conversación |
| CHAT-N-TRF-05 | `methods` incluye `phone` | Sin implementar: no debe romper el flujo |
| CHAT-N-TRF-06 | Nodo `transfer_agent` cuya nota `data.message` trae `{{variables}}` (ej. `{{descripcion}}`) | La nota se **interpola** antes de armar el mail y el ticket: el agente recibe los valores reales, no los `{{ }}` crudos. Regresión del bug en que la nota no pasaba por `interpolate` como sí lo hace el texto del chat |
| CHAT-N-TRF-07 | `methods` incluye `email` pero no hay assignee ni watchers ni collaborators (o `methods` vacío) | No manda ningún mail ni crea ticket; no rompe, sigue a la próxima arista. Borde de configuración incompleta |

### `sms`

**Precondición:** el nodo `sms` manda un SMS **proactivo** por el canal SMS a una lista de
destinatarios elegidos en el editor. `data.recipients` son **userIds** (no números escritos a
mano) y `data.message` se interpola. Publica directo a `sms.outgoing`; el envío real lo hace el
conector SMS activo (`SMS_PROVIDER`, ver §1.21).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-SMS-01 | Nodo `sms` con `message` y `recipients` válidos | Interpola el `message` y publica un mensaje en `sms.outgoing` por cada `recipient` que tenga `user.phone` cargado; a los que no tienen teléfono los **saltea**. Avanza a la próxima arista |
| CHAT-N-SMS-02 | Nodo `sms` sin `recipients` o sin `message` | No manda nada; avanza igual (borde de configuración incompleta) |
| CHAT-N-SMS-03 | Nodo `sms` con `SMS_PROVIDER` sin configurar (nadie consume `sms.outgoing`) | El nodo publica igual y avanza; el SMS **se pierde en silencio** por falta de consumidor. Documentar el borde |
| CHAT-N-SMS-04 | Nodo `sms` con un `recipientId` que apunta a un usuario de **otra** empresa | **No debe** mandarle SMS. ⚠️ Hoy `prisma.user.findMany({ where:{ id:{ in: recipientIds } } })` **no** scopea por `tenantId`: mandaría un SMS al teléfono de un usuario de otra empresa. El editor sólo ofrece usuarios del tenant, pero el id llega por `data` del flujo sin re-validar (SEC-18): `❌` hasta filtrar por empresa |

### `llm_query`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-LLM-01 | `llm_query` con arista saliente | Responde una vez con el modelo y avanza |
| CHAT-N-LLM-02 | `llm_query` **terminal** (sin arista) | Queda como punto final: los siguientes mensajes van directo al modelo sin repetir el saludo |
| CHAT-N-LLM-03 | `llm_query` con `systemPrompt` y `contextMessages` custom | Usa ese prompt y esa cantidad de historial |
| CHAT-N-LLM-04 | El proveedor LLM **falla** (caído o timeout) mientras se ejecuta un nodo `llm_query` | **Debe** degradar de forma segura sin cortar la charla (igual que CHAT-LLMF-04 promete para el orquestador). ⚠️ Hoy el nodo llama a `llmService.chat` **sin** `try/catch` y la excepción se propaga por `executeFlow`/`handleMessage` hasta el consumer del broker: la respuesta nunca se publica (por `simulate`, corta a los 300s con 504). A diferencia de `menu`/`input`, cuyas llamadas al LLM sí están blindadas: `❌` hasta blindar el nodo |
| CHAT-N-LLM-05 | `llm_query` de un flujo con una **Skill** vinculada | El `promptText` de la Skill se concatena al system prompt base (`buildBasePrompt`). ⚠️ En modo `replace` (**default**) un `systemPrompt` propio del nodo **reemplaza el base entero — y con él se pierde la Skill** para ese nodo; puede sorprender a quien configuró la Skill esperando que aplique en todos lados |
| CHAT-N-LLM-06 | `llm_query` con `data.systemPromptMode:'append'` y un `systemPrompt` propio | El prompt del nodo se **agrega a continuación** del base (`base + nodo`); en `replace` (default) lo reemplaza. Un `systemPromptMode` inválido cae a `replace` (el DTO valida sólo `@IsString`, sin `@IsIn(['replace','append'])`) |
| CHAT-N-LLM-07 | `llm_query` de un flujo con una `ContextSource` vinculada | Consulta la fuente **siempre** (ver CHAT-LLMF-07, comportamiento nuevo): inyecta la respuesta como mensaje `system` autoritativo antes de responder. Antes el nodo ignoraba por completo la fuente |

### `delay` / `variable` / `webhook` / `subflow`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-DLY-01 | `delay` con `seconds` dentro del tope | Espera ese tiempo y sigue |
| CHAT-N-DLY-02 | `delay` con `seconds` mayor a 10 | Se acota a 10s (no cuelga la request) |
| CHAT-N-VAR-01 | `variable` con `action:set` y `name` | Guarda `data.value` (o el mensaje) en el estado |
| CHAT-N-VAR-02 | `variable` con `action` distinto de `set` | No hace nada, avanza |
| CHAT-N-VAR-03 | `variable` con `action:set` pero **sin** `name` | No guarda nada (la condición exige `name`); avanza igual. Borde de configuración incompleta |
| CHAT-N-WHK-01 | Nodo `webhook` | Hoy responde "Acción webhook ejecutada (stub)." (🚧 sin HTTP real) |
| CHAT-N-SUB-01 | `subflow` con `flowId` válido | Cambia al sub-flujo entrando por su nodo de inicio (o `entryNodeId`) |
| CHAT-N-SUB-02 | `subflow` sin `flowId` | "Error: sub-flujo no configurado." |
| CHAT-N-SUB-03 | `subflow` con `flowId` inexistente | **Debe** dar un error controlado sin romper el flujo. ⚠️ Hoy `flowService.findById` lanza `NotFoundException` (el guard `if (!subFlow)` es código muerto) y la excepción se propaga sin captura hasta cortar la charla (`simulate` expira a los 300s → 504) (SEC-15): `❌` hasta blindarlo |
| CHAT-N-DEF-01 | Nodo de tipo desconocido | Responde `data.text` o "Nodo no implementado." |

## 2.4 Encadenamiento y tope de pasos

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-CHAIN-01 | Cadena de nodos no interactivos (`start → message → llm_query`) | Se recorre entera en un solo turno hasta la primera espera o el fin |
| CHAT-CHAIN-02 | Flujo con un ciclo entre nodos no interactivos | Se corta a los 25 pasos: resetea el flujo y avisa "Se interrumpió el flujo por un problema de configuración." |
| CHAT-CHAIN-03 | Nodo que se apunta a sí mismo | Se trata como "quedate esperando", no como 25 iteraciones |
| CHAT-CHAIN-04 | Flujo editado en caliente: el nodo actual ya no existe | Resetea el flujo y devuelve lo acumulado |
| CHAT-CHAIN-05 | Varios textos acumulados antes de un nodo interactivo | Se fusionan en el `body` del mensaje interactivo (un solo texto junto a los botones) |

## 2.5 Espera en dos fases (`waitForInput`)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-WAIT-01 | Llegar a un `menu`/`input` | Persiste el nodo actual y el estado; devuelve el turno al usuario |
| CHAT-WAIT-02 | El siguiente mensaje reanuda | Retoma desde el mismo nodo e interpreta el mensaje como la respuesta |
| CHAT-WAIT-03 | Respuesta inválida que no cambia de modo (código OTP errado, opción inexistente) | Vuelve a persistir el mismo nodo y sigue esperando |

## 2.6 Conocido vs desconocido

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-KNOWN-01 | Número con membresía (`UserTenant` + `Role`) en el tenant | `isKnown:true`; el flujo lo trata como conocido |
| CHAT-KNOWN-02 | Número con fila `User` pero **sin** membresía en el tenant | `isKnown:false` (no alcanza con que exista el `User`) |
| CHAT-KNOWN-03 | Número de una persona dada de baja | Desconocido (la baja rompe la membresía) |
| CHAT-KNOWN-04 | Verificar que "conocido" se resuelve una sola vez, antes de crear el placeholder | El nodo `start` no reconsulta (no reaparece el bug histórico de "siempre conocido") |

## 2.7 LLM dentro y fuera del flujo

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-LLMF-01 | Mensaje sin flujo activo/default | Responde el `orchestratorLlm` (fuera de flujo) |
| CHAT-LLMF-02 | El usuario menciona "ticket #123" fuera de flujo | Agrega el contexto del ticket (scopeado por tenant) a la respuesta |
| CHAT-LLMF-03 | El usuario menciona dígitos parciales de un id de ticket ajeno de la misma empresa | **No matchea el ticket ajeno**: el match es por id **exacto** y filtrado por el **dueño** de la conversación; no se inyecta contexto de un ticket de otro usuario. ⚠️ Hoy el `contains` puede matchear el ticket de otro usuario de la empresa (SEC-11): `❌` hasta exigir match exacto + filtro por dueño |
| CHAT-LLMF-04 | Fallo del proveedor LLM en cualquier punto | No corta la charla; degrada de forma segura |
| CHAT-LLMF-05 | Charla en fallback LLM, con el flujo vinculado a una `ContextSource` de tipo `broker`, y una pregunta que necesita la fuente | El orquestador consulta `queryKnowledge` por el broker **siempre que el flujo tenga una fuente vinculada** (ya **no** hay sentinel `NECESITA_FUENTE`: se eliminó porque no era confiable con algunos proveedores), inyecta la respuesta como contexto de sistema autoritativo y responde con eso. ⚠️ **Comportamiento cambiado por el PR:** antes el LLM decidía cuándo pedir la fuente emitiendo el sentinel |
| CHAT-LLMF-06 | Mismo caso pero con un mensaje trivial ("gracias") que **no** necesita la fuente | **También consulta la fuente** (se eliminó el sentinel, no hay forma de saltearla): paga la latencia del RAG en **todos** los turnos con fuente vinculada. ⚠️ **Comportamiento cambiado por el PR** (antes el mensaje trivial no consultaba la fuente); es el trade-off deliberado fiabilidad-vs-latencia. Medir la latencia agregada por turno es el objeto de este caso |
| CHAT-LLMF-07 | El nodo `llm_query` de un flujo vinculado a una `ContextSource` (antes ignoraba la fuente) | **Ahora también consulta la fuente** antes de responder e inyecta la respuesta como mensaje `system` autoritativo — misma regla "consultar siempre" que el orquestador, pero desde el nodo `llm_query`. ⚠️ **Comportamiento cambiado por el PR:** el nodo antes ignoraba por completo la fuente vinculada |
| CHAT-LLMF-08 | La fuente no da respuesta útil (`ok:false`, timeout interno, o un tipo `mcp`/`rag`/`n8n` sin ejecución en vivo) | No corta la charla: `queryKnowledge` nunca tira (atrapa el error y devuelve `ok:false`), se loguea un `warn` "sin respuesta útil" y el LLM **responde igual, sin ese contexto**. ⚠️ **Comportamiento cambiado por el PR:** antes se devolvía el mensaje explícito "No tengo esa información disponible…"; ahora el modelo contesta con lo que sepa, con **riesgo de alucinar** en vez de avisar que no tiene el dato. Es a la vez un caso adversarial (ver CHAT-LLMF-12) |
| CHAT-LLMF-09 | Reanudar dentro de las 12h una charla que reusa el mismo `Conversation.id` | El orquestador sólo manda al LLM los `Message` con `createdAt >= sessionStartedAt`; los turnos previos al cierre no se filtran como contexto de la sesión nueva |
| CHAT-LLMF-10 | Charla con una **Skill** vinculada al flujo | El `promptText` de la Skill se concatena al system prompt base (`buildBasePrompt`), tanto en el orquestador como en `llm_query`. Sin Skill: sólo el prompt de `/settings` (retrocompatible). ⚠️ Sin re-chequeo del tenant en curso → ver la fuga cross-tenant en flujos compartidos (BE-SKL-08) |
| CHAT-LLMF-11 | La fuente de verdad vinculada devuelve contenido **adversario/comprometido** | ⚠️ `knowledge.answer` se inyecta **verbatim** como mensaje `system` con el framing "información autoritativa, priorizala si contradice lo que ya sabés" → puede **sobrescribir el comportamiento del bot** (prompt injection). Riesgo inherente al RAG, **amplificado** por el framing "priorizala" y por consultarse siempre (CHAT-LLMF-06). El `promptText` de la Skill también se inyecta verbatim, pero es admin-authored (riesgo menor): `❌` como comportamiento seguro a endurecer |
| CHAT-LLMF-12 | La fuente **falla** (`ok:false`) y el usuario hace una pregunta que **sólo** la fuente podía responder | **Debería** avisar que no tiene el dato. ⚠️ Hoy el LLM responde igual sin el contexto, con **riesgo de alucinar** una respuesta plausible en vez de reconocer la falta de información (cambio respecto de CHAT-LLMF-08, que antes devolvía "No tengo esa información disponible…"): `❌` (calidad/seguridad de la respuesta) |

## 2.8 Cierre y cancelación (dos niveles)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-CLOSE-01 | Mensaje de cierre global ("cerrar", "terminar") confirmado por el LLM | Cierra toda la conversación desde cualquier estado |
| CHAT-CLOSE-02 | Cancelación de la gestión en un `input`/`menu` | Cancela sólo el dato/gestión en curso (cierra la charla, reabrible) |
| CHAT-CLOSE-03 | Palabra que parece cierre pero el LLM dice continuar | No cierra; sigue la conversación |

## 2.9 Interpolación de variables

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-VARINT-01 | Mensaje con `{{ userName }}` tras el nodo `start` | Sustituye por el nombre real (el estado se actualiza antes de interpolar) |
| CHAT-VARINT-02 | Placeholder de una variable inexistente (typo) | Deja el `{{ x }}` visible (para que se note el error) |
| CHAT-VARINT-03 | Interpolación en un mensaje interactivo (body, títulos de botones/lista) | Sustituye en todos esos campos |

## 2.10 Flujo end-to-end (integración por el broker)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-E2E-01 | `POST /conversations/simulate` con un mensaje | Publica en `whatsapp.simulate.incoming`, el orquestador procesa, la respuesta vuelve por la reply queue correlacionada por `correlationId` |
| CHAT-E2E-02 | Simular una conversación completa (saludo → menú → opción → ticket) | Cada turno mantiene estado en `flowState` y avanza correctamente |
| CHAT-E2E-03 | Webhook real → `whatsapp.incoming` → orquestador → `whatsapp.outgoing` | El mensaje entra, se procesa y la respuesta se encola para el conector de salida |
| CHAT-E2E-04 | `simulate` cuando el orquestador tarda (LLM lento) | Espera hasta 300s (5 min, `SIMULATE_TIMEOUT_MS`); si no vuelve, 504 con mensaje claro |
| CHAT-E2E-05 | `/estado` y `/reset` del chat por consola | `/estado` muestra `currentFlowId/currentNodeId/flowState`; `/reset` cierra las conversaciones activas |

## 2.11 Cierre automático por inactividad (`@Cron`)

**Precondición:** un `@Cron` corre cada 10 minutos (`ScheduleModule`). Cierra toda conversación
`active` sin ningún `Message` en la última hora (`INACTIVITY_TIMEOUT_MS = 1h`), reseteando
flujo/nodo/estado. La conversación queda **retomable** dentro de `RESUME_WINDOW_MS = 12h`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-IDLE-01 | Conversación `active` sin mensajes en la última hora | El cron la cierra (`status:closed`, `closedAt`) y resetea `currentFlowId`/`currentNodeId`/`flowState` |
| CHAT-IDLE-02 | Conversación `active` con un mensaje dentro de la última hora | No se cierra (el filtro es por `Message` reciente, no por `updatedAt` de la fila) |
| CHAT-IDLE-03 | Mensaje nuevo tras el autocierre, **dentro** de las 12h | Reabre la **misma** conversación con el flujo reseteado (arranca de nuevo sin perder el historial de `Message`) |
| CHAT-IDLE-04 | Mensaje nuevo tras el autocierre, **pasadas** las 12h | Arranca una conversación nueva |

## 2.12 Concurrencia y carga

**Precondición:** el motor no toma ningún bloqueo explícito: la conversación se busca y se crea
en pasos separados, el reparto rotativo de agentes guarda un índice **global por nodo**, y el
cierre por inactividad corre en paralelo al procesamiento de mensajes. No hay límite de tasa en
ningún endpoint, así que la contención tampoco viene de afuera.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-CONC-01 | Dos mensajes del **mismo** teléfono publicados casi al mismo tiempo | Queda **una sola** conversación activa y un solo contacto; el segundo mensaje se suma a la misma charla, no abre otra en paralelo |
| CHAT-CONC-02 | Dos conversaciones distintas llegan al mismo nodo de transferencia simultáneamente | El reparto rotativo avanza una vez por cada una (no le asigna el mismo agente a las dos). Como el índice es global por nodo y se lee y escribe sin bloqueo, verificar el comportamiento real y dejarlo documentado |
| CHAT-CONC-03 | El cierre automático corre justo mientras entra un mensaje de esa misma conversación | No se pierde el mensaje ni queda una charla cerrada con estado a medias: o se cierra y el mensaje la reabre, o el mensaje llega antes y ya no califica para el cierre |
| CHAT-CONC-04 | Ráfaga sostenida de mensajes desde muchos teléfonos distintos | El proceso no se cae ni deja mensajes sin responder. Medir cuántas invocaciones al modelo se disparan: sin límite de tasa (SEC-05) el costo escala sin techo, y ése es el dato que justifica ponerle uno |

## 2.13 Chatbot — placeholders 🚧

| ID | Escenario | Detalle |
|----|-----------|---------|
| CHAT-PH-01 | Recepción + envío reales de punta a punta por WhatsApp | El código de entrada (webhook, §1.12) y de salida (`WhatsAppService`, §1.13) **está implementado**; sólo falta validar contra Meta real (credenciales/sandbox, `WHATSAPP_SANDBOX_RECIPIENT_OVERRIDES`) |
| CHAT-PH-02 | Creación real de tickets en Invgate desde `ticket_create`/`transfer_agent` | Integración pendiente; hoy los tickets viven sólo en la tabla local |
| CHAT-PH-03 | Nodo `webhook` llamando a un servicio externo | Stub; al implementarlo, cubrir con los casos de SSRF del apéndice |
| CHAT-PH-04 | Retorno automático de un `subflow` al flujo padre | Se guarda `previousFlowId` pero no hay retorno implementado |

---

# 🎨 Sección 3 — Frontend

El panel de administración es una app **Next.js 16 (App Router)**. Esta sección son casos a
ejecutar en el navegador contra un backend con el seed aplicado. La convención es la misma que
el resto del plan (ID `FE-*`, escenario, resultado
esperado). Cubre tres frentes: **funcional** (navegación, formularios, control de acceso por
permisos, validaciones en vivo), **responsive** (§3.11) y **seguridad de la UI** (§3.12).

**Precondición general:**

- Backend levantado (`pnpm dev:api`) y frontend (`pnpm dev:web`), con `NEXT_PUBLIC_API_URL`
  apuntando al backend y `NEXT_PUBLIC_SYSTEM_TENANT_SLUG` coincidiendo con `SYSTEM_TENANT_SLUG`.
- Seed aplicado: se entra con `admin@pci.local` / `changeme123` (SuperAdmin del tenant de sistema).
- Para probar la visibilidad por permisos hace falta, además, un usuario **común** (rol con
  permisos acotados) en una empresa que no sea la de sistema, y un usuario con **varias** empresas.

Recordatorio transversal: la UI ocultar/mostrar por permisos es **defensa en profundidad**, no la
autorización real — esa la impone el backend (Sección 1). Ver §3.12.

## 3.1 Infraestructura transversal (sesión, tenant activo, menú)

**Qué se prueba:** el cliente HTTP (`apiFetch`), el contexto de autenticación (`useAuth`), el
guard de rutas (`AuthGuard`) y el sidebar dinámico. El JWT y el tenant activo viven en
`localStorage` (`token`, `activeTenant`); el tenant viaja por el header `X-Tenant-Id`, no en el token.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-INF-01 | Entrar a `/dashboard` sin sesión (sin `token`) | `AuthGuard` redirige a `/login`; mientras resuelve muestra "Cargando…" |
| FE-INF-02 | Entrar a `/` (raíz) | Redirige a `/login` |
| FE-INF-03 | Con sesión válida, recargar cualquier página del panel | `useAuth` llama a `GET /auth/me`, repuebla `user` y mantiene la sesión |
| FE-INF-04 | Token expirado o inválido al montar | `fetchUser` falla → `logout()` limpia `localStorage` y manda a `/login` |
| FE-INF-05 | Toda request del panel | Lleva `Authorization: Bearer <token>` y el header `X-Tenant-Id` con el tenant activo — se manda siempre que hay uno, también con una sola empresa (el backend lo tolera) |
| FE-INF-06 | Cambiar de empresa en el selector del sidebar | `setActiveTenant` persiste en `localStorage` y **recarga la página**; todo se re-consulta contra el tenant nuevo |
| FE-INF-07 | Sidebar de un usuario común (permisos acotados) | Sólo aparecen los ítems cuyo `resource:read` tiene el rol; los demás no se renderizan |
| FE-INF-08 | Ítems `systemTenantOnly` (Tenants, Configuración) | Sólo visibles si el contexto activo es el tenant de sistema (o "Todas las empresas" siendo superusuario) |
| FE-INF-09 | Selector de tenant con un usuario de una sola empresa | No aparece el selector (no hay nada que elegir) |
| FE-INF-10 | Opción "🌐 Todas las empresas" (superadmin) / "🌐 Todas mis empresas" (común con >1) | Activa el modo consolidado (`__all__`); el resto de las pantallas usan las vistas `/all` o `/mine` |
| FE-INF-11 | "Cerrar sesión" | Limpia token, `activeTenant` y cachés; redirige a `/login` |
| FE-INF-12 | Un error del backend en cualquier pantalla | Muestra el `message` del backend (no un genérico); las pantallas que dependen de `err.body` (conflictos) lo aprovechan |
| FE-INF-13 | **Superadmin recorriendo el selector de empresas:** sistema → una empresa común → otra empresa común → "🌐 Todas las empresas" | El menú muestra **siempre las mismas 8 opciones**, incluidas "Tenants" y "Configuración": el selector cambia **qué datos se ven**, nunca **qué opciones existen**. Entrar a esas dos pantallas parado en una empresa común funciona (ver BE-MT-12). ⚠️ Hoy ambas **desaparecen** apenas elige una empresa común y reaparecen al volver a la de sistema o al modo consolidado, porque su visibilidad depende de la empresa seleccionada y no de quién es la persona: `❌` hasta corregirlo |
| FE-INF-14 | Cualquier respuesta de una request autenticada trae `X-Access-Token` | `apiFetch` lee el header y **pisa** `localStorage.token`; la próxima request ya usa el token nuevo (sesión deslizante del lado cliente, ver BE-AUTH-26). No toca el estado de React. Con actividad continua la sesión ya no se cae a los 15 min |
| FE-INF-15 | Un **401 con token presente** en cualquier request del panel | `apiFetch` llama a `clearSession()` (única fuente de qué keys de `localStorage` borra) y redirige a `/login` de inmediato — antes la UI mostraba datos viejos o fallaba en silencio hasta recargar a mano. Un 401 de login/OTP (sin `Authorization`) **no** cae acá |

## 3.2 Login y OTP (2FA)

**Precondición:** `/login` es público; si ya hay `token` redirige a `/dashboard`. El navegador
manda su `User-Agent` (necesario para el fingerprint); el frontend no lo fija a mano.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-LOG-01 | Login con credenciales correctas y `OTP_ENABLED=false` | Guarda el token y entra a `/dashboard` |
| FE-LOG-02 | Login con credenciales incorrectas | Banner de error rojo con el mensaje del backend; no entra |
| FE-LOG-03 | Login que responde `step: otp_required` | Pasa a la vista de OTP con el aviso "Se envió un código a tu email" |
| FE-LOG-04 | Cargar el código OTP correcto | Verifica, guarda el token y entra al panel |
| FE-LOG-05 | "Volver a credenciales" desde la vista OTP | Vuelve al primer paso (hoy **no** limpia el código OTP ni el banner de error ya tipeados) |
| FE-LOG-06 | Botón "Ingresar"/"Verificar" durante la request | Queda deshabilitado mientras `loading` (no permite doble submit) |
| FE-LOG-07 | Campo OTP | Acepta hasta 8 dígitos (`maxLength=8`), consistente con `OTP_CODE_LENGTH` configurable |

## 3.3 Dashboard (home)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-DASH-01 | Entrar a `/dashboard` con sesión | Muestra las tarjetas de resumen (hoy con valor "—", sin datos aún) |
| FE-DASH-02 | Panel "Tu rol y permisos" | Lista, por cada empresa del usuario, el nombre del rol y la cantidad de permisos (sale de `/auth/me`, sin llamada propia) |

## 3.4 Usuarios (`/dashboard/users`)

**Precondición:** ABM multiempresa. Cuatro datos son únicos globales (email, teléfono, interno,
id de Invgate) con chequeo en vivo. En modo consolidado (`__all__`) el superadmin usa `/users/all`
y el común `/users/mine`; las acciones por fila mandan el `X-Tenant-Id` de esa fila.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-USR-01 | Botón "Nuevo usuario" | Visible sólo con `users:create`; abre el formulario de alta |
| FE-USR-02 | Alta con nombre/apellido/email/contraseña y ≥1 empresa con rol | Valida rol obligatorio por empresa; `POST /users/multi`; refresca la lista |
| FE-USR-03 | Alta sin ninguna empresa, o con una empresa sin rol | El formulario bloquea el guardado con el aviso correspondiente |
| FE-USR-04 | Escribir un email/teléfono/interno/Invgate ya en uso y salir del campo (`onBlur`) | `GET /users/check-availability`; muestra el conflicto inline y **deshabilita** Guardar |
| FE-USR-05 | Conflicto de un dato que el solicitante puede ver | El error enlaza al ocupante; el link abre su detalle (`/users/:id/memberships`) |
| FE-USR-06 | Conflicto de un dato de una empresa que no administra | Avisa que está en uso sin revelar quién |
| FE-USR-07 | Editar un usuario | El email aparece deshabilitado; la contraseña se puede dejar vacía ("no cambiar") |
| FE-USR-08 | Editor de membresías: agregar, cambiar rol/área, marcar para baja y "Deshacer" | Cada acción respeta el permiso en ESA empresa; `PATCH /users/:id/full` con el estado final |
| FE-USR-09 | Baja de un usuario por fila | Confirmación inline (fila roja); `DELETE /users/:id` con el header de esa empresa |
| FE-USR-10 | Intentar darse de baja a uno mismo | Botón gris `aria-disabled` con el motivo; no permite la acción |
| FE-USR-11 | Modo "Todas las empresas": columna Empresa y filtro | Una fila por membresía; el filtro por empresa aparece si hay >1 |
| FE-USR-12 | Botones Editar/Eliminar por fila en consolidado | Habilitados según `hasPermissionInTenant` de la empresa de esa fila |
| FE-USR-13 | Cerrar un modal con cambios sin guardar (Escape o click afuera) | Pide confirmación antes de descartar |
| FE-USR-14 | Clic en una fila (fuera de los botones de acción) | Abre el modal de **detalle de solo lectura**, con botón "Editar" si el usuario tiene permiso |

## 3.5 Roles y matriz de permisos (`/dashboard/roles`)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-ROL-01 | Listado de roles | Por rol: nombre, cantidad de usuarios, cantidad de permisos, badge "Rol del sistema" si es protegido |
| FE-ROL-02 | Crear un rol (con `roles:create`, fuera del modo consolidado) | Nombre único por empresa (validación local case-insensitive); `POST /roles` |
| FE-ROL-03 | Matriz de permisos: toggle por celda, por fila, por columna y "todo" | Marca/desmarca; el contador "X de N" se actualiza |
| FE-ROL-04 | Marcar cualquier acción de un recurso | `read` queda forzado y bloqueado (no se puede habilitar `create` sin `read`) |
| FE-ROL-05 | Guardar cambios de nombre + permisos | Dos llamadas: `PATCH /roles/:id` (nombre) y `PUT /roles/:id/permissions` (matriz), sólo si cambiaron |
| FE-ROL-06 | Editar el **propio** rol | Aviso de que podría perder acceso |
| FE-ROL-07 | Rol protegido (SuperAdmin de sistema) | Se abre en modo consulta: no se renombra, no se editan permisos, no se elimina |
| FE-ROL-08 | Eliminar un rol con usuarios asignados | Botón gris con la explicación; no permite borrar |
| FE-ROL-09 | Modo consolidado | Listado `/roles/all` (superadmin) o `/roles/mine` (común); columna Empresa y filtro por empresa; alta deshabilitada (hay que pararse en una empresa) |
| FE-ROL-10 | Clic en el contador de usuarios de un rol (en una empresa concreta) | Abre el modal "Usuarios con el rol" (`GET /roles/:id/users`), con botón "Ir a Usuarios" |

## 3.6 Tenants (`/dashboard/tenants`)

**Precondición:** ítem `systemTenantOnly`; el listado usa `/tenants/all` (exige tenant de sistema).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-TEN-01 | Ver el ítem "Tenants" en el menú (la UI lo rotula así, no "Empresas") | Sólo con `tenants:read` y contexto de sistema |
| FE-TEN-02 | Listado con el toggle "Mostrar dados de baja" | `GET /tenants/all?includeDeleted=true`; las dadas de baja aparecen atenuadas con badge |
| FE-TEN-03 | Crear/editar una empresa | Nombre y slug (único, validación local); `POST /tenants` o `PATCH /tenants/:id` |
| FE-TEN-04 | Empresa de sistema | Slug bloqueado (no editable) y sin opción de baja (botón gris con motivo) |
| FE-TEN-05 | Baja lógica y reactivación por fila | Confirmación inline (roja para baja, verde para restaurar); `DELETE` / `POST /tenants/:id/restore` |

## 3.7 Áreas (`/dashboard/areas`)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-ARE-01 | Listado de áreas del tenant activo | Cada una con su `userCount`; en consolidado, columna Empresa y filtro |
| FE-ARE-02 | Crear/editar un área | Nombre (≤80, único por empresa, validación local); `POST /areas` o `PATCH /areas/:id` |
| FE-ARE-03 | Eliminar un área con usuarios asignados | Botón gris con la explicación; no borra |
| FE-ARE-04 | Botones de ABM según permisos | `areas:create/update/delete`; en consolidado, por fila con `hasPermissionInTenant` |
| FE-ARE-05 | Clic en el contador de usuarios de un área (en una empresa concreta) | Abre el modal de usuarios del área (`GET /areas/:id/users`) |

## 3.8 Configuración (`/settings`)

**Precondición:** ruta raíz (fuera de `/dashboard`, comparte el sidebar), `systemTenantOnly` +
`settings:read`. Los secretos arrancan con el campo vacío (el backend sólo devuelve un enmascarado).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-SET-01 | Entrar a `/settings` como SuperAdmin de sistema | Carga `GET /settings` + `GET /settings/providers/status`; muestra los grupos en pestañas |
| FE-SET-02 | Entrar sin `settings:update` | Modo sólo lectura; si el API responde 403 lo explica |
| FE-SET-03 | Badge de origen por clave | "guardado en BD" / "desde .env" / "valor por defecto" según `source` |
| FE-SET-04 | Campo secreto (🔒) con valor cargado | Muestra "cargada: <enmascarado>" + `isSet`; el input arranca vacío ("escribir reemplaza, vacío no toca") |
| FE-SET-05 | Guardar un secreto nuevo | `PATCH /settings/:key`; no se vuelve a mostrar el valor en claro |
| FE-SET-06 | Botón "Restaurar"/"Borrar key" (sólo si el valor está en BD y hay `settings:delete`) | `DELETE /settings/:key`; la clave vuelve a resolver por env/default |
| FE-SET-07 | Dropdown de "Modelo" de un proveedor | Se llena con `GET /settings/providers/:provider/models`; ofrece "Otro — escribir a mano"; indica si vino "consultada al proveedor" o "lista conocida" |
| FE-SET-08 | Cambiar de pestaña de proveedor | Carga sus modelos automáticamente (una vez, cacheada) |
| FE-SET-09 | Punto de estado por pestaña | Azul = proveedor activo, ámbar = configuración incompleta |
| FE-SET-10 | Falta `SETTINGS_ENCRYPTION_KEY` en el entorno | Banner rojo con el comando para generarla; guardar un secreto lo **rechaza el backend** (la UI muestra el banner pero no deshabilita el botón "Guardar") |
| FE-SET-11 | Guardar la key/host de un proveedor | Tras guardar, el dropdown de modelos se refresca solo |
| FE-SET-12 | Elegir "Otro — escribir a mano" en el dropdown de modelos | Cambia a un input de texto libre; un valor guardado fuera del catálogo se conserva marcado "(actual)" |
| FE-SET-13 | Botón "Cancelar" de un setting con cambios | Revierte el draft al valor efectivo, sin llamar al backend |
| FE-SET-14 | Pestañas nuevas: Mensajería WhatsApp (Twilio) / (Gupshup), Mensajería SMS (Twilio) / (Gupshup), Integración InvGate | Aparecen los grupos con sus campos; los secretos (🔒 `TWILIO_AUTH_TOKEN`, `GUPSHUP_API_KEY`, `GUPSHUP_SMS_PASSWORD`, `INVGATE_API_KEY`) arrancan vacíos con enmascarado. El layout pasó a grid de 2 columnas (sacó `max-w-4xl`) para acomodar tantos grupos |
| FE-SET-15 | Selectores de proveedor `WHATSAPP_PROVIDER` / `SMS_PROVIDER` | Dropdown con los valores del enum. ⚠️ Su descripción aclara que el cambio **requiere reiniciar el backend** (a diferencia del texto general de `/settings` que promete "sin reiniciar") — anotar la excepción |

## 3.9 Fuentes de verdad (`/dashboard/context-sources`)

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-CS-01 | Listado de fuentes del tenant | Nombre, tipo, estado (Activa/Inactiva) y el botón "Probar conexión" por fila |
| FE-CS-02 | Alta: elegir tipo | El formulario se arma dinámicamente con los campos de ese tipo (`GET /context-sources/types`) |
| FE-CS-03 | Edición de una fuente | El tipo aparece bloqueado (para cambiarlo hay que eliminar y recrear) |
| FE-CS-04 | Campo secreto en el formulario | Arranca vacío; el placeholder muestra el enmascarado + "cargado — dejar vacío para no cambiar"; botón "Quitar" para borrarlo |
| FE-CS-05 | Guardar | `POST` o `PATCH /context-sources/:id`; los secretos vacíos no marcados no se tocan |
| FE-CS-06 | "Probar conexión" | `POST /context-sources/:id/test-connection`; muestra ✓/✗ con el `message` (el backend además devuelve `latencyMs`/`statusCode`, hoy **no** pintados en pantalla) |
| FE-CS-07 | Eliminar una fuente en uso por flujos | Muestra el error del backend explicando el motivo |
| FE-CS-08 | Botones de ABM según permisos | `context-sources:create/update/delete` |
| FE-CS-09 | La pantalla se parte en dos pestañas: **Conexiones** / **Skills** | La pestaña Skills muestra el CRUD de skills; la de Conexiones es el listado de fuentes de siempre |
| FE-CS-10 | Alta/edición de una **Skill** en la pestaña Skills | Formulario con `name` y `promptText` (texto libre) + toggle activa/inactiva; `POST`/`PATCH /skills`; los botones se gatean por `skills:create/update/delete` |

## 3.10 Flujos IVR — listado y editor (`/dashboard/flows`, `/dashboard/flows/[id]`)

**Precondición:** el listado usa `/flows/all` (superadmin) o `/flows` (común). El editor es
`@xyflow/react` (ReactFlow). La barra de asignación de empresas/roles sólo aparece si el usuario
puede listar todas las empresas.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-FLW-01 | Listado de flujos | Tarjetas con nombre, badges "Default"/"Inactivo", chips de empresas o "Sin empresas" |
| FE-FLW-02 | Botones "Nuevo/Editar/Default/Eliminar" | Según `flows:create/update/delete` |
| FE-FLW-03 | Marcar un flujo como "Default" | `POST /flows/:id/default`; se refleja en la tarjeta |
| FE-FLW-04 | Abrir el editor de un flujo nuevo (`/new`) | Crea un nodo `start` por defecto; canvas listo |
| FE-FLW-05 | Arrastrar un tipo de la paleta al canvas | Crea el nodo con su `data` por defecto en la posición soltada |
| FE-FLW-06 | Conectar dos nodos (arrastrar de un handle a otro) | Crea la arista; `start` tiene dos salidas (`known`/`unknown`), `menu` una por opción |
| FE-FLW-07 | Borrar una arista | Botón × al pasar el mouse (no al click); la arista desaparece del estado (usa `deleteElements`) |
| FE-FLW-08 | Seleccionar un nodo | El panel derecho muestra los campos propios de su tipo (texto, opciones, `variableName`, `systemPrompt`, etc.) |
| FE-FLW-09 | Nodo `transfer_agent` | Métodos email/ticket (phone deshabilitado), asignados con orden (round robin), observadores y colaboradores |
| FE-FLW-10 | Header: Contexto y "Fuente de verdad" | El dropdown de fuente lista las `ContextSource` activas del tenant; se vincula al flujo |
| FE-FLW-11 | Modal "Empresas y roles" | Acordeón por empresa con checkboxes de roles; aviso ámbar si una empresa queda con 0 roles |
| FE-FLW-12 | Checkbox "Inicio" | Deshabilitado sin empresas; marca el flujo de inicio por (empresa+rol) |
| FE-FLW-13 | Guardar un flujo nuevo vs. existente | Nuevo: `POST /flows`. Existente: `PATCH /flows/:id` + `POST /flows/:id/assign-tenants` |
| FE-FLW-14 | Guardar sin empresas asignadas | Pide confirmación ("quedará sin empresas") |
| FE-FLW-15 | Payload de guardado | Sólo `{id,type,position,data}` de nodos y los campos declarados de aristas (limpia `measured`/`selected`/`dragging` de ReactFlow, así el backend no rechaza con 400) |
| FE-FLW-16 | Borrar el nodo/arista seleccionado con Backspace/Delete | Se elimina del canvas (`deleteKeyCode`) |
| FE-FLW-17 | Reordenar asignados con ↑/↓ en `transfer_agent` | Cambia el orden del round robin; se persiste en el `data` del nodo al guardar |
| FE-FLW-18 | Header del editor: selector de **Skill** | Reemplaza al dropdown viejo "context"; lista `GET /skills` (filtra `isActive`) y vincula la Skill al flujo (`skillId`); "sin skill" desvincula |
| FE-FLW-19 | Nodo **SMS** (verde) en la paleta | Se arrastra al canvas; su panel tiene `message` + selector de **destinatarios** (usuarios del tenant, mismo criterio que `transfer_agent`, no números a mano) |
| FE-FLW-20 | Nodo **Generar Ticket** (`ticket_create`) con catálogo InvGate | `category`/`priority`/`ticketType` como dropdowns poblados desde `GET /invgate/catalog/*`; si el catálogo no cargó, **caen a input de texto libre**; más el campo descripción. La tarjeta del nodo muestra categoría y tipo |
| FE-FLW-21 | Nodo `llm_query`: toggle `systemPromptMode` | "reemplaza" / "agrega" respecto del prompt base del flujo (ver CHAT-N-LLM-06) |

## 3.11 Responsive

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-RSP-01 | Panel a ~400px de ancho (móvil) | El contenido principal sigue usable; documentar el scroll horizontal conocido del layout del sidebar (preexistente) |
| FE-RSP-02 | Tablas de ABM (usuarios/roles) en pantallas chicas | Se pueden leer y operar (con scroll donde haga falta), sin romper el layout de la página |
| FE-RSP-03 | Editor de flujos en pantalla chica | El canvas de ReactFlow, la paleta y el panel de propiedades siguen operables (con `Controls`/`MiniMap`) |
| FE-RSP-04 | Pestañas de `/settings` con muchos proveedores | El tablist se puede recorrer sin desbordar horizontalmente la página |

## 3.12 Seguridad de la UI

La visibilidad por permisos y el enmascarado en pantalla son **defensa en profundidad**, no la
barrera real: la autorización la impone el backend. Estos casos verifican que la UI no debilite
esa postura ni exponga datos.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-SEC-01 | Ocultar un botón por falta de permiso **no** es la única defensa | Forzar la request equivalente (con la herramienta REST) igual la rechaza el backend (403); la UI sólo evita mostrar la acción |
| FE-SEC-02 | Inspeccionar dónde vive el JWT | Está en `localStorage` (`token`): expuesto a XSS; se relaciona con SEC-06 (el refresh token de 7 días también sirve como access). Documentar el riesgo |
| FE-SEC-03 | Campos secretos (settings y fuentes de verdad) en pantalla | Nunca muestran el valor real: sólo enmascarado + estado "cargada/sin configurar" |
| FE-SEC-04 | `/auth/me` de un usuario dado de baja durante la sesión | Falla → la UI hace `logout()` y saca al usuario (la sesión no sobrevive a la baja en el front) |
| FE-SEC-05 | Un usuario común entra por URL directa a una pantalla `systemTenantOnly` (ej. `/settings`) | El backend rechaza sus llamadas (403) y la pantalla muestra el estado de sin acceso; el ítem tampoco está en el menú |
| FE-SEC-06 | Pestaña Skills y selector de Skill del editor sin el permiso `skills` | Gateados por `hasPermission('skills', …)`: sin permiso no se muestran los botones/selector, y forzar la request equivalente igual la rechaza el backend (403). Misma postura defensa-en-profundidad que FE-SEC-01 |

---

# 🔒 Apéndice A — Auditoría de seguridad

Hallazgos sobre el código **actual**, verificados contra la fuente. Descritos por su
contenido e impacto (sin referencias de archivo/línea, según lo acordado). Cada uno tiene un
ID para referenciarlo desde los casos de arriba (ver "Trazabilidad rápida" al final).

**Resumen:** la base de autorización multitenant/RBAC y el cifrado de secretos están bien
resueltos. Los focos a atender son un **bypass de 2FA por fuerza bruta**, un **endpoint core
sin autenticación**, **fugas de datos entre tenants** en flujos y consulta de tickets, y la
**ausencia de rate limiting**. El PR de canales, InvGate y Skills suma dos focos: **los webhooks
de Twilio y Gupshup no validan firma ni autenticidad** (SEC-16, misma clase que el de Meta) y **la
Skill de una empresa se filtra a otra en un flujo compartido** (SEC-17).

## 🔴 Críticos

### SEC-01 — El código OTP es forzable por fuerza bruta (bypass de 2FA)
- **Qué pasa:** la verificación del segundo factor busca el código en un almacén indexado
  **sólo por el código**, sin atarlo al email, al usuario ni a la sesión que lo pidió. No hay
  límite de intentos, ni bloqueo, ni rate limiting. El código es numérico de 6 dígitos
  generado con un generador **no criptográfico**.
- **Cómo se explota:** un atacante prueba códigos de 6 dígitos contra el endpoint de
  verificación. Apenas uno coincida con **cualquier** OTP vivo de **cualquier** usuario,
  recibe un token de sesión de esa persona —sin siquiera saber a quién ataca—. La ventana de
  validez y el espacio pequeño, combinados con la falta de rate limit, lo vuelven práctico.
- **Impacto:** apropiación de cuentas, anulando el 2FA.
- **Sugerencia:** atar la verificación al usuario/sesión, limitar intentos por código y por
  IP, expirar el código tras N fallos, usar un CSPRNG.

## 🟠 Altos

### SEC-02 — `/conversations/simulate` sin autenticación y con el tenant en el body
- **Qué pasa:** el endpoint que inyecta mensajes al orquestador no tiene ningún guard y toma
  el tenant del cuerpo del request (no del header validado). El cuerpo tampoco es un DTO, así
  que no pasa por la validación global.
- **Cómo se explota:** cualquiera con acceso de red al API inyecta mensajes como si fueran de
  cualquier teléfono en cualquier empresa, disparando todo el orquestador: crea usuarios y
  conversaciones, invoca al LLM (costo monetario → DoS económico) y puede llegar a crear
  tickets o transferencias.
- **Impacto:** abuso del bot, suplantación de usuarios, gasto de LLM no autorizado.
- **Sugerencia:** exigir autenticación (o una key de servicio), tomar el tenant del header
  validado y tipar el body como DTO.

### SEC-03 — Fuga entre empresas en la gestión de flujos (IDOR)
- **Qué pasa:** los endpoints de un flujo por id (ver, editar, borrar, asignar empresas,
  marcar default) exigen el permiso `flows:*` pero **no** el candado de tenant de sistema ni
  filtran por la empresa activa. El listado sí filtra por tenant; la inconsistencia es el
  problema.
- **Cómo se explota:** un administrador de una empresa cualquiera que tenga (o se
  auto-asigne) el permiso de flujos puede pasar el id de un flujo de **otra** empresa y
  leerlo, reescribir su lógica conversacional, borrarlo o reasignarlo. Marcar "default"
  además cambia un default **global** del sistema con un permiso de nivel empresa.
- **Impacto:** manipulación cross-tenant de la lógica del bot.
- **Sugerencia:** gatear las operaciones de flujo por el tenant de sistema (como el resto de
  lo cross-tenant) o scopear cada operación por la empresa activa.

### SEC-04 — El webhook de WhatsApp (POST) no verifica la firma de Meta
- **Qué pasa:** el handshake GET valida el verify token, pero el POST de mensajes no valida
  ninguna firma con el App Secret de Meta.
- **Cómo se explota:** quien conozca la URL del webhook publica mensajes falsos con cualquier
  remitente; el sistema los asigna al tenant configurado y los procesa como reales.
- **Impacto:** suplantación de usuarios por la puerta pública, avance de flujos y gasto de
  LLM. Mismo efecto que SEC-02 pero desde el webhook.
- **Sugerencia:** validar `X-Hub-Signature-256` con el App Secret antes de encolar el mensaje.

## 🟡 Medios

### SEC-05 — No hay rate limiting en ningún endpoint
- **Qué pasa:** no hay throttling global ni en login/OTP. Es el multiplicador que vuelve
  práctico SEC-01 y habilita fuerza bruta de contraseñas y DoS.
- **Sugerencia:** agregar un límite por IP/usuario, más estricto en auth.

### SEC-06 — El refresh token funciona como access token
- **Qué pasa:** el token de acceso (corto) y el de refresco (7 días) se firman con el mismo
  secreto y el mismo contenido, sin distinguir su tipo, y la validación no los diferencia. No
  hay endpoint de refresco ni revocación.
- **Cómo se explota:** el token de 7 días sirve directamente como token de acceso durante
  todo ese tiempo, anulando la expiración corta. Robado (p. ej. por XSS si el front lo guarda
  en `localStorage`), da una sesión larga.
- **Sugerencia:** diferenciar el tipo de token, agregar refresco/revocación.

### SEC-07 — El fingerprint de dispositivo es reversible
- **Qué pasa:** el identificador del dispositivo se arma como una codificación reversible de
  "teléfono + User-Agent", no un hash. El teléfono es dato conocido y el User-Agent lo
  controla el cliente.
- **Impacto:** el segundo factor por dispositivo es débil/enumerable. Es la decisión "v1 =
  teléfono + UA" documentada, pero conviene registrar que ser reversible la agrava.
- **Sugerencia:** al menos hashear (SHA-256) el valor; sumar señales al fingerprint.

### SEC-08 — Fuga entre empresas al consultar un ticket en el flujo (`ticket_query`)
- **Qué pasa:** el nodo que consulta un ticket lo busca por id **sin filtrar por la empresa**.
  Si el flujo alimenta el id desde una variable que llenó el usuario, este puede pasar el id
  de un ticket de otra empresa y recibir su asunto y estado.
- **Impacto:** lectura de datos de tickets de otros tenants.
- **Sugerencia:** filtrar la consulta por el tenant (y por el dueño cuando corresponda).

### SEC-09 — Una condición con regex inválida rompe el flujo
- **Qué pasa:** el nodo `condition` compila la expresión regular configurada sin proteger la
  compilación. Una regex mal formada lanza una excepción no capturada que corta la ejecución
  del flujo. Una regex "catastrófica" evaluada contra el mensaje del usuario abre además la
  puerta a un ReDoS.
- **Impacto:** caída del flujo por configuración; posible degradación por ReDoS.
- **Sugerencia:** envolver la compilación en try/catch y acotar/validar las regex del editor.

## 🟢 Bajos

### SEC-10 — El código OTP (y todo email) se loguea en consola sin SMTP
- **Qué pasa:** sin servidor SMTP configurado, el cuerpo del email —incluido el código OTP—
  se escribe en los logs.
- **Sugerencia:** no volcar el cuerpo en logs, ni siquiera en el modo de desarrollo.

### SEC-11 — Fuga de tickets dentro de la misma empresa por coincidencia parcial
- **Qué pasa:** el orquestador, al detectar dígitos en el mensaje, busca un ticket con
  coincidencia **parcial** de id (scopeado por empresa, pero sin filtrar por dueño). Un
  usuario que menciona dígitos sueltos puede hacer que matchee el ticket de otro usuario de su
  empresa e inyectar su asunto/estado en la respuesta.
- **Sugerencia:** match exacto de id y filtrar por el dueño de la conversación.

### SEC-12 — CORS refleja cualquier origen con credenciales habilitadas
- **Qué pasa:** la configuración de CORS refleja el `Origin` de quien llame y habilita
  credenciales. El riesgo práctico es bajo porque la autenticación es por header
  `Authorization` (no cookies), pero es permisivo y se combina mal con los endpoints públicos.
- **Sugerencia:** restringir a una lista de orígenes conocidos.

### SEC-13 — La validación del código OTP está fijada a 6 dígitos (bug funcional)
- **Qué pasa:** la longitud del código es configurable (4–8) desde settings, pero la
  validación del endpoint de verificación exige exactamente 6 dígitos. Si un admin cambia la
  longitud, ningún código válido pasa la validación y **el 2FA queda inutilizable**.
- **Sugerencia:** validar la longitud contra el valor configurado, no un fijo.

### SEC-14 — La sesión sobrevive a la baja del usuario a nivel de estrategia JWT
- **Qué pasa:** la validación del token no filtra usuarios dados de baja. En la práctica queda
  contenido porque el guard de tenant corta por falta de membresías y `/auth/me` falla, pero
  conviene el filtro por defensa en profundidad.
- **Sugerencia:** rechazar el token si el usuario tiene baja lógica.

### SEC-15 — Un subflujo apuntando a un flujo inexistente rompe la conversación
- **Qué pasa:** el nodo `subflow` llama a `flowService.findById(flowId)`, que **lanza**
  `NotFoundException('Flujo no encontrado')` cuando el flujo no existe (fue borrado, o el id
  quedó mal en el editor). El guard `if (!subFlow)` que le sigue es **código muerto** —`findById`
  nunca devuelve `null`, siempre tira— así que la excepción se propaga sin captura por
  `executeNode → executeFlow → handleMessage` hasta el consumer del broker: la respuesta nunca
  se publica y la conversación queda sin contestar (por `simulate`, corta a los 300s con 504).
- **Impacto:** una conversación real que pasa por ese nodo se rompe en silencio. No es atacable
  desde afuera (depende de una mala configuración del flujo), pero degrada el servicio para los
  usuarios de ese flujo. Mismo patrón que SEC-09 (regex inválida).
- **Sugerencia:** envolver el `findById` del nodo `subflow` en try/catch (o usar una variante
  que devuelva `null`) y responder el mensaje controlado que el guard ya intenta dar.

### SEC-16 — Los webhooks de Twilio y Gupshup (WhatsApp y SMS) no verifican firma ni autenticidad (🟠 Alto)
- **Qué pasa:** los cuatro webhooks nuevos —`POST webhooks/twilio`, `webhooks/gupshup`,
  `webhooks/twilio-sms`, `webhooks/gupshup-sms`— aceptan cualquier `POST` sin validar firma ni el
  origen. Twilio expone `X-Twilio-Signature` (HMAC con el auth token) pero **no** se comprueba;
  Gupshup no se verifica de ninguna forma. Agravante: los cuatro quedan activos **aunque
  `WHATSAPP_PROVIDER`/`SMS_PROVIDER` no sean ese proveedor**.
- **Cómo se explota:** quien conozca la URL publica mensajes falsos con cualquier remitente en
  `whatsapp.incoming`/`sms.incoming`; el sistema los asigna al tenant configurado (o al más antiguo)
  y los procesa como reales.
- **Impacto:** suplantación de usuarios por la puerta pública, avance de flujos, gasto de LLM y hasta
  creación de tickets. Mismo efecto que SEC-04 (webhook de Meta), ahora multiplicado por cuatro canales.
- **Sugerencia:** validar `X-Twilio-Signature` con el auth token antes de encolar; para Gupshup, un
  secreto compartido o allowlist de IP; y no procesar en un webhook cuyo proveedor no está activo.

### SEC-17 — La Skill de una empresa se filtra a otra en un flujo compartido (🟠 Alto)
- **Qué pasa:** un `Flow` puede estar asignado a varias empresas (`TenantFlow`, N:N), pero `Skill` es
  por tenant y `Flow.skillId` es un FK global único. `FlowService.findById` carga `skill.promptText`
  **sin re-chequear el tenant en curso**, y `FlowService.create/update` propagan `skillId` por spread
  **sin validar que la skill pertenezca al tenant activo** (la FK sólo valida existencia).
- **Cómo se explota:** una charla de la empresa B que pasa por un flujo compartido con A recibe en su
  system prompt el `promptText` de la skill de A. Y un admin con `flows:update` puede vincular un
  `skillId` de otra empresa (necesita el cuid, pero no hay guard que lo frene).
- **Impacto:** fuga de contexto/instrucciones entre empresas. A diferencia de la fuente de verdad —que
  falla-seguro por tenant (`getOwned` tira NotFound ante mismatch)—, la skill **filtra en silencio**.
- **Sugerencia:** re-chequear el tenant de la skill en `findById` (o filtrarla por tenant al cargarla),
  y validar la pertenencia del `skillId` en `create/update` de flujo.

### SEC-18 — El nodo `sms` no scopea los destinatarios por empresa (🟡 Medio)
- **Qué pasa:** el nodo `sms` resuelve los destinatarios con
  `prisma.user.findMany({ where: { id: { in: recipientIds } } })`, **sin** filtrar por `tenantId`. El
  editor sólo ofrece usuarios del tenant, pero el id viaja en el `data` del flujo y no se re-valida en
  ejecución.
- **Cómo se explota:** un flujo (compartido o manipulado) con un `recipientId` de otra empresa haría
  que el bot mande un SMS al teléfono de un usuario de ese otro tenant.
- **Impacto:** envío de mensajes a usuarios de otra empresa; confirma que ese teléfono existe.
- **Sugerencia:** filtrar el `findMany` por el `tenantId` de la conversación, como el resto de las
  queries del motor.

### SEC-19 — La sesión deslizante no tiene techo, revocación ni chequeo de usuario deshabilitado (🟡 Medio)
- **Qué pasa:** `SlidingSessionInterceptor` reemite un JWT de 15 min en cada request autenticado. No
  hay **max-lifetime** absoluto (con actividad continua la sesión no vence nunca), no hay **blocklist**
  server-side (el `logout` sólo limpia el `localStorage` del cliente; el JWT sigue válido hasta su
  `exp`), y `JwtStrategy.validate` comprueba **existencia** del usuario pero no un flag de
  deshabilitado/bloqueado.
- **Cómo se explota:** un token robado (p. ej. por XSS, ya que vive en `localStorage`) se mantiene vivo
  indefinidamente pingueando cualquier endpoint autenticado; un usuario suspendido-pero-no-borrado sigue
  renovando token.
- **Impacto:** sesiones efectivamente eternas y no revocables. Mitigante real: un usuario **borrado** sí
  deja de deslizar (el `findUnique` de la estrategia falla).
- **Sugerencia:** un techo absoluto de sesión (re-login cada N horas), una blocklist/`tokenVersion` para
  revocar, y rechazar en la estrategia al usuario deshabilitado.

### SEC-20 — InvGate no exige HTTPS: el Basic Auth puede viajar en texto claro (🟢 Bajo)
- **Qué pasa:** `INVGATE_API_URL` acepta cualquier esquema. Con un `http://`, el header
  `Authorization: Basic base64(user:key)` del usuario técnico viaja **sin cifrar** por la red.
- **Impacto:** intercepción de las credenciales del usuario técnico de API en un tramo no-TLS.
- **Sugerencia:** validar que la URL sea `https://` (el placeholder ya sugiere `…cloud.invgate.net`), o
  al menos advertir al guardarla.

### SEC-21 — Gupshup SMS legacy manda usuario y contraseña en la query string (🟢 Bajo)
- **Qué pasa:** el conector de SMS por Gupshup usa la API legacy, que recibe `userid` y `password` como
  parámetros de la **query string** de un `GET`. TLS los cubre en tránsito, pero la URL completa puede
  quedar registrada en logs de proxies/gateways. La verificación de éxito (`startsWith('success')` sobre
  texto plano) es además frágil.
- **Impacto:** posible filtración de las credenciales de Gupshup SMS a logs intermedios.
- **Sugerencia:** usar la API que admita credenciales por header/body si está disponible; si no, asegurar
  que esos logs no se retengan y rotar la contraseña periódicamente.

## 📌 Notas registradas sin número de hallazgo

- **El envío de email no está protegido contra el fallo del servidor de correo.** Si hay un
  servidor configurado pero caído (o con credenciales inválidas), la excepción del envío se
  propaga sin capturar: el login con segundo factor termina en error 500, con el código ya
  guardado en memoria y sin que le llegue a nadie. No es un problema de seguridad —es de
  robustez—, por eso no lleva número de hallazgo, pero sí tiene caso de aceptación propio
  (BE-EML-03) y es el motivo por el que existe la sección del canal de email.

- **El menú del superusuario cambia según la empresa que elija en el panel.** El control que
  protege la configuración global, el ABM de empresas y las vistas de todas las empresas corta
  por la empresa **seleccionada**, no por quién es la persona. Efecto: el superusuario que se
  para en una empresa común pierde "Tenants" y "Configuración" del menú, y esos endpoints le
  responden 403 hasta que vuelva a la empresa de sistema. No afloja el candado —lo aplica de
  más—, así que no lleva número de hallazgo, pero sí tiene casos de aceptación propios
  (BE-MT-12 y FE-INF-13). El arreglo **no introduce un criterio nuevo**: la cadena de guards ya
  distingue la empresa elegida del vínculo con el que opera la persona, y el resto de los ítems
  del menú se resuelven por el vínculo. Este candado es el único que mira la empresa elegida;
  alcanza con que lea lo mismo que los demás.

- **El registro de cuentas es público y sin freno.** Cualquiera con acceso de red al API puede
  crear usuarios sin límite. La cuenta nace sin empresa, así que no puede operar, pero como el
  email es único global permite además **ocupar el email de alguien que todavía no fue dado de
  alta**: cuando el administrador quiera crearlo, recibe un conflicto. Queda anotado acá —sin
  número de hallazgo ni caso de aceptación— hasta definir si el registro público es intencional.

- **Una excepción no capturada dentro de un nodo del motor corta la charla entera.** El loop de
  `executeFlow` ejecuta cada nodo **sin** `try/catch`, así que cualquier excepción se propaga hasta
  el consumer del broker: la respuesta nunca se publica y la conversación queda sin contestar (por
  `simulate`, corta a los 300s con 504). Dos vías concretas que no tienen un `SEC-*` propio: el nodo
  `llm_query` llama al proveedor **sin** red de contención —un fallo del LLM ahí rompe la charla,
  aunque `CHAT-LLMF-04` promete degradación segura "en cualquier punto"—, y una condición
  `keyword`/`variable` con el campo `value` ausente hace `.toLowerCase()` sobre `undefined` y lanza.
  Es el mismo patrón que SEC-09 (regex inválida) y SEC-15 (subflujo inexistente), que sí llevan
  número por su vía específica. Sin número de hallazgo por ser robustez y no seguridad explotable,
  pero con casos de aceptación propios (CHAT-N-LLM-04 y CHAT-N-CND-08).

## ✅ Áreas revisadas que están correctas

- **Cifrado de secretos:** AES-256-GCM con IV aleatorio por operación y tag validado; el
  `GET` devuelve enmascarado + `isSet`, nunca el valor; sin fallback a texto plano si falta la
  clave maestra; los proveedores de LLM no loguean la key.
- **RBAC de roles y permisos:** todo scopeado por tenant; el rol protegido está bien blindado
  contra modificación.
- **Autorización cross-tenant de usuarios:** las operaciones multiempresa validan el permiso
  **por empresa** dentro del servicio (empresas del body, no del header).
- **Broker RabbitMQ:** `ack`/`nack` blindados para no tirar el proceso, cola de respuesta con
  nombre propio (no `amq.*`), publicación con `{ assert:false }` contra colas exclusivas, y
  parseo de mensajes dentro de try/catch.
- **Inyección:** no hay SQL crudo (`$queryRaw`/`$executeRaw`); el nodo `webhook` es un stub
  (sin SSRF hoy); el secreto JWT se exige por entorno (sin default hardcodeado); validación
  global de payloads con whitelist y DTOs decorados (excepto el body de `simulate`, ver
  SEC-02).

---

## 🗺️ Trazabilidad rápida

Cada hallazgo tiene ahora un caso que **verifica su cierre**. Tras invertirlos, expresan el
comportamiento **seguro**: hoy están en `❌` y pasan a `✅` cuando se corrige el hallazgo.

- SEC-01 → BE-AUTH-19
- SEC-02 → BE-SEC-01
- SEC-03 → BE-FLW-14 + BE-FLW-16 (aislamiento cross-tenant de las operaciones de flujo por id)
- SEC-04 → BE-WHK-08 (rechazo sin firma) + BE-WHK-09 (camino con firma válida)
- SEC-05 → BE-SEC-02
- SEC-06 → BE-AUTH-17
- SEC-07 → BE-AUTH-20
- SEC-08 → CHAT-N-TKQ-03
- SEC-09 → CHAT-N-CND-06
- SEC-10 → BE-AUTH-21
- SEC-11 → CHAT-LLMF-03
- SEC-12 → BE-SEC-03
- SEC-13 → BE-AUTH-18
- SEC-14 → BE-AUTH-22
- SEC-15 → CHAT-N-SUB-03
- SEC-16 → BE-TWA-10 + BE-GUP-06 + BE-SMS-09 (webhooks de canal sin validar firma/autenticidad)
- SEC-17 → BE-SKL-08 + BE-SKL-09 (fuga de la Skill entre empresas en un flujo compartido)
- SEC-18 → CHAT-N-SMS-04 (nodo `sms` sin scope de tenant en los destinatarios)
- SEC-19 → BE-AUTH-28 (sesión deslizante sin techo, revocación ni chequeo de deshabilitado)
- SEC-20 → BE-IG-11 (InvGate sin HTTPS)
- SEC-21 → BE-SMS-10 (Gupshup SMS con credenciales en la query string)

Los **21 hallazgos** quedan con caso de aceptación propio; ninguno depende ya sólo de cobertura
indirecta.

---

# 📐 Apéndice B — Matrices de comprobación

Vistas cruzadas para verificar de forma sistemática los dos constraints más transversales: el
RBAC dinámico y el aislamiento multitenant. **No duplican el resultado esperado** de las tablas —
apuntan a los IDs de caso, que siguen siendo la fuente única.

## B.1 — Matriz RBAC (permiso ↔ endpoint)

Qué endpoint exige cada par `recurso:acción`. El caso negativo de cualquier celda sigue siempre
el mismo patrón: **sin el permiso → 403** (ver BE-RBAC-02). Rutas relativas a su base
(`/users`, `/roles`, `/flows`, …).

| Recurso | `read` | `create` | `update` | `delete` |
|---------|--------|----------|----------|----------|
| users | GET `/` · `/all` · `/:id` | POST `/` | PATCH `/:id` | DELETE `/:id` |
| areas | GET `/` · `/all` · `/:id` · `/:id/users` · `/by-tenant/:id` | POST `/` | PATCH `/:id` | DELETE `/:id` |
| tenants | GET `/` · `/all` | POST `/` | PATCH `/:id` · POST `/:id/restore` | DELETE `/:id` |
| roles | GET `/` · `/:id` · `/all` · `/by-tenant/:id` · `/catalog` · `/:id/users` | POST `/` | PATCH `/:id` | DELETE `/:id` |
| permissions | GET `/roles/:id/permissions` | POST `/roles/:id/permissions` | PUT `/roles/:id/permissions` | DELETE `/roles/permissions/:id` |
| flows | GET `/` · `/all` · `/:id` | POST `/` | PATCH `/:id` · POST `/:id/assign-tenants` · `/:id/default` | DELETE `/:id` |
| settings | GET `/` · `/:key` · `/providers/status` · `/providers/:p/models` | POST `/` | PATCH `/:key` | DELETE `/:key` |
| context-sources | GET `/` · `/:id` · `/types` · POST `/:id/test-connection` | POST `/` | PATCH `/:id` | DELETE `/:id` |
| devices · conversations · tickets · metrics · channels · llm | — | — | — | — |

Notas:

- **Sin endpoint protegido aún:** `devices`, `conversations`, `tickets`, `metrics`, `channels`,
  `llm` están en el catálogo (para repartir el permiso antes de proteger sus módulos), pero
  ninguna operación los exige hoy.
- **Candado extra `SystemTenantGuard`** (además del permiso RBAC): `users/all`, `areas/all`,
  `areas/by-tenant/:id`, **todo** el CRUD de `tenants`, `roles/all`, `roles/by-tenant/:id`,
  `flows/all`, y **todo** `settings` (a nivel clase). El negativo es "desde un tenant que no es
  el de sistema → 403" (BE-TEN-03, BE-ARE-04/08, BE-RBAC-10, BE-SET-02).
- **Sin `@RequirePermission`** (autorización por-empresa dentro del servicio): `users/mine`,
  `users/multi`, `users/:id/full`, `users/check-availability`, `users/:id/memberships`,
  `areas/mine`, `roles/mine`; y `auth/me` (sólo `JwtAuthGuard`).

## B.2 — Matriz de aislamiento multitenant

**Resolución del tenant activo** (header `X-Tenant-Id`): la matriz completa está en §1.3
(BE-MT-01…11) y no se repite. Resumen de contextos → resultado: 1 tenant sin header = usa el
único; varios sin header = 400; header propio = OK; header ajeno (usuario común) = 403; header
ajeno (usuario de sistema) = OK con rol de sistema; empresa inexistente o dada de baja = 404; sin
ninguna membresía = 403.

**Aislamiento por id** — pedir un recurso de OTRA empresa *teniendo* el permiso. Es donde vive el
IDOR de flujos (SEC-03):

| Recurso (operación por id) | Con id de otra empresa | Caso |
|---|---|---|
| roles (`GET/PATCH/DELETE /:id`) | 404 aislado | BE-RBAC-13 |
| users (`GET /:id`) | 404 "no existe en este tenant" | BE-USR-20 |
| areas (`GET/PATCH/DELETE /:id`) | 404 aislado | BE-ARE-10 / 19 / 22 |
| context-sources (`GET /:id`) | 404 aislado | BE-CS-03 |
| flows (`GET/PATCH/DELETE /:id`) | debería 403/404 | BE-FLW-14 |
| flows (`assign-tenants` / `default`) | debería 403/404 | BE-FLW-16 |
| settings (`:key`) | n/a — `key` es única global, no por tenant | §1.7 |

---

# 🧱 Apéndice C — Juego de datos de prueba

Las precondiciones de las tablas nombran "un tenant con un flujo de inicio asignado a un rol"
o "flujos armados a propósito", pero sin definirlos dos personas ejecutan el plan sobre
escenarios distintos. Este apéndice fija **el escenario único** sobre el que corre todo el
plan. Se arma una vez, sobre una base recién migrada y con el seed aplicado.

## C.1 — Empresas

| Slug | Nombre | Para qué |
|------|--------|----------|
| `system` | Sistema PCI (del seed) | Contexto de superusuario: settings, `/all`, ABM de empresas |
| `acme` | Acme S.A. | Empresa principal: casi todos los casos funcionales |
| `globex` | Globex SRL | La "otra" empresa: aislamiento, IDOR, unicidad por empresa |
| `zombo` | Zombo SRL (dada de baja) | Baja lógica, reactivación, slug ocupado |

## C.2 — Roles

| Empresa | Rol | Permisos |
|---------|-----|----------|
| `system` | `SuperAdmin` (del seed, protegido) | Catálogo completo |
| `acme` | `Soporte N1` | `users:read/create/update`, `areas:read`, `roles:read`, `flows:read` |
| `acme` | `Solo lectura` | Sólo las cuatro `read` de usuarios, áreas, roles y flujos |
| `acme` | `Sin permisos` | Ninguno (para los negativos de 403) |
| `acme` | `Rol vacío` | Ninguno y **sin usuarios asignados** (para probar el borrado de un rol) |
| `acme` | `Recepción inactiva` | Ninguno relevante; existe sólo para portar un flujo de inicio **inactivo** (`F-INACTIVO`) sin chocar con el par `(acme, Soporte N1)` que ya usa `F-PRINCIPAL` |
| `globex` | `Soporte N1` | Mismo nombre que el de Acme: verifica que el nombre es único **por empresa** |

## C.3 — Áreas

- `acme` → `Soporte` y `Ventas`, ambas **con** usuarios asignados (bloquean el borrado) 🧑‍🤝‍🧑

- `acme` → `Sin gente`, **sin** usuarios (para el borrado que sí procede) 🗑️

- `globex` → `Soporte`, mismo nombre que en Acme (unicidad por empresa) 🏢

## C.4 — Personas

| Email | Empresas y rol | Teléfono | Para qué |
|-------|----------------|----------|----------|
| `admin@pci.local` | `system` / SuperAdmin | — | Superusuario del seed |
| `ana@acme.test` | `acme` / Soporte N1, área Soporte | `+5491100000001` | Usuario **conocido** del bot; editor de usuarios |
| `beto@acme.test` | `acme` / Solo lectura | `+5491100000002` | Lecturas sí, escrituras 403 |
| `caro@acme.test` | `acme` / Soporte N1 **y** `globex` / Soporte N1 | `+5491100000003` | Multiempresa: header obligatorio, modo consolidado |
| `dario@acme.test` | `acme` / Sin permisos | `+5491100000004` | Todos los 403 de RBAC |
| `eva@acme.test` | `acme` / Soporte N1, **dada de baja** | `+5491100000005` | Baja lógica, campos únicos liberados, sesión tras la baja |
| — (sin usuario) | — | `+5491199999999` | Número **desconocido** del bot |

> El interno telefónico y el id de Invgate se cargan sólo en `ana@acme.test`, para tener un
> valor ocupado de cada uno de los cuatro datos únicos globales.

## C.5 — Flujos

| Nombre | Asignación | Contenido |
|--------|------------|-----------|
| `F-PRINCIPAL` | `acme` + rol `Soporte N1`, marcado **Inicio** | `start` → menú de 3 opciones → una rama por opción, una con `ticket_create` y otra con `end` |
| `F-NODOS` | `acme` + rol `Solo lectura`, marcado **Inicio** para ese rol | Un camino por tipo de nodo, aislados: menú de 4–10 opciones, menú de más de 10, `input`, `condition` (palabra clave, expresión regular válida, expresión regular inválida, variable), `ticket_query`, `transfer_agent`, `llm_query` con y sin salida, `delay`, `variable`, `webhook`, `device_validation` |
| `F-SUB` | `acme`, sin marcar inicio | Destino de los saltos a sub-flujo; su menú permite probar "Volver" cruzando flujos |
| `F-DEFAULT` | **Sin empresas**, marcado default global | Atiende a los desconocidos y a los roles sin flujo propio |
| `F-CICLO` | `acme`, sin marcar inicio | Dos nodos `message` apuntándose entre sí: dispara el tope de 25 pasos |
| `F-INACTIVO` | `acme` + rol `Recepción inactiva`, marcado inicio pero `isActive:false` | Verifica que un inicio inactivo no se usa (cae al default global). Va en un rol propio porque la invariante "un flujo de inicio por (empresa+rol)" desmarca cualquier otro inicio del par —activo o no—, así que no puede compartir `(acme, Soporte N1)` con `F-PRINCIPAL` |
| `F-GLOBEX` | `globex` | Objetivo de los casos de aislamiento por id |
| `F-SMS-TICKET` | `acme`, sin marcar inicio | Un nodo `sms` (destinatarios = usuarios del tenant) y un nodo `ticket_create` con `category`/`priority`/`ticketType` elegidos **por nombre** de InvGate: precondición de los casos de nodo SMS (CHAT-N-SMS-*), del ticket con catálogo (CHAT-N-TKC-05/06) y del editor (FE-FLW-19/20) |
| `F-COMPARTIDO` | `acme` **y** `globex` (mismo `Flow`, N:N vía `TenantFlow`), vinculado a la Skill `Contexto Soporte N1` de **acme** | Precondición de la fuga cross-tenant de la Skill (BE-SKL-08): una charla de `globex` por este flujo **no** debería recibir en el prompt la skill de `acme` |

> `F-NODOS` incluye a propósito un nodo `subflow` que apunta a un flujo **borrado** y una
> condición con expresión regular inválida: son las precondiciones de dos casos de fallo.

## C.6 — Fuentes de verdad

- `acme` → una de tipo **broker** apuntando a un RAG real y alcanzable 🔌

- `acme` → una de tipo **MCP** con una URL que no responde (para el camino de error) ⛔

- `acme` → una de tipo **n8n** apuntando a un webhook **de prueba**, nunca al productivo ⚠️

- `globex` → una cualquiera, sólo para los casos de aislamiento 🏢

## C.7 — Skills

- `acme` → `Contexto Soporte N1` (**activa**): `promptText` con instrucciones de rol (tono, alcance, qué
  puede resolver). Vinculada a `F-PRINCIPAL` y a `F-COMPARTIDO` — es la skill que se concatena al system
  prompt en CHAT-LLMF-10 / CHAT-N-LLM-05, y la que **no** debe filtrarse a `globex` en BE-SKL-08 🧠

- `acme` → `Skill inactiva` (`isActive:false`): para verificar que el flag hoy **no** gatea el motor
  (BE-SKL-10) y que el selector del editor filtra por `isActive` (FE-FLW-18) 🚫

- `globex` → `Contexto Soporte N1` (mismo nombre que la de acme): confirma que el nombre es único **por
  empresa** (BE-SKL-03) y sirve para los casos de aislamiento por id (BE-SKL-04) 🏢

## C.8 — Canales e integraciones (Twilio, Gupshup, InvGate)

- **Proveedores por defecto:** `WHATSAPP_PROVIDER=meta` y `SMS_PROVIDER=twilio`. Casi todo el plan corre
  por `simulate`/Meta; se cambian a `twilio`/`gupshup` **sólo** para los bloques §1.19–§1.21, y el cambio
  **exige reiniciar el backend** (se leen una vez al arrancar) 🔀

- **Credenciales de canal:** `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_WHATSAPP_FROM`/
  `TWILIO_SMS_FROM` y `GUPSHUP_API_KEY`/`GUPSHUP_WHATSAPP_SOURCE`/`GUPSHUP_APP_NAME`/`GUPSHUP_SMS_USERID`/
  `GUPSHUP_SMS_PASSWORD` cargadas en `/settings` (los secretos, cifrados). La **mecánica** de los
  conectores se prueba sin proveedor real (mock/inspección del payload); el envío **end-to-end** de SMS
  por Twilio queda bloqueado hasta tener un número habilitado para SMS (BE-PH-06) ⚠️

- **InvGate:** `INVGATE_API_URL` (https), `INVGATE_API_USER`, `INVGATE_API_KEY` (secreto) y los
  `INVGATE_DEFAULT_*` (categoría/prioridad/tipo/fuente) cargados para los casos de resolución por nombre y
  catálogo (BE-IG-03/05). La validación **end-to-end** contra la instancia real queda bloqueada hasta que
  el admin genere un **token de API real** (el cargado resultó ser la contraseña de portal — BE-IG-14 /
  BE-PH-01) 🎫

- La clave maestra `SETTINGS_ENCRYPTION_KEY` ya está cargada (C.9), condición para guardar cualquiera de
  estos secretos 🔑

## C.9 — Configuración inicial

- El segundo factor arranca **apagado**: casi todo el plan corre sin él, y se enciende sólo
  para el bloque de autenticación 🔐

- La clave maestra de cifrado tiene que estar cargada en el entorno desde el principio: sin
  ella no se pueden probar ni los secretos de configuración ni los de las fuentes 🔑

- El servidor de correo arranca **sin configurar** (los emails van a consola) y se configura
  sólo para el bloque de email 📧

## C.10 — Higiene entre corridas

- Las bajas lógicas **no se revierten**: cada corrida completa deja usuarios y empresas dadas
  de baja. Para repetir el plan de cero conviene recrear la base y volver a armar el escenario ♻️

- Las conversaciones del bot se cierran solas por inactividad, así que los casos de chatbot no
  necesitan limpieza manual — salvo que se quiera arrancar una charla nueva, donde sirve el
  comando de reinicio del chat por consola 💬

---
