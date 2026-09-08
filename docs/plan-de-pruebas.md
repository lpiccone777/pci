# 🧪 Plan de pruebas — PCI Chatbot

> **Actualizado hasta el commit `f0633ab`** en la rama `juang-dev` — «test: actualizar la batería
> e2e desactualizada» (2026-09-07). Incorpora el **calendario de feriados/guardias** y las
> **variantes de flujo** que dispara (§1.25, §1.26, §3.13), el **ruteo del mensaje entrante por la
> membresía del teléfono** con su selector de empresa (§1.24), los nodos **Notificación** y
> **Webhook** —este último dejó de ser un simulacro—, el rediseño de **Condición** (comparación de
> variable con dos salidas) y de **Consultar ticket** (lista en vivo contra InvGate), el saludo
> configurable del nodo Inicio, los tiempos de vida de una charla como configuración, las métricas
> reales del inicio, y la recepción de imágenes por Gupshup. El canal **SMS pasó a ser 100%
> saliente** (sus dos webhooks se eliminaron). Cierra **SEC-18** y **SEC-21**, casi todo **SEC-03**
> (queda `POST /flows/:id/default`) y la parte de **SEC-16** que cubría Twilio y SMS; suma como
> riesgos nuevos el nodo Webhook sin restricción de destino, la descarga de media de Gupshup sin
> validar y la enumeración de empresas por el selector.

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
riesgo, y una columna extra en 577 filas sería ruido más que ayuda. La columna **P** del tablero
la fija para cada bloque.

- **`P0` — bloqueante.** Autenticación, permisos, aislamiento entre empresas, secretos, datos de
  partida, y el camino por el que pasa toda conversación (pipeline, arranque, nodos y el
  recorrido de punta a punta). Si algo de acá falla, el sistema no se libera 🔴

- **`P1` — importante.** El resto de lo funcional: ABM, editor de flujos, broker, canales,
  proveedores de modelo, pantallas del panel. Un fallo acá se registra y se decide, no frena
  automáticamente 🟠

- **`P2` — deseable.** Comportamiento responsive. Se ejecuta si hay margen 🟢

**Los 37 casos invertidos son `P0` por definición**, sin importar en qué bloque
estén: describen el comportamiento seguro o correcto que hoy no existe (incluye los 4 que quedan
de la auditoría de frontend multiempresa del 2026-08-21). Liberar con alguno en `❌` es una
decisión de riesgo tomada a propósito, no un descuido del tablero.

### Caso excluido (⏭️)

Un resultado esperado que arranca con **⏭️ Excluido** describe un caso que **no se
automatiza**: el gesto es difícil de reproducir de forma confiable en un test end-to-end y
su valor relativo es bajo. La descripción del comportamiento esperado se conserva igual —
sigue siendo válida para una verificación manual—, pero el caso queda fuera de la batería
automatizada. Distinto de `❌` (comportamiento correcto que hoy no existe): un caso `⏭️`
puede funcionar perfecto; simplemente se decide no cubrirlo con automatización.

### Caso bloqueado por infraestructura real (🔌)

Un resultado esperado que arranca con **🔌 Bloqueado (infra real)** describe un caso cuyo
comportamiento es correcto y deseable, pero que **no corre en la batería automatizada** porque
exige infraestructura externa viva que no se puede simular sin terminar probando el mock en vez
del sistema: un **servidor SMTP real**, una **API key real** de un proveedor de LLM externo, o el
backend levantado en una configuración de entorno particular. El test existe pero queda como
`skip` con la anotación `[BLOQUEADO: …]`. Distinto de `⏭️` (gesto difícil de reproducir y de bajo
valor) y de `❌` (comportamiento correcto que hoy no existe): un caso `🔌` está implementado y se
verifica **a mano** contra la infraestructura real cuando hace falta.

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
Total del plan: **727 casos** · Backend 394 · Chatbot 181 · Frontend 152 · de los cuales **346 son `P0`**
(328 por la prioridad del bloque + los 18 casos invertidos que caen en bloques `P1`: BE-FLW-21, BE-FLW-22,
BE-WHK-08, BE-TWA-14, BE-GUP-06, BE-GUP-10, BE-SMS-07, BE-IG-11, BE-SKL-08, BE-SKL-09, BE-SKL-10,
BE-VAR-11, CHAT-LLMF-03, CHAT-LLMF-11, CHAT-LLMF-12, FE-USR-15, FE-FLW-23 y FE-FLW-25).

| Bloque | P (prioridad) | Casos |
|--------|:-:|------:|
| **Backend (§1)** | | **394** |
| 1.1 Autenticación | 🔴 P0 | 28 |
| 1.2 RBAC | 🔴 P0 | 26 |
| 1.3 Multitenant | 🔴 P0 | 13 |
| 1.4 Tenants | 🟠 P1 | 11 |
| 1.5 Usuarios | 🔴 P0 | 36 |
| 1.6 Áreas | 🟠 P1 | 23 |
| 1.7 Configuración y secretos | 🔴 P0 | 22 |
| 1.8 Flujos | 🟠 P1 | 25 |
| 1.9 Fuentes de verdad | 🟠 P1 | 20 |
| 1.10 LLM | 🟠 P1 | 20 |
| 1.11 Broker | 🟠 P1 | 13 |
| 1.12 Webhook WhatsApp | 🟠 P1 | 8 |
| 1.13 Salida WhatsApp | 🟠 P1 | 9 |
| 1.14 Canal de email | 🔴 P0 | 8 |
| 1.15 Datos, seed y migraciones | 🔴 P0 | 6 |
| 1.16 Endpoints públicos | 🟠 P1 | 3 |
| 1.17 Seguridad transversal | 🔴 P0 | 3 |
| 1.18 Placeholders | 🚧 | 6 |
| 1.19 Canal WhatsApp — Twilio | 🟠 P1 | 19 |
| 1.20 Canal WhatsApp — Gupshup | 🟠 P1 | 10 |
| 1.21 Canal SMS (Twilio y Gupshup) | 🟠 P1 | 14 |
| 1.22 Integración InvGate | 🟠 P1 | 17 |
| 1.23 Skills | 🟠 P1 | 11 |
| 1.24 Ruteo de tenant entrante | 🔴 P0 | 13 |
| 1.25 Calendario de feriados/guardias | 🟠 P1 | 14 |
| 1.26 Variantes de flujo | 🟠 P1 | 11 |
| 1.27 Métricas del inicio | 🟠 P1 | 2 |
| 1.28 Registros en disco | 🟠 P1 | 3 |
| **Chatbot (§2)** | | **181** |
| 2.1 Pipeline | 🔴 P0 | 11 |
| 2.2 Arranque de flujo | 🔴 P0 | 8 |
| 2.3 Nodos del motor | 🔴 P0 | 113 |
| 2.4 Encadenamiento | 🟠 P1 | 5 |
| 2.5 Espera en dos fases | 🟠 P1 | 3 |
| 2.6 Conocido vs desconocido | 🔴 P0 | 4 |
| 2.7 LLM dentro/fuera | 🟠 P1 | 12 |
| 2.8 Cierre y cancelación | 🟠 P1 | 3 |
| 2.9 Interpolación | 🟠 P1 | 3 |
| 2.10 End-to-end | 🔴 P0 | 5 |
| 2.11 Cierre por inactividad | 🟠 P1 | 6 |
| 2.12 Concurrencia y carga | 🟠 P1 | 4 |
| 2.13 Placeholders | 🚧 | 4 |
| **Frontend (§3)** | | **152** |
| 3.1 Infraestructura | 🔴 P0 | 19 |
| 3.2 Login y OTP | 🔴 P0 | 7 |
| 3.3 Dashboard | 🟠 P1 | 2 |
| 3.4 Usuarios | 🟠 P1 | 22 |
| 3.5 Roles | 🟠 P1 | 10 |
| 3.6 Tenants | 🟠 P1 | 7 |
| 3.7 Áreas | 🟠 P1 | 5 |
| 3.8 Configuración | 🟠 P1 | 17 |
| 3.9 Fuentes de verdad | 🟠 P1 | 12 |
| 3.10 Flujos (editor) | 🟠 P1 | 34 |
| 3.11 Responsive | 🟢 P2 | 4 |
| 3.12 Seguridad de UI | 🔴 P0 | 6 |
| 3.13 Calendario (UI) | 🟠 P1 | 7 |
| **TOTAL** | | **727** |

> **Nota:** **37 casos** arrancan en `❌` **por diseño** (describen el comportamiento seguro o correcto
> deseado, hoy no implementado) y pasan a `✅` al corregir el hallazgo — no son regresión. **22** están
> ligados a los **21 hallazgos `SEC-*`** (varios `SEC-*` cubren más de un caso: `SEC-16` agrupa ahora
> BE-GUP-06 y BE-GUP-10, `SEC-17` agrupa BE-SKL-08 / BE-SKL-09, `SEC-09` agrupa CHAT-N-CND-06 / 08, y
> BE-FLW-22 es lo que queda vivo de `SEC-03`). Los otros **15** son de **robustez, calidad, privacidad o
> UX**, sin número de hallazgo: BE-EML-03 (canal de email caído), CHAT-N-LLM-04 (nodo LLM sin blindar),
> BE-SMS-07 (Gupshup SMS descarta el menú), BE-SKL-10 (`isActive` de Skill sin efecto en el motor),
> CHAT-LLMF-11 / CHAT-LLMF-12 (prompt injection y alucinación desde la fuente de verdad), BE-FLW-21
> (validación floja de los parámetros de extracción de `llm_query`), BE-TWA-14 (media de Twilio sin tope
> de bytes), BE-ITR-12 (los adjuntos del selector de empresa se borran antes de que se responda),
> BE-VAR-11 (borrar un flujo Principal deja su variante huérfana y reaparece en el listado global),
> CHAT-N-NOT-07 (la URL del botón de link no se interpola), CHAT-N-WHK-04 (el nodo webhook llama a
> cualquier destino), y los **3 que quedan de la auditoría de frontend multiempresa** (2026-08-21):
> FE-USR-15 (falso "cambios sin guardar"), FE-FLW-23 (dropdowns del editor con la empresa activa en vez
> de la del flujo) y FE-FLW-25 (Flujos oculta el 403).
>
> **Casos que pasaron a `✅` en esta actualización** (13): CHAT-N-SMS-04 (SEC-18), BE-FLW-14 y BE-FLW-16
> (SEC-03, salvo BE-FLW-22), BE-TWA-10 y BE-SMS-09 (SEC-16, este último por eliminación del webhook),
> BE-SMS-10 (SEC-21), FE-INF-16, FE-TEN-06, FE-TEN-07, FE-CS-11, FE-CS-12, FE-USR-16 y FE-FLW-24
> (auditoría de frontend multiempresa). En actualizaciones previas ya habían pasado SEC-08 /
> CHAT-N-TKQ-03, BE-MT-12, FE-INF-13, BE-IG-10 y FE-FLW-29.
>
> El escenario de datos sobre el que corre todo el plan está en el **Apéndice C**; las matrices de
> comprobación transversales, en el **Apéndice B**.

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
catálogo completo (**64 permisos = 16 recursos × 4 acciones**; el 15º recurso es `skills` y el 16º
`schedule-calendar`, sumado por el calendario de feriados/guardias — §1.25). Un endpoint sin
`@RequirePermission` **permite** (el guard sólo corta cuando hay permiso declarado). Un endpoint
puede además declarar **varios** permisos alternativos con `RequireAnyPermission` (semántica "o"):
alcanza con tener **uno** de ellos.

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
| BE-RBAC-17 | `GET /roles/catalog` | El catálogo de permisos (**16 recursos × 4 acciones = 64**; el 15º es `skills` y el 16º `schedule-calendar`) con el que se dibuja la matriz del backoffice |
| BE-RBAC-18 | `PATCH /roles/:id` renombrando un rol común | 200; nombre único por empresa (repetido → 409 "Ya existe un rol llamado X en esta empresa") |
| BE-RBAC-19 | `PATCH /roles/:id` sobre el rol protegido (SuperAdmin de sistema) | 409 (`assertNotProtected`): no se puede renombrar |
| BE-RBAC-20 | `DELETE /roles/:id` de un rol **sin** usuarios asignados | 200, lo elimina |
| BE-RBAC-21 | `DELETE /roles/:id` de un rol **con** usuarios asignados | 409 "No se puede eliminar X: N usuarios lo tienen asignado…" (la FK de `UserTenant.role` no cascadea) |
| BE-RBAC-22 | `DELETE /roles/:id` del rol protegido | 409 (`assertNotProtected`) |
| BE-RBAC-23 | `DELETE /roles/permissions/:id` (quitar un permiso puntual) | Quita esa fila `RolePermission` del rol; el cambio se refleja en la siguiente request sin reiniciar |
| BE-RBAC-24 | `GET /roles/:roleId/permissions` | Lista los pares `resource`/`action` de ese rol; pide `permissions:read` |
| BE-RBAC-25 | `GET /roles` con un rol que tiene **solo `users:create`** (sin `roles:read`), con **solo `roles:read`**, y sin ninguno de los dos | Los dos primeros: 200. El tercero: 403 con las alternativas listadas ("Permiso denegado: roles:read o users:create"). El alta de usuarios necesita listar los roles para asignarlos, y sin esta apertura el desplegable quedaba vacío y el alta trabada (FE-USR-16) |
| BE-RBAC-26 | Forma de la respuesta de `GET /roles` según quién llama | Con `roles:read` (o siendo el superusuario del sistema) viene el rol completo, con su matriz de permisos. Con **solo** `users:create` vienen únicamente id y nombre: lo que el desplegable de asignación necesita, sin exponerle la matriz de permisos de cada rol de la empresa. Abrir el endpoint no debe convertirse en una fuga del diseño de permisos ajeno |

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
| BE-MT-12 | El **superusuario del sistema** parado en una empresa común (header con el id de esa empresa) llama a **todas** las operaciones con candado de superusuario: configuración, ABM de empresas, y las vistas de todas las empresas de usuarios, roles, áreas y flujos | **Debe** responder 200 en todas, **por el mismo mecanismo que ya deja pasar al resto del menú**: cuando el superusuario se para en una empresa de la que no es miembro, `TenantGuard` le deja como vínculo activo el de la **empresa de sistema** (BE-MT-06), y de ese vínculo salen sus permisos. El candado tiene que leer ese vínculo —igual que `RolesGuard` con todos los demás ítems—, no la empresa elegida en el selector. Un administrador de empresa común sigue recibiendo 403 aunque se auto-asigne el permiso: no tiene vínculo con la empresa de sistema y no puede dárselo. Todas son **globales por naturaleza** (la configuración es única en toda la base y las vistas de todas las empresas no dependen de cuál esté elegida), así que devuelven lo mismo esté parado donde esté. ✅ Implementado: el candado lee el **vínculo resuelto** (`SystemTenantGuard` mira `request.userTenant`, y `TenantGuard.resolveAsSystemUser` deja el vínculo de sistema y exige rol SuperAdmin), no la empresa activa, así que responde 200 esté parado donde esté. **Las dos pantallas del menú (Configuración y Tenants) son el síntoma visible; el resto viaja con el mismo cambio** porque el candado es una sola pieza compartida |
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
dentro del servicio (empresas en el body), no por header. La **importación masiva**
(`POST /users/bulk-import`) crea muchas personas de un Excel en una transacción, con rol/área
únicos para todo el lote, contraseñas temporales autogeneradas y reporte parcial de fallidas.

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
| BE-USR-27 | `POST /users/bulk-import` con un lote válido (Nombre/Apellido/Email + `defaultRoleId` del tenant) | 201 con `summary.created=N`, `failed=0`; crea persona + membresía en el tenant activo con ese rol; cada creado con `tempPassword` autogenerada. Hereda `JwtAuthGuard, TenantGuard, RolesGuard` + `users:create`; opera sobre el tenant del header, **no** cross-tenant (no lleva `SystemTenantGuard`) |
| BE-USR-28 | `bulk-import` con `defaultAreaId` de un área del tenant | Todas las membresías del lote quedan con esa área |
| BE-USR-29 | `bulk-import` con un email del archivo que ya existe (activo) en la empresa | Reporte parcial: esa fila va a `failed` con motivo, el resto se crea. El `createMany` usa `skipDuplicates`, así que un choque TOCTOU entre el pre-check y la transacción no aborta el lote |
| BE-USR-30 | `bulk-import` con dos filas del mismo email/phone/interno/invgate **dentro del archivo** | La segunda va a `failed` ("duplicado en el archivo"); la primera se crea |
| BE-USR-31 | `bulk-import` con filas sin email o sin nombre/apellido | **400 del lote entero** (igual que BE-USR-32): el `ValidationPipe` global rechaza el DTO por el `@IsEmail`/`@IsNotEmpty` de cada fila (`@ValidateNested`) **antes** de llegar al servicio — mensaje `rows.<i>.El email no es válido` / `El nombre es obligatorio`. Las ramas `'Falta el email'`/`'Falta nombre o apellido'` de `bulkImport` son **código muerto** por este camino; el reporte parcial (`failed`) queda solo para los **duplicados** (BE-USR-29/30), que tienen formato válido y pasan el DTO. Verificado con POST directo al endpoint |
| BE-USR-32 | `bulk-import` con más de 10.000 filas, o con un email inválido / campo sobre-largo | >10.000 → 400 (`@ArrayMaxSize(10000)`); formato inválido (`@IsEmail`/`@MaxLength`) → **400 del lote entero** (validación de DTO, no reporte parcial). El body admite hasta 10 MB (`json({ limit:'10mb' })` en `main.ts`) |
| BE-USR-33 | `bulk-import` con `defaultRoleId` o `defaultAreaId` de **otro** tenant | 400 "…no existe o no pertenece a este tenant" (`assertRoleBelongsToTenant` / `assertAreaBelongsToTenant`) |
| BE-USR-34 | `bulk-import` parado (header `X-Tenant-Id`) en una empresa donde el solicitante **no** es miembro | 403 (`TenantGuard`), salvo superusuario del sistema. El aislamiento no depende del body |
| BE-USR-35 | Sensibilidad de la respuesta: `created[].tempPassword` viaja en claro (no hay invitación por email) | Documentar que la respuesta y el CSV que descarga el backoffice contienen contraseñas en texto plano — dato sensible, uso acotado a la carga inicial |
| BE-USR-36 | Asignar el rol protegido **SuperAdmin** mandando su `roleId` en `POST /users`, `/users/multi`, `PATCH /users/:id`, `/users/:id/full` o `bulk-import`, sin ser superusuario del sistema | 403 "Solo el superusuario del sistema puede asignar ese rol" en los cinco caminos. La validación de pertenencia sola **no alcanzaba**: ese rol pertenece de verdad al tenant de sistema, así que cualquiera con `users:create`/`users:update` ahí podía ver su id por `GET /roles` y otorgárselo a sí mismo o a un tercero — escalada de privilegios directa. El superusuario sí puede asignarlo |

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
| BE-SET-18 | Guardar los secretos de los canales e InvGate (`TWILIO_AUTH_TOKEN`, `GUPSHUP_API_KEY`, `INVGATE_API_KEY`) | Se guardan **cifrados** (AES-256-GCM); el `GET` los enmascara + `isSet`. Los identificadores **no** secretos (`TWILIO_ACCOUNT_SID`, `TWILIO_WEBHOOK_PUBLIC_URL`, `GUPSHUP_SMS_APP_ID`, `GUPSHUP_SMS_SOURCE`, `INVGATE_API_USER`, números `*_FROM`) van en claro. `GUPSHUP_SMS_PASSWORD`/`GUPSHUP_SMS_USERID` **ya no existen**: eran de la cuenta legacy "Enterprise SMS", reemplazada por la API de SMS con `GUPSHUP_API_KEY` compartida (§1.21) |
| BE-SET-19 | Selectores de proveedor `WHATSAPP_PROVIDER` (`meta`/`twilio`/`gupshup`) y `SMS_PROVIDER` (`twilio`/`gupshup`) | Cascada estándar BD → env → default (`meta`/`twilio`); un valor fuera del enum → 400 (`allowedValues`). ⚠️ A diferencia de `LLM_PROVIDER`, se leen **una sola vez al arrancar**: cambiarlos no re-suscribe los consumers sin reiniciar (ver BE-TWA-02) |
| BE-SET-20 | Descripciones de `TWILIO_ACCOUNT_SID` e `INVGATE_API_USER` | Dicen "solo escritura por consistencia" pero están `secret:false`: el `GET` los devuelve **en claro**. Inocuo (un SID no es sensible), pero la descripción sugiere algo que el flag no cumple — anotar la discrepancia |
| BE-SET-21 | Grupos nuevos del catálogo: **Simulación** (`CONVERSATIONS_SIMULATE_ENABLED`) y **Otros** (`CONVERSATION_INACTIVITY_MINUTES`, `CONVERSATION_RESUME_WINDOW_HOURS`), más los asuntos de email (`OTP_EMAIL_SUBJECT`, `DEVICE_VALIDATION_EMAIL_SUBJECT`) | Aparecen en `GET /settings` con su grupo, tipo y rango. Los dos tiempos de charla respetan `min`/`max` (1–10080 minutos y 1–720 horas): fuera de rango → 400 (BE-SET-04). Son **dos ventanas encadenadas y distintas**, no lo mismo: primero la charla se cierra por inactividad, después queda retomable (§2.11). Los dos asuntos de email son de **mails distintos** —login del backoffice vs. validación de dispositivo del chat— y no deben confundirse |
| BE-SET-22 | `CONVERSATIONS_SIMULATE_ENABLED` sin valor explícito, en `NODE_ENV=production` y fuera de producción | Sin valor fijado, `resolveDefault` deja el endpoint **habilitado** fuera de producción (dev y test — Jest fija `NODE_ENV=test`, así que los e2e siguen andando) y **deshabilitado** en producción: `POST /conversations/simulate` responde **404**, no 403 (el endpoint no debería ni figurar como existente). Fijar la clave a mano manda en cualquier sentido. Mismo mecanismo que `defaultOtpEnabled` |

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
| BE-FLW-14 | `GET`/`PATCH`/`DELETE /flows/:id` con el id de un flujo de **otra** empresa | ✅ **404 "Flujo no encontrado"** en los tres: pasan por `assertFlowAccessible`. Se devuelve 404 y no 403 a propósito, para no filtrar que ese id existe en otra empresa. El SuperAdmin queda exceptuado (administra el sistema entero). Cierra la parte de **SEC-03** que cubre estas rutas |
| BE-FLW-15 | Crear/editar un flujo con `context` fuera de la lista (distinto de `none`/`invgate`/`internal_kb`/`other`) | 400 (`@IsIn(FLOW_CONTEXT_VALUES)`); un `context` válido se persiste |
| BE-FLW-16 | `POST /flows/:id/assign-tenants` con el id de un flujo de **otra** empresa | ✅ **404**: `assignTenants` corta por el flujo de **origen** (`assertFlowAccessible`) además de validar las empresas destino (BE-FLW-23). El caso hermano de `POST /flows/:id/default`, que **sigue abierto**, se separó en BE-FLW-22 |
| BE-FLW-17 | Vincular una Skill a un flujo con `skillId` (y desvincular con `skillId:null`) | 200; `findById` incluye `skill { id, name, promptText }` y en runtime el `promptText` se concatena al system prompt base (`buildBasePrompt`). Reemplaza en el editor al dropdown viejo `context` (que sobrevive `@IsIn(FLOW_CONTEXT_VALUES)`, DEPRECATED, sólo por compatibilidad — BE-FLW-15). El aislamiento por empresa del `skillId` se cubre en BE-SKL-08/09 |
| BE-FLW-18 | `GET /flows/mine` (vista "Todas mis empresas") de un usuario con `flows:read` **solo en la empresa B**, parado en la **A** (header) donde **no** lo tiene | 200 con los flujos de B, **no 403**. La autorización es por-empresa adentro de `FlowService.findMine` (filtra cada empresa por su `flows:read`), no sobre el tenant activo — por eso `/flows/mine` **no** lleva `@RequirePermission`, igual que `/areas/mine` (BE-ARE-05), `/users/mine` (BE-USR-19) y `/roles/mine` (BE-RBAC-16). Reponer el decorator lo evaluaría contra el rol de A y cortaría con 403 a quien sí tiene el permiso en otra empresa: regresión que este caso detecta |
| BE-FLW-19 | `GET /flows/mine` de un usuario **sin `flows:read` en ninguna** de sus empresas | 200 con `[]`, **no 403** (mismo criterio que BE-ARE-06 / BE-USR-19). La ausencia de permiso da lista vacía, no error: otra red de seguridad contra un `@RequirePermission` repuesto en el controlador |
| BE-FLW-20 | `POST /flows/:id/assign-tenants` con un `roleId` que pertenece a **otro** tenant (o inexistente) | 400 "El rol … no existe o no pertenece al tenant …": `applyTenantAssignment` valida la pertenencia de cada `roleId` antes de la transacción de reemplazo (mismo criterio que `assertRoleBelongsToTenant`) |
| BE-FLW-21 | Nodo `llm_query` con `temperature`, `maxAttempts` o items de `extractVariables` fuera de rango/forma por API directa (`temperature:999`, `maxAttempts:"abc"`, item sin esquema) | **Debería** validarse (rango de `temperature`, `@Min` de `maxAttempts`, `@ValidateNested` de cada item). ⚠️ Hoy el DTO valida `temperature`/`extractVariables` solo con `@IsNumber`/`@IsArray` y `maxAttempts` sin `@IsNumber`: pasan sin control y llegan al motor: `❌` (robustez, sin número de hallazgo) |
| BE-FLW-22 | `POST /flows/:id/default` con el id de un flujo de **otra** empresa, teniendo `flows:update` en la propia | **Debe** cortar: `isDefault` es un fallback **global del sistema entero**, así que la operación tendría que exigir el candado de tenant de sistema (o al menos pertenencia, como sus hermanas). ⚠️ Es el **resto vivo de SEC-03**: a diferencia de `findById`/`update`/`delete`/`assign-tenants`, esta ruta nunca recibió `req.userTenant` y `setDefault` no chequea nada — con un permiso de nivel empresa se cambia el flujo por defecto de todo el sistema, y se puede promover uno ajeno: `❌` hasta gatearla |
| BE-FLW-23 | `POST /flows` o `POST /flows/:id/assign-tenants` con una empresa destino a la que el solicitante **no pertenece** (o que está dada de baja) | 403 "No podés asignar el flujo a una empresa a la que no pertenecés: …". Se valida **antes** de crear, para no dejar un flujo huérfano. La membresía sobrevive a la baja lógica de la empresa, así que el chequeo filtra además `tenant.deletedAt: null`. El SuperAdmin asigna a cualquiera |
| BE-FLW-24 | `GET /flows/:id` de un flujo **sin empresas** (borrador recién creado) pedido por su creador vs. por otra persona; y de un flujo compartido con varias empresas del usuario, parado en una de ellas | El borrador solo lo abre su `createdBy` (nadie más puede descubrir su id: no aparece en ningún listado); para los demás, 404. El flujo compartido se abre desde **cualquiera** de las empresas del usuario donde tenga `flows:read` — el scope lo pone la membresía, **no** el header: la vista "Todas mis empresas" manda una empresa de respaldo que puede no ser la del flujo, y cortar por la activa rompería abrirlo |
| BE-FLW-25 | Un usuario de la empresa A edita un flujo **compartido** con B (acceso legítimo) y cuela en el payload una referencia a un recurso de B (`skillId`, `contextSourceId`, `userId` de un nodo) sin ser miembro de B | La referencia se **sanea igual**: las empresas que el flujo ya tiene asignadas solo cuentan para el saneo si quien edita **realmente pertenece** a ellas. Sin este recorte, compartir un flujo alcanzaba para vincular recursos de la otra empresa. El SuperAdmin no pasa por el saneo, a propósito |

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
| BE-CS-11 | `DELETE /context-sources/:id` de una fuente **vinculada a un flujo** | **409 `ConflictException`, no borra**: el servicio cuenta los flujos que la usan y corta con "…está vinculada a N flujo(s). Desvinculala antes de eliminarla." antes de tocar la BD. El `onDelete: SetNull` del schema queda como defensa en profundidad muerta por este camino (nunca se llega). Coherente con FE-CS-07 |
| BE-CS-12 | `DELETE /context-sources/:id` de una fuente sin uso | 200, la elimina |
| BE-CS-13 | `POST /context-sources/:id/test-connection` de una fuente alcanzable | Publica por el broker (RPC), responde `{ ok:true, message, latencyMs, statusCode? }` dentro de `TEST_TIMEOUT_MS` (20s) |
| BE-CS-14 | `test-connection` de una fuente inalcanzable o que no responde | `{ ok:false, message }` con el motivo; no cuelga (corta a los 20s) |
| BE-CS-15 | Cualquier operación sin el permiso `context-sources:*` correspondiente | 403 "Permiso denegado: context-sources:acción" |
| BE-CS-16 | `test-connection` de una fuente de tipo **MCP** | Comprueba que la URL del servidor responde, mandando las cabeceras configuradas (incluida la credencial descifrada); informa el código de estado y la latencia |
| BE-CS-17 | `test-connection` de una fuente de tipo **RAG** | Mismo mecanismo que MCP: alcance HTTP contra la URL configurada. No valida el contrato de consulta, sólo que el servicio está arriba |
| BE-CS-18 | `test-connection` de una fuente de tipo **n8n** | ⚠️ **Hace un POST real al webhook**: probar la conexión puede **disparar el workflow**. Usar siempre una URL de prueba (ver Apéndice C), nunca la productiva. Devuelve el resultado del webhook |
| BE-CS-19 | `test-connection` de una fuente de tipo **broker** | No sale por HTTP: publica en la cola configurada y espera respuesta por el broker (modo correlacionado o cola fija según la fuente); si nadie consume, corta por timeout con `ok:false` |
| BE-CS-20 | `GET /context-sources/all` (superusuario) y `GET /context-sources/mine` (usuario común) | `all` trae las fuentes de **todas** las empresas con la suya en cada fila, excluyendo las dadas de baja, y va con `SystemTenantGuard` — desde un tenant que no es el de sistema, 403. `mine` trae las de las empresas donde el usuario tiene `context-sources:read`, sin `@RequirePermission` (la autorización es por-empresa adentro del servicio) y devolviendo `[]` —no 403— si no lo tiene en ninguna, mismo criterio que `/areas/mine` y `/flows/mine`. Los dos siguen enmascarando los campos secretos de `config` |

## 1.10 LLM — proveedores y modelos

**Precondición:** la lógica de negocio nunca llama al SDK del proveedor directo, siempre vía
`LlmService`. La API key, modelo y base URL las resuelve `LlmProviderFactory`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-LLM-01 | `chat()` con proveedor OpenAI configurado y key válida | Devuelve la respuesta del modelo. 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-02 | Proveedor sin API key (los que la requieren) | 400 al resolver la config |
| BE-LLM-03 | OpenCode Go sin `OPENCODEGO_API_URL` (`baseUrl`) | 400 (para este proveedor la base URL es obligatoria, la key no) |
| BE-LLM-04 | Alias de proveedor (`google`→gemini, `anthropic`→claude, `opencode`→opencodego) | Resuelve al proveedor correcto |
| BE-LLM-05 | Proveedor desconocido en `LLM_PROVIDER` | Warn + fallback a OpenAI |
| BE-LLM-06 | `GET /settings/providers/:provider/models` con key válida | Lista de modelos con `source: api` (caché de 5 min). 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-07 | Mismo endpoint con `?refresh=true` | Saltea la caché y reconsulta. 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-08 | Proveedor caído o timeout (8s) al listar modelos | `source: fallback` + motivo. Para la mayoría cae a una lista conocida; **excepción `opencodego`**, cuyo `FALLBACK_MODELS` es vacío a propósito (los modelos dependen de la instancia) → la UI cae al campo de texto libre |
| BE-LLM-09 | Proveedor cuya SPA responde HTML 200 en `/models` | Detecta el content-type y responde con mensaje claro, no crashea |
| BE-LLM-10 | Merge de parámetros (`temperature`, `maxTokens`, `systemPrompt`): caller > BD > env > default | Prevalece el más específico |
| BE-LLM-11 | OpenCode Go: respuesta con partes `reasoning` y `text` | Sólo el `text` llega; el `reasoning` nunca se expone |
| BE-LLM-12 | OpenCode Go: `OPENCODEGO_AGENT` por defecto | Es `plan` (no `build`), no ejecuta herramientas sobre el server |
| BE-LLM-13 | `chat()` con proveedor **Claude** (alias `anthropic`) y key válida | Usa el SDK de Anthropic: separa el mensaje `system` del resto de los turnos, aplica `maxTokens` (default 1024) y `temperature` (default 0.7), y devuelve **sólo** las partes de tipo `text` de la respuesta (ignora las que no lo son). 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-14 | `chat()` con proveedor **Gemini** (alias `google`) y key válida | Gemini **no** tiene rol `system`: mapea `assistant`→`model` y todo lo demás (incluido `system`) a `user`, manda todos los turnos menos el último como `history` y el último con `sendMessage`. Verificar el borde de un historial que arranca con un `system` (queda como turno `user`) y dejar documentado cómo arma los turnos. 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-15 | `chat()` con proveedor **OpenRouter** y key válida | Usa el SDK de OpenAI contra `https://openrouter.ai/api/v1` (o la `baseUrl` configurada); formato OpenAI estándar (`temperature`/`maxTokens` con default 0.7/1024). 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
| BE-LLM-16 | `chat()` con proveedor **MiniMax** y key válida | Mismo camino OpenAI-compatible que OpenAI/OpenRouter, sólo cambia la base URL por defecto: `https://api.minimax.io/v1` (o la `baseUrl` configurada). 🔌 **Bloqueado (infra real):** requiere una API key real de un proveedor externo — el test queda como `skip` documentado |
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
valida el verify token; el POST publica en `whatsapp.incoming` **sin resolver la empresa** (eso
ahora lo hace el orquestador por la membresía del teléfono, ver §1.24).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-WHK-01 | GET de verificación con `hub.verify_token` correcto y `mode=subscribe` | Devuelve el `challenge` como cuerpo de la respuesta (Content-Type `text/html` por el default de Nest para un string) |
| BE-WHK-02 | GET de verificación con token incorrecto | 403 "verify_token inválido" |
| BE-WHK-03 | POST con un mensaje de texto | 200 `{ status: ok }`, publica `{ from: +<num>, body }` en `whatsapp.incoming` **sin `tenantId`** (la empresa se resuelve aguas abajo por membresía, §1.24) |
| BE-WHK-04 | POST con una respuesta interactiva (botón/lista) | Publica el `id` de la opción como `body` |
| BE-WHK-05 | POST con un tipo no soportado (imagen, audio) | Se ignora ese mensaje (warn), 200 igual |
| BE-WHK-06 | POST sin `messages` (ej. `statuses` de entrega) | 200 `{ status: ok }`, no genera nada |
| BE-WHK-08 | POST con `X-Hub-Signature-256` **ausente o inválida** | **Se rechaza** (401/403) antes de encolar: la firma se valida con el App Secret de Meta. ⚠️ Hoy se **procesa igual** sin validar firma (SEC-04): `❌` hasta validar `X-Hub-Signature-256` |
| BE-WHK-09 | POST con `X-Hub-Signature-256` **válida** | 200 `{ status: ok }`, publica en `whatsapp.incoming` (el camino legítimo sigue funcionando tras sumar la validación) |

> Los números **BE-WHK-07** y **BE-WHK-10** están libres a propósito: cubrían el ruteo por
> `WHATSAPP_TENANT_ID` y el respaldo a "la empresa más antigua", que se eliminaron al pasar al
> ruteo por membresía (§1.24). No se reutilizan, para que las referencias viejas no apunten a otra
> cosa.

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
| BE-EML-02 | Disparar un envío con host válido y credenciales correctas | El mensaje llega; el log deja constancia del destinatario y el asunto, nunca del cuerpo. 🔌 **Bloqueado (infra real):** requiere un servidor SMTP real vivo — el test queda como `skip` documentado |
| BE-EML-03 | **Login con segundo factor y un servidor de correo configurado pero caído** (host inalcanzable o credenciales inválidas) | **Debe** cortar con un error controlado ("no pudimos enviarte el código, probá de nuevo") y no dejar un código huérfano vivo. ⚠️ Hoy el fallo del envío **se propaga sin capturar**: el login devuelve 500 con el código ya guardado en memoria: `❌` hasta blindar el envío |
| BE-EML-04 | Mismo fallo del servidor de correo, pero durante una **notificación de transferencia a agente** dentro de una conversación | La conversación no se rompe: el usuario recibe respuesta igual y el fallo del aviso queda en el log. 🔌 **Bloqueado (infra real):** requiere un servidor SMTP real vivo — el test queda como `skip` documentado |
| BE-EML-05 | Envío **sin** remitente configurado | Usa el remitente por defecto del sistema, no falla por falta de `from` |
| BE-EML-06 | Puerto y "conexión segura" tomados de la configuración | Puerto 587 por defecto con conexión segura desactivada; con 465 y conexión segura activada también conecta. 🔌 **Bloqueado (infra real):** requiere un servidor SMTP real vivo — el test queda como `skip` documentado |
| BE-EML-07 | Host configurado **sin** usuario ni contraseña | Conecta sin autenticación (servidor interno de relay), no exige credenciales. 🔌 **Bloqueado (infra real):** requiere un servidor SMTP real vivo — el test queda como `skip` documentado |
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
| BE-DAT-06 | Aplicar la migración de backfill de `TenantFlowRole` sobre flujos de inicio preexistentes | Rellena `TenantFlowRole` para cada `TenantFlow` con `isStart=true` y **cero roles**, insertando una fila por cada `Role` del **mismo** tenant (`ON CONFLICT DO NOTHING`); no toca los que ya tienen roles cargados a mano ni cruza roles de otro tenant. Sin el backfill, los flujos de inicio ya configurados dejarían de servirse a cualquier usuario conocido |

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
| BE-TWA-10 | `POST webhooks/twilio` **sin** `X-Twilio-Signature` válida, con el guard configurado | ✅ **Se rechaza antes de encolar**: `TwilioSignatureGuard` valida el HMAC-SHA1 del auth token sobre la URL completa más los parámetros del body ordenados por clave. Cierra la parte de **SEC-16** que cubre el webhook de WhatsApp por Twilio — Gupshup (BE-GUP-06) sigue abierto. El detalle del guard y sus bordes, en BE-TWA-16/17 |
| BE-TWA-11 | Carrera: dos requests crean el mismo Content Template a la vez | `P2002` en `shapeHash` único; el que pierde usa el `ContentSid` **huérfano** que él creó (válido en Twilio, distinto del persistido en BD). Documentar la divergencia memoria-vs-BD y el template sin uso en la cuenta de Twilio |
| BE-TWA-12 | `POST webhooks/twilio` con `MediaUrl0..N` (imagen) | `TwilioMediaService` baja cada adjunto con `Authorization: Basic` (SID/token de `/settings`), auto-orienta por EXIF y redimensiona a ≤1920×1080 (`sharp`, solo jpeg/png/webp; gif/pdf sin resize) y publica el mensaje con `attachments` en `whatsapp.incoming`. Un mensaje solo-imagen (sin caption) ya no se descarta. Tope `MAX_MEDIA_ITEMS=10` |
| BE-TWA-13 | Media con URL falsa/404, sin credenciales, o cron de retención | URL no-2xx o sin credenciales → `warn` y se saltea ese adjunto (no rompe la charla); el `@Cron('*/2 …')` borra los temporales de más de 10 min sin consumir. Ni el SID ni el token se loguean |
| BE-TWA-14 | Adjunto de media **muy grande** (o muchos juntos) | **Debería** haber un tope de bytes en la descarga. ⚠️ Hoy `res.arrayBuffer()` carga el archivo entero en memoria y el único freno es el timeout de 20s (no chequea `Content-Length`): `❌` (robustez, sin número de hallazgo) |
| BE-TWA-15 | El webhook de Twilio publica en `whatsapp.incoming` **sin** `tenantId` | La empresa se resuelve aguas abajo por membresía (§1.24); se eliminó el ruteo por `*_TENANT_ID` + fallback al tenant más viejo |
| BE-TWA-16 | `TwilioSignatureGuard` en sus tres estados | Firma **válida** → pasa y encola. Firma **ausente o inválida** → rechazo, sin distinguir un caso del otro hacia afuera (nunca se le da al atacante una señal de "acá hay algo que validar"); la comparación usa `timingSafeEqual` y chequea el largo antes, para que una firma corta o larga a mano no lance. **Sin `TWILIO_AUTH_TOKEN` o `TWILIO_WEBHOOK_PUBLIC_URL` cargados, NO corta**: solo advierte en el log y deja pasar — deuda deliberada, para que un despliegue que todavía no cargó el setting no deje de recibir mensajes de un día para el otro. Ese despliegue queda tan expuesto como antes del guard |
| BE-TWA-17 | `TWILIO_WEBHOOK_PUBLIC_URL` cargada **con el path** del webhook (`https://miapp.com/webhooks/twilio`) en vez de solo protocolo + host | El path queda **duplicado** al armar la URL a firmar, la firma nunca matchea y se cortan **todos** los mensajes entrantes por Twilio. El único rastro es un "firma inválida" en el log, sin ninguna alerta: es un apagón silencioso del canal. La descripción del setting lo advierte expresamente — verificar que sigue siendo clara y probar el borde de la barra final |
| BE-TWA-18 | Cambiar las credenciales de Twilio (otra cuenta) con menús ya cacheados; y un `ContentSid` borrado desde la consola de Twilio | El `shapeHash` incluye el `accountSid`, así que una cuenta nueva **no matchea** las filas de la anterior y crea sus propios templates (las viejas quedan huérfanas, sin uso y sin molestar). Si igual llega un `21655` "Content was not found", se descarta la entrada muerta (memoria + BD) y se recrea el template **una sola vez**; un segundo fallo se propaga y degrada a texto (BE-TWA-08). Sin esto el caché quedaba envenenado para siempre |
| BE-TWA-19 | Menú o detalle cuyo texto trae `{{` / `}}` sin resolver (ej. un título de ticket con una variable de flujo que nunca se cargó) | Las llaves se sacan de los títulos de botón/fila y de la variable `{{1}}` del body **antes** de calcular el hash, crear el template y enviar, así los tres ven el mismo texto. `{{ }}` es sintaxis reservada de Twilio para **sus** variables en cualquier parte del template: sin este saneo, Twilio rechaza el envío con `21656` aunque la creación del template haya funcionado (caso real, 2026-08-31). Un body **multilínea** sí se manda tal cual: los saltos de línea no eran el problema |

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
| BE-GUP-06 | `POST webhooks/gupshup` sin ninguna verificación de autenticidad | **Debe** verificar que el POST viene de Gupshup. ⚠️ Hoy **acepta cualquier POST** (SEC-16): `❌`. Twilio ya cerró su parte (BE-TWA-10/16), así que Gupshup queda como la única puerta de entrada sin verificar — y es la que además dispara una descarga (BE-GUP-10) |
| BE-GUP-07 | Menú de tipo lista con `buttonText` | Reusa `buttonText` como header/título de la lista, sin equivalente real en el tipo interno `WhatsAppInteractive`; el propio comentario del código pide **confirmarlo contra tráfico real** antes de producción |
| BE-GUP-08 | `POST webhooks/gupshup` con un mensaje de tipo `image` (con y sin caption) | `GupshupMediaService` descarga la `url` del payload (pública, con expiración — no hace falta autenticarse, a diferencia de Twilio), la redimensiona a ≤1920×1080 y la guarda en el **mismo** directorio y con el mismo contrato que Twilio, así `flowState.pendingAttachments` y el motor funcionan igual con los dos proveedores. Publica con `attachments`; el `caption` viaja como `body` (`''` si no tiene, que **no** es lo mismo que `null` = tipo no soportado). Un mensaje solo-imagen sigue de largo, no se descarta. Si la URL ya venció, el adjunto se pierde best-effort y la charla sigue |
| BE-GUP-09 | `POST webhooks/gupshup` con `type:'message-event'` y con otros tipos de evento | De los eventos de entrega solo interesa `failed`: deja un `warn` con el destino y el motivo (ej. Error 131037, nombre para mostrar sin aprobar) y una línea en el log de archivo (§1.28) — es la única forma de enterarse de que WhatsApp no entregó la respuesta del bot. `enqueued`/`sent`/`delivered`/`read` y los eventos de plantilla, cuenta o facturación se descartan con 200, sin ruido |
| BE-GUP-10 | `POST webhooks/gupshup` con `type:'image'` y una `url` apuntando a la red interna (`http://127.0.0.1:…`, `http://169.254.169.254/…`) o a un archivo enorme | **Debería** validarse el destino y acotarse el tamaño. ⚠️ Hoy `GupshupMediaService` hace `fetch` a esa URL **tal cual**, sin lista blanca de host ni esquema y sin tope de bytes — y el webhook **no valida firma** (BE-GUP-06), así que la URL la controla quien mande el POST. La inconsistencia es lo que lo vuelve un defecto y no un límite de diseño: su hermano `TwilioMediaService` **sí** exige `https://api.twilio.com`. `❌` (seguridad, familia SEC-16; el tope de bytes es el mismo pendiente que BE-TWA-14) |

## 1.21 Canal SMS (Twilio y Gupshup) — canal propio

**Precondición:** SMS es un **canal independiente**, no un fallback de WhatsApp — y desde
2026-08-27 es **100% saliente**: avisos, no conversación bidireccional. Los dos webhooks de
entrada (`webhooks/twilio-sms` y `webhooks/gupshup-sms`) y la cola `sms.incoming` **se
eliminaron**; queda solo `sms.outgoing`. La `Conversation` con `channel:'sms'` sigue existiendo
para lo que sí corre por acá (el nodo `sms` del editor de flujos), así que un mismo usuario puede
tener charla por WhatsApp **y** registro por SMS. El proveedor lo decide `SMS_PROVIDER` (`twilio`
default / `gupshup`), leído al arrancar. Twilio **reusa** la cuenta de Twilio-WhatsApp
(`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`) y sólo cambia el número (`TWILIO_SMS_FROM`). Gupshup
usa la API de SMS (`GUPSHUP_API_KEY` compartida con WhatsApp + `GUPSHUP_SMS_APP_ID`); la cuenta
legacy "Enterprise SMS" quedó atrás. SMS **no** tiene interactivo: los menús se degradan a texto
numerado.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-SMS-01 | `handleMessage` con un mensaje `channel:'sms'` (hoy solo por `/simulate`) | Resuelve/crea la `Conversation` del canal `sms` (independiente de la de `whatsapp` del mismo usuario) y rutea la respuesta a `sms.outgoing` (`${channel}.outgoing`). El motor sigue siendo channel-aware aunque ya no entren mensajes por SMS desde afuera |
| BE-SMS-02 | `SMS_PROVIDER=twilio` | Sólo `TwilioSmsService` consume `sms.outgoing`; Gupshup inactivo |
| BE-SMS-03 | `SMS_PROVIDER=gupshup` | Sólo `GupshupSmsService` consume `sms.outgoing` |
| BE-SMS-04 | `POST webhooks/twilio-sms` y `POST webhooks/gupshup-sms` | **404: los dos controladores se eliminaron.** El canal es 100% saliente y no hay cola `sms.incoming`. Verificar que ninguna ruta de SMS entrante quedó publicada — era una puerta abierta sin firma (parte de SEC-16) que se cerró sacando la superficie entera, no agregándole un guard |
| BE-SMS-05 | Un `publish` manual a `sms.incoming` (cola histórica) | Nadie la consume: el mensaje se acumula sin efecto. Documentar que la cola ya no forma parte del pipeline |
| BE-SMS-06 | Menú del flujo enviado por **Twilio SMS** | Se degrada a texto numerado (`appendInteractiveAsText`), conservando el orden para que el índice tipeado matchee el `case 'menu'` |
| BE-SMS-07 | Menú del flujo enviado por **Gupshup SMS** | ⚠️ `GupshupSmsService` **descarta** el `interactive` (sólo manda el `body`): el usuario recibe "Elegí una opción:" **sin las opciones**. Con el canal 100% saliente el impacto bajó mucho (ya no hay respuesta que matchear por SMS), pero un aviso con opciones sigue saliendo mutilado. **Debe** anexar las opciones numeradas como Twilio SMS: `❌` hasta emparejarlo (robustez, sin número de hallazgo) |
| BE-SMS-08 | Twilio SMS reusando la cuenta de WhatsApp | Usa `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, saca el prefijo `whatsapp:` y envía desde `TWILIO_SMS_FROM` |
| BE-SMS-09 | Autenticidad de los webhooks de SMS | Ya no aplica: **no hay webhooks de SMS** (BE-SMS-04). Esta parte de SEC-16 se cierra por eliminación de la superficie. Lo que sigue abierto es Gupshup WhatsApp (BE-GUP-06) |
| BE-SMS-10 | Credenciales de Gupshup SMS en la request de salida | ✅ Ya **no** viajan en la query string de un `GET`: la API nueva usa `POST` con la API key en el header `Authorization` y los parámetros en el cuerpo. Cierra **SEC-21**, que era propio de la API legacy "Enterprise SMS" (`userid`/`password` en la URL, expuestos a los logs de cualquier proxy intermedio) |
| BE-SMS-11 | Nodo `sms` saliente a un número argentino guardado como `+549…` | El destinatario `To` pasa por `stripArgentinaMobileNine` (`+549 11…` → `+5411…`, el SMS por red celular no usa el 9); un número no argentino cae a `+${digits}` sin romper. El `From` sigue con `normalizeRecipient` |
| BE-SMS-12 | Media entrante por SMS (MMS) | Ya no aplica: sin webhook de entrada no hay MMS que procesar. La descarga y retención de media siguen vivas para WhatsApp (BE-TWA-12/13, BE-GUP-08) |
| BE-SMS-13 | Inspeccionar la request de salida de **Gupshup SMS** | Pega a `api.gupshup.io/sms/v1/message/{appId}` con la API key en el header `Authorization` — **no** al endpoint de WhatsApp (`/wa/api/v1/msg`, header `apikey`). Es la diferencia que ya rompió el canal: entre el 27/08 y el 31/08 pegaba al de WhatsApp con `channel:'sms'` en el cuerpo, Gupshup respondía `202 {"status":"submitted"}` —así que parecía andar— y **entregaba el mensaje por WhatsApp**. El `source` (sender ID) solo se manda si está configurado. ⚠️ Sin confirmar contra tráfico real, y la documentación de Gupshup no lista Argentina entre los destinos permitidos de esta API |
| BE-SMS-14 | `sendText` de Gupshup SMS sin `GUPSHUP_API_KEY` o sin `GUPSHUP_SMS_APP_ID` | Warn nombrando **el grupo de `/settings` de cada clave** (la API key vive en el grupo de WhatsApp y el App ID en el de SMS: son de pestañas distintas y es el error de carga esperable), no envía y **no** rompe el consumer. El intento queda en el log de archivo (§1.28), igual que los errores de red |

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
| BE-IG-10 | Corregir `INVGATE_API_USER` en `/settings` en caliente (técnico que al arranque no matcheaba) y crear un ticket | ✅ `resolveCreatorId` ya **no cachea el fallo**: solo guarda el `creatorId` cuando resolvió a un id real, así que corregir el usuario técnico en `/settings` vuelve a sincronizar sin reiniciar. Residual menor: los otros cachés de catálogo (`status`/`priority`/`type`/`category`) siguen sin invalidarse en caliente, pero no bloquean la creación de tickets |
| BE-IG-11 | `INVGATE_API_URL` con esquema `http://` | **Debe** exigirse HTTPS: con `http://` el Basic Auth viaja en **texto claro** por la red (SEC-20): `❌` |
| BE-IG-12 | Rama de catálogo con más de 4000 categorías bajo el `parent` | `listCategoriesByParent` corta a 4000 (20 páginas × 200) **sin avisar** → faltarían opciones sin error. Documentar el tope silencioso |
| BE-IG-13 | Script `pnpm --filter api invgate:check` (`invgate-check.mjs`) | Chequea conectividad y lista IDs reales del catálogo por consola (fuera de Nest); falla con mensaje claro si faltan credenciales o si la auth da 401. Acepta `--find-user <valor> --by phone\|username\|email` |
| BE-IG-14 | Crear/consultar ticket **end-to-end** contra InvGate real | Placeholder (ver BE-PH-01): el valor cargado como token resultó ser la contraseña de portal de un usuario; pendiente que el admin genere un token de API real |
| BE-IG-15 | `createIncident` cuando InvGate responde sin `id` ni `request_id` (o un body raro) | Tira error "InvGate no devolvió un id de incidente creado…"; `syncTicketToInvgate` lo atrapa y devuelve `null` → el `Ticket` local existe igual, y ya no se persiste `invgateId:"undefined"` |
| BE-IG-16 | `ticket_create` con adjuntos de imagen | Los adjuntos van a InvGate como `multipart/form-data` (campo `attachments[]`, timeout propio de 30s); si la subida falla, degrada a ticket sin adjunto sin cortar la charla |
| BE-IG-17 | Descripción/comentario con saltos de línea hacia InvGate | `toInvgateHtml` convierte `\r\n|\r|\n` → `<br>` (campos WYSIWYG de InvGate); el `Ticket.description` local sigue en texto plano |

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
| BE-SKL-11 | `GET /skills/all` (superusuario) y `GET /skills/mine` (usuario común) | Mismo criterio que BE-CS-20, espejo exacto: `all` con `SystemTenantGuard` trae las de todas las empresas vigentes con la suya en cada fila; `mine` trae las de las empresas donde el usuario tiene `skills:read`, sin `@RequirePermission`, y `[]` si en ninguna. Son los dos endpoints que alimentan la pestaña Skills en modo consolidado (FE-CS-12) |
| BE-SKL-08 | Un `Flow` compartido (`TenantFlow` N:N) entre la empresa **A** (dueña de la skill) y **B**; una charla del tenant **B** pasa por ese flujo | **No debe** filtrar: la skill de A no tendría que inyectarse en las conversaciones de B. ⚠️ Hoy `findById` carga `skill.promptText` **sin re-chequear el tenant en curso** → el texto de A entra en el prompt de B. A diferencia de la fuente de verdad (que falla-seguro por tenant), la skill **filtra en silencio** (SEC-17): `❌` |
| BE-SKL-09 | `POST`/`PATCH /flows` con un `skillId` de **otra** empresa | **Debe** rechazar (no pertenece al tenant activo). ⚠️ Hoy `FlowService.create/update` propagan `skillId` por spread **sin validar pertenencia**; la FK sólo valida existencia (SEC-17): `❌` |
| BE-SKL-10 | Marcar una Skill como `isActive:false` y usar un flujo vinculado a ella | **Debería** dejar de concatenarse. ⚠️ Hoy el motor **no chequea `isActive`** (`findById` ni lo trae): el texto se inyecta igual. El flag es letra muerta en el motor: `❌` (robustez, sin número de hallazgo) |

## 1.24 Ruteo de tenant entrante por membresía (`InboundTenantRoutingService`)

**Precondición:** el tenant que atiende un mensaje **entrante** ya no sale de configuración por
canal (`WHATSAPP_TENANT_ID` y hermanos + el fallback al tenant más viejo, **eliminados**), sino de
la **membresía del teléfono**. Los webhooks (§1.12, §1.19–1.21) publican el mensaje **sin
`tenantId`**; `ConversationsService.handleMessage` delega la resolución en
`InboundTenantRoutingService.resolve(from, channel, body)`. Un mensaje que llega **con** `tenantId`
explícito (p. ej. `/conversations/simulate`) saltea el ruteo y usa esa empresa.

Orden de decisión: pendiente de selección → **ninguna membresía** (se ignora: no hablamos con
desconocidos) → conversación **activa** en alguna empresa ruteable → 1 membresía (directo) / ≥2 (se
pregunta). El estado intermedio de la pregunta vive en `PendingTenantSelection` (por
teléfono+canal, expira a las 12h, guarda el texto **y los adjuntos** del mensaje original). En
WhatsApp el selector va como lista/botones interactivos; en SMS como texto numerado.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-ITR-01 | Teléfono miembro de **una sola** empresa | `resolve` → `{ resolved, tenantId }` de esa empresa, sin preguntar ni crear pendiente |
| BE-ITR-02 | Teléfono **sin ninguna** empresa (desconocido) | `resolve` → `{ ignored }`: **no** hay empresa de respaldo. No se crea `User` ni `Conversation` ni se gasta LLM; el intento queda en el log de archivo (§1.28). Por canal real es silencio total; por RPC (`/simulate` sin `tenantId`) se contesta un aviso para no colgar al llamador. Reemplaza al ruteo previo al tenant de sistema (pedido 2026-08-27) |
| BE-ITR-03 | Teléfono **multiempresa** | `resolve` → `{ ask }` con el selector; crea `PendingTenantSelection` con las opciones (ordenadas por antigüedad de la empresa) y el mensaje original |
| BE-ITR-04 | Responder el selector con el **número** de la empresa | `resolve` → `{ resolved, tenantId elegido, replayBody }` (reprocesa el mensaje original); borra el pendiente |
| BE-ITR-05 | Responder el selector con algo **inválido** | `resolve` → `{ ask }` otra vez, con el encabezado "No reconocí esa opción…"; conserva el pendiente y **le refresca la expiración** (12h desde el reintento, no desde la pregunta original) |
| BE-ITR-06 | Multiempresa con una **conversación activa** en una empresa | `resolve` → esa empresa (continúa la charla), sin volver a preguntar. Una charla **cerrada** ya no cuenta: el próximo mensaje vuelve a preguntar |
| BE-ITR-07 | Forma de la pregunta según canal y cantidad de empresas | WhatsApp con ≤3 empresas → **botones** (título recortado a 20); 4–10 → **lista** (recortado a 24, botón "Elegir empresa"); SMS —o más de 10 empresas— → texto numerado con "Respondé con el número" (SMS no tiene botones y el conector de Gupshup descarta el interactivo) |
| BE-ITR-08 | Responder el selector con el **nombre** de la empresa | Resuelve igual que con el número o el id: el match acepta el nombre completo y también el título **recortado** que muestran botones (20) y listas (24). Sin esto, tocar un botón en Twilio entraba en bucle — su webhook entrega el título visible, no el id (mismo criterio que el nodo `menu` con `opt.label`) |
| BE-ITR-09 | La empresa elegida fue **dada de baja** dentro de las 12h del pendiente | `resolve` → `{ notice }`: avisa que esa empresa ya no está disponible y borra el pendiente; el próximo mensaje re-rutea de cero. Antes el corte de baja lógica de `handleMessage` descartaba el mensaje original —texto y adjuntos— en silencio total |
| BE-ITR-10 | Conversación **activa** en una empresa que un cambio administrativo (membresía revocada o baja de la empresa) dejó fuera del ruteo | La conversación varada se **cierra** y se avisa (`notice`); no se abandona en silencio ni su respuesta a medias se inyecta como apertura del flujo de la empresa nueva. Si hay otra charla activa en una empresa **sí** ruteable, gana esa: la búsqueda filtra por membresía a nivel BD antes de mirar la más reciente |
| BE-ITR-11 | Dos mensajes casi simultáneos de un teléfono **multiempresa** sin pendiente previo | Queda **un solo** `PendingTenantSelection` (unique `[phone, channel]` + `createMany` con `skipDuplicates`): gana el primero y su `originalBody` se conserva; el segundo no lo pisa ni lanza. Antes era una transacción `Serializable` que ante ese choque tiraba sin reintentar y el mensaje se descartaba |
| BE-ITR-12 | El mensaje que dispara el selector traía **fotos**, y la persona responde **más de 10 minutos después** | El pendiente guarda `originalAttachments` y el replay reprocesa texto **y** adjuntos. ⚠️ Los archivos en disco los borra el cron de retención de media a los **10 min** (`RETENTION_MS`), pero el pendiente vive **12h**: respondiendo más tarde, `loadAttachments` no encuentra los archivos y las fotos se pierden **en silencio**. **Debería** avisar (o retener los adjuntos mientras viva el pendiente): `❌` (robustez, sin número de hallazgo) |
| BE-ITR-13 | Sondear el selector con teléfonos ajenos desde un webhook **sin firma** (Gupshup/Meta) o desde `/conversations/simulate` sin `tenantId` | **No debería** revelar nada de un remitente no verificado. ⚠️ Hoy el selector devuelve los **nombres** de todas las empresas del teléfono, así que quien alcance esas puertas puede enumerar dónde trabaja una persona a partir de su número: `❌` (privacidad, ligado a SEC-04/SEC-16) |

## 1.25 Calendario de feriados/guardias (`ScheduleCalendarService`)

**Precondición:** `ScheduleCalendarEntry` es **por empresa** (como `Area`/`ContextSource`): el
tenant sale siempre de `@CurrentTenant()`, nunca del body. `roleId` en `null` = aplica a **todos**
los roles de la empresa. Los tipos válidos (`feriado`, `guardia`) y las frecuencias de repetición
(`daily`/`weekly`/`monthly`/`yearly`) son catálogos cerrados en código, no enums de Prisma —mismo
criterio que `context-source-types.catalog.ts`—, y los comparte `FlowAlternative.type` (§1.26).
`startAt`/`endAt` son siempre la **primera** ocurrencia; cada repetición reusa esa misma duración
desplazada al ciclo que corresponda. Cadena estándar `@UseGuards(JwtAuthGuard, TenantGuard,
RolesGuard)` con `@RequirePermission('schedule-calendar', <acción>)`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-CAL-01 | ABM completo: `POST` con tipo/título/rango/rol, `GET` con filtros (`roleId`, `type`, `from`, `to`), `PATCH` y `DELETE` | 201/200 en cada uno; todo scopeado por el tenant activo y ordenado por `startAt` ascendente. Los filtros de fecha se cruzan (`endAt >= from`, `startAt <= to`), así que una entrada que abarca el rango sin empezar dentro también aparece |
| BE-CAL-02 | `type` o `recurrenceFreq` fuera del catálogo | 400 con la lista de valores válidos (`@IsIn` del DTO, mensaje armado desde el propio catálogo). Sumar un tipo nuevo al catálogo lo habilita sin migración de schema |
| BE-CAL-03 | Rangos inválidos: `endAt` ≤ `startAt`, o `recurrenceUntil` anterior a `startAt` | 400 "La fecha de fin debe ser posterior a la de inicio" / "La fecha «hasta» debe ser posterior al inicio" |
| BE-CAL-04 | `recurrenceUntil` **sin** `recurrenceFreq`, y desactivar la repetición en un `PATCH` | Sin frecuencia, el "hasta" se **descarta en silencio** (queda `null`), no se rechaza. Al apagar la repetición en un `PATCH`, `recurrenceUntil` se fuerza a `null` con ella: no queda un "hasta" huérfano. Con frecuencia y sin "hasta" = repite indefinidamente |
| BE-CAL-05 | `roleId` de **otra** empresa (o inexistente) | 400 "El rol … no existe o no pertenece a este tenant" (mismo criterio que `FlowService.applyTenantAssignment`) |
| BE-CAL-06 | `GET`/`PATCH`/`DELETE /schedule-calendar/:id` con el id de una entrada de **otra** empresa | 404 "La entrada de calendario no existe en este tenant": todas las operaciones por id pasan por `getOwned`, que filtra por `tenantId` además del id |
| BE-CAL-07 | `resolveStatus(tenant, rol, instante)` con entradas que compiten | Devuelve `'feriado'` si hay feriado, `'guardia'` si solo hay guardia, `null` si ninguna matchea; con las dos en el mismo instante **gana feriado**. Una entrada con `roleId:null` matchea cualquier rol consultado; una de **otro** rol no matchea; con `roleId` en `null` (usuario sin rol) solo matchean las de `roleId:null` |
| BE-CAL-08 | Repetición en las cuatro frecuencias | Semanal matchea el mismo día y horario de la semana siguiente pero **no** otro día de esa semana; diaria repite el mismo horario; mensual y anual, la misma fecha del ciclo siguiente. Un rango que cruza medianoche matchea la madrugada del día siguiente. `recurrenceUntil` corta: pasada esa fecha ya no matchea, aunque el ciclo siga cayendo |
| BE-CAL-09 | Repetición **mensual** anclada un día 29, 30 o 31 | Limitación conocida y asumida: la aritmética usa `Date.setMonth`, que ante un mes más corto **desborda al siguiente** (el 31/01 repetido mensual "cae" el 03/03 en un año no bisiesto). Documentar el borde; no es `❌` porque el MVP lo asume explícitamente |
| BE-CAL-10 | `POST /schedule-calendar/import-ar-holidays/:year` | Trae los feriados de ese año de la API pública de argentinadatos.com y crea una entrada por feriado: `type:'feriado'`, `allDay:true`, `roleId:null` y `source:'ar_holidays_import'`. Las fechas se anclan en **-03:00**, no en UTC: con "Z" la medianoche real caía 3hs antes en hora local y el feriado se veía **partido en dos días** |
| BE-CAL-11 | Reimportar el mismo año, y `DELETE …/import-ar-holidays/:year` | Reimportar **reemplaza limpio**: borra el import anterior de ese año antes de crear el nuevo, así un segundo intento no duplica. El `DELETE` borra en bloque solo las entradas con `source:'ar_holidays_import'` de ese año — las cargadas **a mano** quedan intactas (para eso existe la columna `source`) |
| BE-CAL-12 | La API externa falla: status no-2xx, sin red (timeout de 15s) o lista vacía | 400 con el motivo concreto en cada caso; **no se borra nada** de lo que ya había: el borrado del import anterior corre **después** del fetch exitoso, no antes |
| BE-CAL-13 | Año inválido en la ruta de import: `0`, `3000`, `abc` | 400 **sin** llamar a la API externa (`ParseIntPipe` para lo no numérico + `assertValidYear`, rango 1900–2100). Aplica igual al `DELETE` del import |
| BE-CAL-14 | Empresa con un calendario grande (varios años importados y entradas repetidas) recibiendo mensajes | `resolveStatus` corre al **arrancar cada conversación** y trae **todas** las entradas de (tenant, rol) sin filtro de fecha en el `WHERE` —no se puede: una entrada anual puede matchear hoy con `startAt` de años atrás— y filtra en memoria. Medir el costo por mensaje y dejarlo documentado; el volumen esperado es bajo, pero es el punto que hay que vigilar si el calendario crece |

## 1.26 Variantes de flujo por feriado/guardia (`FlowAlternative`)

**Precondición:** una variante es **otra fila `Flow` completa e independiente** (su propio
`nodes`/`edges`), vinculada al flujo Principal por `FlowAlternative` con el mismo catálogo de tipos
del calendario. **No** es un nodo del grafo ni tiene relación con el nodo `subflow` (ese es un
salto en vivo durante la charla; esto es una variante elegida **antes** de arrancar). La variante
nace sin `TenantFlow` ni `isDefault`: la tenencia vive en el flujo base. `findActiveFlowForTenant`
resuelve primero el Principal (§1.8) y recién después consulta el calendario.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-VAR-01 | `GET /flows/:id/variants` | Los tipos configurados para ese flujo como Principal, con su `variantFlowId` |
| BE-VAR-02 | `POST /flows/:id/variants` en sus **tres** orígenes | Sin opciones, duplica el grafo del Principal (default); con `sourceFlowId`, el de otro flujo cualquiera; con `blank:true`, arranca con el nodo `start` de un flujo nuevo. En los tres casos la fila nace `isActive:true`, `isDefault:false`, **sin empresas asignadas** y con nombre `"<base> (<tipo>)"` |
| BE-VAR-03 | Crear dos veces la variante del **mismo** tipo para el mismo flujo | 409 "Ya existe una variante de este tipo para este flujo" (unique `[baseFlowId, type]`) |
| BE-VAR-04 | `type` fuera del catálogo de tipos del calendario | 400 "Tipo de variante desconocido: …" — la misma lista que valida `ScheduleCalendarEntry.type` (§1.25) |
| BE-VAR-05 | `DELETE /flows/:id/variants/:type` | Borra la fila `Flow` variante (y con ella el `FlowAlternative`, por cascade); sin variante de ese tipo → 404 "No hay variante de ese tipo para este flujo" |
| BE-VAR-06 | `GET`/`POST`/`DELETE /flows/:id/variants` con el id de un flujo de **otra** empresa | 404 en los tres: pasan por `assertFlowAccessible` como el resto de las rutas `:id`. Antes no recibían el `userTenant` y con `flows:read`/`create` en la empresa propia se podían listar, crear y borrar variantes de un flujo ajeno — y la respuesta del `POST` devolvía sus `nodes`/`edges` copiados enteros |
| BE-VAR-07 | Crear una variante **propia** con un `sourceFlowId` de **otra** empresa | 404: el corte se aplica también al flujo de origen, no solo al base. Sin eso, el flujo base podía ser propio pero el grafo copiado, ajeno — lectura cruzada por la puerta de atrás |
| BE-VAR-08 | La fila `Flow` variante en listados y desplegables | **No** aparece en `GET /flows` ni en los dropdowns generales (nodo `subflow`, asignación de empresas): `findAll` filtra `variantOf: null`. Tampoco es elegible por `resolvePrincipalFlow`, porque nace sin `TenantFlow` y sin `isDefault`. Solo se llega a ella por `listAlternatives`/`findById` |
| BE-VAR-09 | `findActiveFlowForTenant` con y sin estado temporal | Sin feriado ni guardia (`resolveStatus` → `null`) devuelve el Principal **sin** consultar `FlowAlternative`. Con estado resuelto: variante **activa** → la variante; variante `isActive:false` o sin configurar para ese tipo → cae al Principal |
| BE-VAR-10 | Un feriado que **empieza a mitad** de una conversación en curso | La variante se elige **una sola vez, al iniciar** la charla — nunca se re-evalúa mientras la conversación sigue viva. Quien ya estaba conversando termina por el flujo con el que arrancó |
| BE-VAR-11 | Borrar el flujo **Principal** que tiene variantes | El cascade borra sus `FlowAlternative`, pero **no** las filas `Flow` variantes: quedan huérfanas. Peor, al perder su `FlowAlternative` dejan de estar excluidas por `variantOf: null` y **reaparecen** en `GET /flows/all` (vista del superusuario). **Debería** borrarlas junto con el base, como hace `deleteVariant`: `❌` (robustez, sin número de hallazgo) |

## 1.27 Métricas del panel de inicio (`MetricsService`)

**Precondición:** `GET /metrics/dashboard` alimenta las cuatro tarjetas del inicio (§3.3). Cadena
estándar con `@RequirePermission('metrics', 'read')`.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-MET-01 | `GET /metrics/dashboard` con `metrics:read` | `{ users, tenants, conversations, tickets }`. `users` cuenta las membresías de la empresa activa (excluyendo personas dadas de baja), `conversations` y `tickets` son de esa empresa; **`tenants` es global a propósito** — es un total del sistema, no expone datos de otras empresas |
| BE-MET-02 | Mismo endpoint parado en la empresa A, con datos sembrados también en B; y sin el permiso | Los tres conteos por empresa **no** incluyen nada de B, y las empresas dadas de baja no suman en `tenants`. Sin `metrics:read` → 403; sin `X-Tenant-Id` resoluble → el corte de `TenantGuard` (§1.3) |

## 1.28 Registros en disco (`GupshupFileLoggerService`, `UnknownSenderLogService`)

**Precondición:** dos registros en archivo, con el mismo esquema: un archivo por semana ISO en
formato JSON Lines, rotación automática al cambiar de semana y borrado de los viejos en cada
escritura. No viven en la BD a propósito.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| BE-LOG-01 | Actividad de Gupshup (webhook recibido, evento de entrega, envío saliente) | Se escribe una línea JSON en `logs/gupshup/gupshup-YYYY-Www.log`; al cambiar de semana empieza un archivo nuevo y los de más de **8 semanas** se borran solos. Un fallo de disco (permisos, disco lleno) **no** tira la request del webhook ni el envío: queda un `warn` y sigue |
| BE-LOG-02 | Mensaje rechazado por venir de un número no registrado (§1.24 BE-ITR-02 y §2.1) | Se registra en `logs/unknown-senders/unknown-YYYY-Www.log` con canal, teléfono y los primeros 200 caracteres del mensaje; retención de **4 semanas**. No queda **ninguna** fila en `User`, `Conversation` ni `Message`. El `tenantId` va solo cuando el rechazo ocurre dentro de una empresa ya resuelta (`/simulate` contra un tenant puntual) |
| BE-LOG-03 | Contenido de los dos archivos frente a datos sensibles | El log de Gupshup vuelca el **payload crudo** del webhook (`raw`), que incluye el texto de los mensajes de los usuarios y sus teléfonos, en claro y sin cifrar por 8 semanas; el de desconocidos guarda teléfono y un fragmento del mensaje por 4. Verificar que **ningún secreto** (API key, token de Twilio, credenciales de InvGate) caiga en ninguno de los dos, y evaluar si la retención es compatible con el tratamiento de datos personales del despliegue |

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
| CHAT-PIPE-01 | Primer mensaje de un número **registrado** (con membresía y rol en la empresa) | Crea la conversación y ejecuta el flujo. Ya **no** se crea ningún contacto placeholder: `findOrCreateByPhone` —que fabricaba un `User` con email `whatsapp-{tel}@local.pci` para cualquier número que escribiera— quedó eliminada (ver CHAT-PIPE-09) |
| CHAT-PIPE-02 | Mensaje dirigido a un tenant **dado de baja** (canal real) | Se ignora en silencio (`return ''`), sin crear usuario ni gastar LLM |
| CHAT-PIPE-03 | Mismo caso pero por `simulate` (con `replyTo`) | Responde un aviso, no cuelga al llamador |
| CHAT-PIPE-04 | Segundo mensaje dentro de la ventana de reanudación (12h) tras cerrar | Reabre la conversación cerrada, mantiene historial |
| CHAT-PIPE-05 | Mensaje tras vencer la ventana de reanudación | Crea una conversación nueva |
| CHAT-PIPE-06 | Se persiste el mensaje del usuario y luego el del asistente | Ambos quedan en `Message` con `senderType` correcto |
| CHAT-PIPE-07 | Dos mensajes del mismo teléfono, uno con `channel:'whatsapp'` y otro con `channel:'sms'` | Cada uno resuelve/crea **su propia** `Conversation` (una por canal), no se pisan; la respuesta de cada uno va a `${channel}.outgoing`. `handleMessage` es channel-aware (el resto del motor de flujos/LLM no sabe de canales) |
| CHAT-PIPE-08 | Mensaje entrante **sin** `channel` explícito | Default `whatsapp` (retrocompatible): resuelve la conversación de WhatsApp y rutea a `whatsapp.outgoing` |
| CHAT-PIPE-09 | Mensaje de un número **no registrado** en la empresa resuelta (no hablamos con desconocidos) | Se rechaza **antes de tocar la base**: no se crea `User`, no se abre `Conversation`, no se gasta LLM. Por canal real, silencio total; por RPC (`/simulate` con `tenantId`), un aviso para no colgar al llamador. El intento queda solo en el log de archivo (§1.28). Hay dos cortes con este mismo criterio: el de §1.24 (el teléfono no pertenece a **ninguna** empresa) y éste (no pertenece a **esta**) |
| CHAT-PIPE-10 | Turno silencioso: el flujo avanzó de nodo sin nada que mostrar (ej. `notification` en modo link cayendo a un `end` sin texto) | **No** se guarda un `Message` vacío ni se publica un WhatsApp en blanco. Por RPC sí se publica una respuesta vacía, porque `simulate` espera con `broker.request()` y sin ese publish la llamada quedaba colgada hasta el timeout de 5 min. Ojo con la distinción: "el flujo corrió y no tuvo nada que decir" (texto vacío) **no** es lo mismo que "no hay flujo activo" (`null`), que es lo que deriva al orquestador |
| CHAT-PIPE-11 | La resolución de empresa **lanza** (ej. un choque transitorio al registrar el pendiente del selector) | Se le avisa a la persona que reintente y se corta, en vez de descartar el mensaje en silencio; el aviso sale por la cola que corresponda (RPC o canal real). Es la red de seguridad de §1.24: cualquier falla del ruteo se convierte en una respuesta, no en un mensaje perdido |

## 2.2 Arranque de flujo por tenant y rol

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-START-01 | Usuario **conocido** cuyo rol tiene flujo de inicio | Arranca ese flujo |
| CHAT-START-02 | Usuario **desconocido** (sin membresía en esa empresa) | El mensaje **se rechaza antes** de llegar a ningún flujo (CHAT-PIPE-09): no hay "flujo del desconocido". La caída al `isDefault` global sigue existiendo para el caso legítimo de un usuario **conocido** cuyo rol no tiene flujo de inicio propio (CHAT-START-03) |
| CHAT-START-03 | Rol conocido sin flujo de inicio propio | Cae al default global |
| CHAT-START-04 | No hay flujo de inicio ni default activo | `executeFlow` devuelve `null` → responde el orquestador LLM |
| CHAT-START-05 | Mismo teléfono, conocido en el tenant A y desconocido en el B | En A arranca su flujo; en B el mensaje se rechaza (CHAT-PIPE-09). Por canal real ni siquiera se llega a B, porque el ruteo lo manda a la única empresa donde tiene membresía (§1.24); el escenario se ejercita con `/simulate` apuntando a B |
| CHAT-START-06 | Nodo `start` con `data.text` cargado, usando `{{variable}}` de la charla | El saludo sale de ahí, **interpolado** con las variables que el propio nodo acaba de sembrar (`{{userFirstName}}`, `{{userName}}`, `{{userRole}}`…). Sin `data.text` se mantiene el texto de siempre, así ningún flujo existente cambia de comportamiento al actualizar. El mismo texto sirve para las dos ramas a propósito: desde "no hablamos con desconocidos" la rama de desconocido no se ejecuta más (CHAT-START-02) y el campo, que antes era **solo** el saludo del desconocido, quedaba sin ningún efecto visible |
| CHAT-START-07 | Nodo `start` con el tilde **"No enviar saludo"** (`noGreeting`), y con `data.text` **vacío** | Con `noGreeting`, el nodo no manda **nada**: el flujo sigue de largo por su arista y el primer texto que ve la persona es el del nodo siguiente. Un `data.text` vacío **no** alcanza para eso, a propósito: ningún flujo tenía ese campo cargado cuando se volvió configurable, así que tomar "vacío" como "sin saludo" los habría dejado a todos mudos de golpe |
| CHAT-START-08 | Flujo cuyo rol y calendario resuelven a **feriado** o **guardia**, con la variante configurada | Arranca la **variante**, no el Principal (§1.26 BE-VAR-09). Sin variante para ese estado, o con la variante inactiva, arranca el Principal. La decisión se toma una sola vez, al iniciar la charla |

## 2.3 Nodos del motor — uno por uno

**Precondición:** flujos armados a propósito para aislar cada tipo de nodo. `data` = la
config del nodo en el editor.

### `start`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-START-01 | Entrada de un usuario conocido, con el nodo **sin configurar** | Saluda "¡Hola {nombre}! Bienvenido de nuevo."; siembra `userName/userEmail/userRole/userRoleId/userId/userPhone…` en el estado; enruta por el handle `known`. La identidad viene resuelta desde `handleMessage`, **no** se vuelve a consultar acá: repetir la consulta era el bug original (para entonces el placeholder ya existía y ningún número se detectaba como desconocido) |
| CHAT-N-START-02 | Rama `unknown` del nodo | Sigue existiendo como capacidad del motor, pero es **inalcanzable por canal**: un número sin membresía se rechaza antes (CHAT-PIPE-09). Verificar que el handle y su cableado no se rompieron, sabiendo que hoy ningún mensaje real la recorre |
| CHAT-N-START-03 | Conocido sin `firstName` cargado | Saluda sin romper (dejar registrado el saludo con espacio de más como cosmético) |
| CHAT-N-START-04 | `start` sin aristas `known`/`unknown` ni `*TargetNodeId` | Cae a la primera arista saliente |

El saludo configurable (`data.text` interpolado) y el tilde "No enviar saludo" se cubren en
**CHAT-START-06/07** (§2.2), donde viven sus pruebas.

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
| CHAT-N-MENU-15 | En modo `__llmFallback`, el usuario escribe **exactamente** una opción válida (número, label o value) o "Volver" | Limpia `__llmFallback`, sale del LLM libre y procesa la selección; si no coincide exacto, sigue en LLM libre. Antes quedaba atrapado en LLM aunque tipeara la opción correcta. El match es estricto (value/label/índice), no difuso |
| CHAT-N-MENU-16 | Elegir el botón "Volver" (id `__volver`) con una gestión abierta | **No** dispara el chequeo de cancelar/cerrar charla: `looksLikeCancelAttempt` excluye el id exacto `__volver` (antes matcheaba por `includes('volver')`). Escribir "volver" a mano sí evalúa cancelación (intencional) |

### `input`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-INP-01 | Primera llegada | Muestra la pregunta (`data.text`) y espera |
| CHAT-N-INP-02 | Respuesta con `data.variableName` seteado | Guarda el valor en el estado y avanza |
| CHAT-N-INP-03 | Respuesta sin `variableName` | Avanza sin guardar |
| CHAT-N-INP-04 | Respuesta que parece cancelación, confirmada por el LLM | Cancela la gestión (`cancelFlow`) |
| CHAT-N-INP-05 | Respuesta que parece cancelación pero el LLM dice continuar | Guarda el texto y avanza |

### `notification`

**Precondición:** texto más **un único** botón. Dos modos: `confirm` (default — al tocarlo, el
flujo sigue por la única arista de salida) y `link` (el botón abre una URL). No ramifica: acá no
hay nada que elegir, solo confirmar o desviarse. Cualquier otro mensaje lo toma el LLM, mismo
mecanismo de fallback que `menu` pero sin opciones.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-NOT-01 | Primera llegada en modo `confirm` | Muestra el texto con el botón (`data.buttonLabel`, "Continuar" por defecto) y espera. Sin interactivo disponible en el canal, cae a `texto\n\n[Etiqueta]` |
| CHAT-N-NOT-02 | La persona toca el botón (o responde `1`) | Avanza por la única arista de salida, sin ramificar |
| CHAT-N-NOT-03 | La persona responde otra cosa (una pregunta, por ejemplo) | Entra en **fallback LLM** (`__llmFallback`) y lo sigue atendiendo el modelo hasta que toque el botón —o mande una imagen, si corresponde—, en vez de insistir con el botón |
| CHAT-N-NOT-04 | Tilde **"Espera una foto"** (`expectsPhoto`) prendido y apagado, con la persona mandando una imagen | Prendido: la imagen **avanza igual que el botón** (no tiene sentido derivar al modelo a alguien que ya hizo lo que el nodo le pidió, ej. "Agregue sus fotos"); también saca del fallback si ya estaba en él. Apagado: la imagen cae al LLM como cualquier otro mensaje que no matchea. Los adjuntos ya los dejó `handleMessage` en `pendingAttachments` antes de llegar acá |
| CHAT-N-NOT-05 | Modo `link` con `buttonUrl` cargada | Manda el botón de tipo CTA con la URL y **frena** con `waitForInput`, aunque WhatsApp no avise cuándo se toca un botón de link. Sin ese freno, el encadenamiento seguía al próximo nodo en el mismo turno y ese nodo **pisaba** el interactivo (solo se manda el último de la cadena): el botón nunca llegaba a salir. El próximo mensaje, sea cual sea, avanza |
| CHAT-N-NOT-06 | Modo `link` **sin** `buttonUrl` | Se degrada a mensaje de texto plano en vez de mandar un botón roto, y sigue de largo |
| CHAT-N-NOT-07 | Modo `link` con una `buttonUrl` que trae `{{variable}}` | ⚠️ La URL **no se interpola** (a diferencia del nodo `webhook`, que sí): las llaves llegan crudas. Peor por Twilio, donde la URL viaja como variable de Content Template y el saneo de `{{ }}` (BE-TWA-19) alcanza al título del botón pero **no** a la URL, así que el envío puede rebotar con `21656`. **Debería** interpolarse como el resto de los campos de nodo: `❌` (robustez, sin número de hallazgo) |

### `condition`

**Precondición:** el formato **nuevo** es una única comparación contra una variable del estado
(incluidas las que siempre siembra `start`, como `userRole`), con **dos salidas fijas** por
`sourceHandle`: `true` / `false`. La lista vieja de `conditions` sigue funcionando para los flujos
que no tengan `compareVariable` cargado — es lo que cubren CHAT-N-CND-01..09.

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
| CHAT-N-CND-10 | Formato **nuevo**: `compareVariable` con cada uno de los cinco operadores (`equals`, `not_equals`, `contains`, `exists`, `not_exists`) | Sale por el handle `true` o `false` según el resultado. `contains` compara sin distinguir mayúsculas; `exists`/`not_exists` miran presencia real del valor (no `undefined`, no `null`, no cadena vacía) e ignoran `compareValue`. Tener `compareVariable` cargado es lo que activa este formato: sin él, se evalúa la lista vieja |
| CHAT-N-CND-11 | Nodo con **solo la rama afirmativa** cableada (la forma más común: "si es X, algo especial; si no, seguí de largo") y un resultado **falso** | El flujo **no** se va por la arista del `true`: sin arista para el handle declarado, nunca se cae a la de **otro** handle. Si tampoco hay una arista sin handle, no hay próximo nodo y el flujo se cierra ahí. Era un bug silencioso de alto impacto: el nodo hacía exactamente lo contrario de lo que declaraba |
| CHAT-N-CND-12 | Nodo con una arista **sin `sourceHandle`** | Esa arista sirve de salida por defecto para cualquiera de las dos ramas: es inequívoca, no pertenece a ninguna, y quien la dibujó quiso "seguir por acá pase lo que pase" |
| CHAT-N-CND-13 | `compareVariable` que nombra una variable **inexistente** en el estado, con `equals` y `compareValue` vacío | Da **true**: el valor ausente se normaliza a cadena vacía y coincide. Borde a documentar — "la variable no existe" y "la variable está vacía" son indistinguibles con `equals`; para separarlas hay que usar `exists`/`not_exists`. El nombre admite llaves (`{{sede}}` y `sede` son lo mismo) |

### `ticket_create` / `ticket_query`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-TKC-01 | `ticket_create` con subject/description de `data` o del estado | Crea el ticket con `userId`+`tenantId`, guarda `lastTicketId`, responde "Ticket #… creado" |
| CHAT-N-TKC-02 | `ticket_create` sin subject explícito | Usa los primeros 100 caracteres del mensaje |
| CHAT-N-TKC-03 | `ticket_create` tomando `priority` y `description` del nodo o del estado | `priority` = `data.priority` (o `medium` por defecto); `description` = `data.description` → `flowState.description` → mensaje, en ese orden |
| CHAT-N-TKC-04 | La creación del ticket falla (BD caída) dentro del nodo | `prisma.ticket.create` no está protegido: la excepción se propaga y hoy corta la charla. **Límite de robustez documentado, no `❌`** — y la diferencia con CHAT-N-LLM-04 (que sí es `❌`) es deliberada: aquél es `❌` porque sus nodos **hermanos** `menu`/`input` **sí** blindan la llamada al LLM y `llm_query` quedó inconsistente (defecto puntual con fix claro); acá, en cambio, **ningún** nodo blinda su I/O de BD — es un límite arquitectónico **uniforme** (familia SEC-15), no una inconsistencia entre hermanos. Si se blinda, hacerlo para todos los nodos con I/O de BD a la vez |
| CHAT-N-TKQ-01 | `ticket_query`, primera llegada: **lista** los tickets abiertos | Consulta InvGate **en vivo** (`incidents.by.customer`) y arma una lista interactiva con los abiertos del cliente, más recientes primero, tope de 10 filas por el límite de WhatsApp (con aviso "te muestro los 10 más recientes" si hay más). No usa la tabla local `Ticket`: solo tiene los que creó el bot y su estado cacheado puede estar viejo (no hay webhook de InvGate). Cada fila muestra la referencia y el título, con el estado como descripción |
| CHAT-N-TKQ-02 | `ticket_query` sin ningún ticket abierto | "No tenés tickets abiertos en este momento." y **sigue de largo**: no se queda esperando una opción que no existe |
| CHAT-N-TKQ-03 | `ticket_query` con una variable de ticket que apunta a un ticket de **otro tenant** | ✅ **No lo devuelve**: `ticket.findFirst` filtra por `tenantId` (match exacto por `id` **o** `invgateId`, sin coincidencia parcial) → "No encontré el ticket solicitado." Cierra **SEC-08** |
| CHAT-N-TKC-05 | `ticket_create` con `category`/`priority`/`ticketType` elegidos **por nombre** en el editor | Crea el `Ticket` local y lo sincroniza a InvGate **best-effort**; los nombres se resuelven contra el catálogo real (BE-IG-05). Si InvGate falla, el ticket local queda igual y la charla sigue (BE-IG-08) |
| CHAT-N-TKC-06 | `ticket_create` cuando el usuario final **no** matchea un `customer_id` de InvGate | El ticket **local** se crea igual; la sincronización a InvGate se saltea con `warn` (no corta la charla) |
| CHAT-N-TKQ-04 | `ticket_query` de un ticket **sincronizado** con InvGate | `refreshInvgateStatus` trae el estado real y lo traduce a nombre legible; si InvGate no responde, cae al estado local (best-effort) |
| CHAT-N-TKC-07 | Usuario manda una o varias imágenes y después dispara `ticket_create` | Los adjuntos se acumulan en `flowState.pendingAttachments` al llegar (un mensaje solo-imagen guarda el placeholder `[N imagen(es) adjunta(s)]`) y se consumen al crear el ticket (se leen y borran del disco); viajan a InvGate. Sin ticket, el cron de retención los limpia a los 10 min |
| CHAT-N-TKQ-05 | `lastTicketId` y el identificador que consulta `ticket_query` | Al sincronizar, `lastTicketId` pasa a ser el **número real de InvGate** (cae al cuid local si InvGate falla); `ticket_query` acepta cualquiera de los dos (`OR:[{id},{invgateId}]`, scopeado por tenant) y muestra `#${invgateId ?? id}` |
| CHAT-N-TKQ-06 | Elegir un ticket de la lista: **detalle** | Trae el incidente en vivo (con comentarios) y arma el texto con referencia y título, estado, prioridad, fecha de creación, agente asignado ("sin asignar" si no tiene) y el **último comentario**, más un botón "Volver a la lista". Muestra el último comentario y no la descripción original a propósito: la descripción la escribió la propia persona, lo útil es la última novedad |
| CHAT-N-TKQ-07 | El ticket tiene comentarios **internos** (no visibles para el cliente) mezclados con los visibles | Solo se muestra el último **visible para el cliente**: un comentario interno es una nota privada del equipo y nunca debe llegarle a quien consulta. Sin ningún comentario visible → "Sin comentarios aún.". Ante una forma inesperada de los comentarios devuelve "sin comentarios" en vez de romper el detalle (la forma está relevada contra documentación, no contra tráfico real) |
| CHAT-N-TKQ-08 | Tocar "Volver a la lista", y volver a entrar al nodo **más tarde** | "Volver" reusa la **misma** lista ya armada (cacheada en el estado), no reconsulta InvGate: por Twilio la lista viaja como Content Template cacheado por la forma exacta —incluidos los ids de cada fila—, así que reconstruirla, aunque diera igual, podría armar un hash distinto y forzar un template nuevo (lento, y justo el que a veces no llega a renderizar). Al **salir** del nodo el caché se descarta, así una visita posterior sí trae los tickets al día. Cualquier respuesta que no sea "Volver" sigue de largo por la arista, como `input` |
| CHAT-N-TKQ-09 | Tipear a mano el id de un incidente que **no le pertenece** a quien pregunta | Se trata como "no encontrado": el detalle compara el cliente del incidente contra el de quien consulta antes de mostrar nada. Vuelve a la lista con "No reconocí esa opción. ". Sin ese chequeo, cualquiera podría ver el ticket de otra persona adivinando un id bajo — el `body` es texto libre, no solo el id de una fila que se le mostró |
| CHAT-N-TKQ-10 | InvGate **sin configurar**, o el usuario final sin `customer_id` que matchee | Mensaje claro ("No pude vincular tu usuario con InvGate para buscar tus tickets. Contactá a un administrador."), limpia el estado del nodo y sigue de largo; no se queda esperando ni rompe la charla. Si InvGate falla al listar, se degrada a "sin tickets abiertos" con un `warn` |
| CHAT-N-TKQ-11 | El último comentario viene con HTML de InvGate y entidades **numéricas** (`&#xA0;`, `&#160;`) | Se convierte a texto plano en **una sola pasada**: `<br>`/`</p>` a saltos de línea, etiquetas fuera, y las entidades —con nombre y numéricas, decimales y hexadecimales— a su carácter. Los espacios duros pasan a espacio común. Un `&amp;nbsp;` queda como el texto literal "&nbsp;", **no** como un espacio: encadenar un reemplazo por entidad lo decodificaba de más. Una entidad desconocida se deja tal cual, que es más honesto que comerse el contenido |

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
| CHAT-N-TRF-08 | `transfer_agent` con un assignee **dado de baja** en la rotación | `pickNextAssignee` filtra `deletedAt:null` y rota solo sobre los activos: el dado de baja nunca recibe. Si **ninguno** queda activo, devuelve `null` sin romper el flujo |

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
| CHAT-N-SMS-04 | Nodo `sms` con un `recipientId` que apunta a un usuario de **otra** empresa | ✅ **No le manda nada**: la búsqueda de destinatarios filtra por membresía en la empresa de la conversación (y excluye empresas dadas de baja), mismo criterio que el reparto de agentes de `transfer_agent`. Importa porque `data.recipients` es config del nodo y un flujo compartido entre empresas puede traer gente de todas ellas: sin el filtro, la charla de un cliente de una empresa terminaba mandando un SMS con su nombre y su nota a alguien de otra. Cierra **SEC-18** |

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
| CHAT-N-LLM-08 | `llm_query` con `extractVariables` y el dato **ya dicho** en la charla | Un solo llamado al LLM (temperature 0) extrae el valor, lo valida contra `allowedValues` sin distinguir mayúsculas, guarda el valor **canónico** del catálogo (no el texto crudo del modelo) y **no** pregunta |
| CHAT-N-LLM-09 | `llm_query` en modo extracción con una variable **ausente** | Se detiene y pregunta (`waitForInput`, reusa `__awaiting`), lleva la cuenta en `__llmQueryAttempts`; con la respuesta resuelve y avanza |
| CHAT-N-LLM-10 | El usuario se niega (`REFUSED`) o agota `maxAttempts` (default 2) | La variable queda en `'no definido'` y el nodo **avanza igual**; **no** inventa un valor ni entra en loop infinito de preguntas. `REFUSED` corta de una, sin esperar a agotar los intentos |
| CHAT-N-LLM-13 | Salida del nodo en modo extracción, con `foundTargetNodeId`/`missingTargetNodeId` cargados en el flujo | **Una sola salida**, siempre por la arista dibujada en el canvas: tanto "todas resueltas" como "alguna quedó en no definido" siguen el mismo camino, y quien necesite ramificar pone un nodo `condition` después. Los dos campos de destino se **ignoran** a propósito —eran texto libre en el editor y un id con un error de tipeo mandaba el flujo a un nodo inexistente, que el motor reseteaba en silencio— y sobreviven en el DTO solo para que los flujos viejos que los tengan guardados pasen la validación al re-guardarse. Un nodo de extracción **sin** arista de salida deja un `WARN` explícito |
| CHAT-N-LLM-11 | Respuesta fuera de `allowedValues` (un valor no listado) | No matchea → `NONE` → vuelve a preguntar; nunca guarda un valor arbitrario |
| CHAT-N-LLM-12 | `llm_query` conversacional con `data.temperature` seteado vs. ausente | Con valor, se pasa al `chat`; ausente, respeta la cascada de `/settings` (el spread condicional evita pisar el default con `undefined`). La extracción/clasificación corre siempre a temperature 0 |

### `delay` / `variable` / `webhook` / `subflow`

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-N-DLY-01 | `delay` con `seconds` dentro del tope | Espera ese tiempo y sigue |
| CHAT-N-DLY-02 | `delay` con `seconds` mayor a 10 | Se acota a 10s (no cuelga la request) |
| CHAT-N-VAR-01 | `variable` con `action:set` y `name` | Guarda `data.value` (o el mensaje) en el estado |
| CHAT-N-VAR-02 | `variable` con `action` distinto de `set` | No hace nada, avanza |
| CHAT-N-VAR-03 | `variable` con `action:set` pero **sin** `name` | No guarda nada (la condición exige `name`); avanza igual. Borde de configuración incompleta |
| CHAT-N-WHK-01 | Nodo `webhook` con URL configurada | Hace la llamada **real** y sigue de largo sin decir nada: es "dispará y olvidate", no interrumpe la conversación con la persona. La URL se interpola con las variables de la charla. Dejó de ser un simulacro ("Acción webhook ejecutada (stub)") |
| CHAT-N-WHK-02 | Nodo `webhook` **sin** URL configurada | Deja un `warn` y avanza; no llama a nada ni rompe el flujo |
| CHAT-N-WHK-03 | Método y cuerpo, y el servicio de destino caído | Con `POST`/`PATCH`/etc. manda el `body` interpolado con `Content-Type: application/json`; con `GET` no manda cuerpo. Tiene tiempo máximo de espera propio. Una respuesta no-2xx se loguea con el status y los primeros 200 caracteres; un error de red se loguea y **el flujo sigue igual**: un webhook caído (una alerta a un chat externo, por ejemplo) no debe trabar el bot |
| CHAT-N-WHK-04 | `data.url` apuntando a la **red interna** (`http://127.0.0.1:…`, `http://169.254.169.254/…`, `http://10.x`) o con un esquema raro (`file:`) | **Debería** validarse el destino: lista blanca de esquemas, bloqueo de direcciones privadas y del servicio de metadatos de la nube. ⚠️ Hoy la llamada sale sin ninguna restricción, y como el `body` se interpola con las variables de la charla, un nodo mal intencionado —o un flujo importado— puede además **exfiltrar** lo que la persona contó. Alcanza con `flows:update` para configurarlo: `❌` (seguridad, sin número de hallazgo). Es exactamente el riesgo que CHAT-PH-03 anticipaba para cuando el nodo se implementara |
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
`active` sin ningún `Message` en la última hora, reseteando flujo/nodo/estado. La conversación
queda **retomable** por 12h. Los dos tiempos son **configurables** desde `/settings > Otros`
(`CONVERSATION_INACTIVITY_MINUTES`, `CONVERSATION_RESUME_WINDOW_HOURS`, ver BE-SET-21): los valores
de 1h y 12h son los defaults, no constantes fijas. Son ventanas **encadenadas y distintas**:
primero la charla se cierra sola, después queda un rato retomable.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| CHAT-IDLE-01 | Conversación `active` sin mensajes en la última hora | El cron la cierra (`status:closed`, `closedAt`) y resetea `currentFlowId`/`currentNodeId`/`flowState` |
| CHAT-IDLE-02 | Conversación `active` con un mensaje dentro de la última hora | No se cierra (el filtro es por `Message` reciente, no por `updatedAt` de la fila) |
| CHAT-IDLE-03 | Mensaje nuevo tras el autocierre, **dentro** de las 12h | Reabre la **misma** conversación con el flujo reseteado (arranca de nuevo sin perder el historial de `Message`). `sessionStartedAt` se resetea, así el LLM no recibe como contexto lo dicho antes del cierre |
| CHAT-IDLE-04 | Mensaje nuevo tras el autocierre, **pasadas** las 12h | Arranca una conversación nueva |
| CHAT-IDLE-05 | Fijar `CONVERSATION_INACTIVITY_MINUTES` a un valor distinto de 60 | Manda sobre el default: el cron cierra según ese valor. Como el chequeo corre cada 10 minutos, el cierre real cae entre el valor configurado y 10 minutos más — verificar que el margen se documenta y no se lee como un error |
| CHAT-IDLE-06 | Fijar `CONVERSATION_RESUME_WINDOW_HOURS` a un valor distinto de 12 | Manda sobre el default para decidir si el próximo mensaje retoma la charla cerrada o abre una nueva. Ojo con la desalineación deliberada: el pendiente del selector de empresa (§1.24) sigue con **12h fijas**, así que bajar esta ventana no acorta aquél |

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
| CHAT-PH-03 | ~~Nodo `webhook` llamando a un servicio externo~~ | ✅ **Implementado** (CHAT-N-WHK-01/03). Lo que quedó pendiente es justo lo que este placeholder anticipaba: la validación del destino, que hoy no existe — ver CHAT-N-WHK-04 |
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

> Esta sección incluye además los hallazgos de la **auditoría de cambio de empresa en el sidebar**
> (usuarios multiempresa, 2026-08-21): el manejo del modo consolidado "Todas las empresas", la
> reactividad de las pantallas y del selector del sidebar al cambiar de empresa, y la coherencia de
> los avisos de permiso. Están repartidos en §3.1, §3.4, §3.6, §3.9 y §3.10, marcados `❌` cuando
> describen el comportamiento deseado que hoy falta.

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
| FE-INF-13 | **Superadmin recorriendo el selector de empresas:** sistema → una empresa común → otra empresa común → "🌐 Todas las empresas" | ✅ El menú muestra **siempre las mismas 8 opciones**, incluidas "Tenants" y "Configuración": el sidebar arma el menú del superadmin sin filtrar por empresa (`isSuperAdmin ? menuDefinition : filtrado`), así que el selector cambia **qué datos se ven**, nunca **qué opciones existen**. Entrar a esas dos pantallas parado en una empresa común funciona (ver BE-MT-12) |
| FE-INF-14 | Cualquier respuesta de una request autenticada trae `X-Access-Token` | `apiFetch` lee el header y **pisa** `localStorage.token`; la próxima request ya usa el token nuevo (sesión deslizante del lado cliente, ver BE-AUTH-26). No toca el estado de React. Con actividad continua la sesión ya no se cae a los 15 min |
| FE-INF-15 | Un **401 con token presente** en cualquier request del panel | `apiFetch` llama a `clearSession()` (única fuente de qué keys de `localStorage` borra) y redirige a `/login` de inmediato — antes la UI mostraba datos viejos o fallaba en silencio hasta recargar a mano. Un 401 de login/OTP (sin `Authorization`) **no** cae acá |
| FE-INF-16 | Parado en **Tenants** o **Configuración** (pantallas solo-sistema), cambiar el selector del sidebar a una empresa **no-sistema** | ✅ **Redirige al dashboard** en vez de dejar una URL huérfana fuera del menú. El sidebar decide el destino antes de cambiar de empresa y navega ahí (navegar también recarga, así que la resolución por header sigue igual). La comparación normaliza la barra final, porque con `trailingSlash` la ruta puede llegar con una de más y el match exacto contra el menú fallaba |
| FE-INF-17 | En modo consolidado, comparar el **selector de empresas del sidebar** con el filtro **"Empresa:" de la página** (ej. Usuarios) | El sidebar lista **todas** las empresas; el filtro de la página lista **sólo** las que tienen filas en ese listado, así que una empresa sin filas (ej. una recién creada, 0 usuarios) aparece en el sidebar pero **no** en el filtro. **No es un bug:** decisión de diseño aceptable (no tiene sentido filtrar hacia una empresa sin filas que mostrar); se documenta sólo porque genera una diferencia visible entre los dos selectores |
| FE-INF-18 | Un **miembro común** del tenant de sistema (rol distinto de SuperAdmin) recorre el panel | **No** ve el menú completo ni la opción "🌐 Todas las empresas" global: el sidebar distingue `isSystemMember` de `isSuperAdmin` (`user.isSuperAdmin` lo calcula el backend en `/auth/me`), y `useAuth` ya no hereda el rol de sistema a un no-superadmin. Regresión de privilegio que separa "pertenecer al tenant de sistema" de "ser superusuario" |
| FE-INF-19 | Build estático (`output:'export'` + `trailingSlash`) y navegación del panel | Las rutas se emiten como `carpeta/index.html`; los `router.push` llevan barra final y el editor de flujos viaja por query (`/dashboard/flows/edit/?id=…`, antes `/flows/[id]`, que el export no soporta sin `generateStaticParams`). Verificar que no queden links rotos ni redirects de más |

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
| FE-DASH-01 | Entrar a `/dashboard` con sesión | Muestra las cuatro tarjetas de resumen (Usuarios, Tenants, Conversaciones, Tickets) con los conteos de `GET /metrics/dashboard`. El "—" es sólo el estado inicial mientras la respuesta está en camino, y el valor al que cae si la llamada falla |
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
| FE-USR-15 | Abrir "Nuevo usuario" y cancelar (Escape o click afuera) **sin tocar nada** | **No debería** avisar de cambios sin guardar (no se editó nada). ⚠️ Hoy salta igual el confirm "Tenés cambios sin guardar. ¿Descartarlos?" porque el modal **pre-agrega la empresa activa** como membresía (`presetTenantId`) y eso ya cuenta como "cambio" en la comparación. Menor: `❌` hasta que el preset no dispare el aviso (complementa FE-USR-13, el confirm legítimo cuando sí hubo cambios) |
| FE-USR-16 | Alta de usuarios con un rol que tiene `users:read` + `users:create` pero **sin** `roles:read` (rol `Alta sin roles`, ver Apéndice C) | ✅ **El alta se completa**: `GET /roles` acepta `users:create` como permiso alternativo (BE-RBAC-25), así que el desplegable **Rol** se llena y "Crear" se habilita. Ese rol recibe id y nombre de cada rol, **no** su matriz de permisos (BE-RBAC-26): se destrabó el alta sin abrirle el diseño de permisos de la empresa |
| FE-USR-17 | Botón "Importar desde Excel" → modal de 3 pasos (subir → mapear → resultado) | Parsea `.xlsx/.xls/.csv` en el navegador (primera hoja, primera fila = headers), mapea columnas a campos (requeridos Nombre/Apellido/Email), postea a `/users/bulk-import` con el `X-Tenant-Id` activo y muestra creados (con contraseña temporal, botón "Descargar CSV") y fallidos con fila+motivo |
| FE-USR-18 | El botón "Importar desde Excel" en modo "Todas las empresas" | No aparece (solo con `canCreate` y parado en una empresa puntual); el modal tampoco monta en consolidado |
| FE-USR-19 | Subir un archivo no soportado / vacío / sin filas, o con más de 10.000 filas | Mensaje de error en el modal, no avanza / no postea (corte cliente `MAX_ROWS=10000`, además del `@ArrayMaxSize` del backend) |
| FE-USR-20 | Mapeo de columnas con headers vacíos o repetidos | Las columnas sin header se renombran "Columna N"; el mapeo es por índice (una columna a un solo campo); sin los 3 requeridos no deja importar |
| FE-USR-21 | Filtros de la tabla: **nombre**, **apellido** y **rol** | Filtran en vivo sobre lo ya cargado, sin distinguir mayúsculas y combinables entre sí; el desplegable de rol se arma con los roles **presentes en el listado**, no con el catálogo entero. El botón de limpiar aparece solo si hay algún filtro puesto. En modo consolidado se suma el filtro por empresa que ya existía (FE-USR-11) |
| FE-USR-22 | **Paginado** de a 20, y su interacción con los filtros | La tabla pagina de a 20 con su navegación; cambiar cualquier filtro **vuelve a la página 1**, y si un filtro deja la página actual fuera de rango se muestra la última válida en vez de una tabla vacía. Es paginado del lado del cliente: la API sigue trayendo el listado completo — anotarlo por si el volumen crece |

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
| FE-TEN-06 | Crear una empresa desde Tenants y mirar el **selector de empresas del sidebar** | ✅ La empresa nueva aparece **de inmediato** en el selector, sin recargar: la pantalla de Tenants emite un evento de ventana tras cada cambio y el sidebar vuelve a traer la lista. Antes el selector cacheaba la lista al montar y quedaba con la versión vieja |
| FE-TEN-07 | **Renombrar**, dar de **baja** o **restaurar** una empresa y mirar el selector del sidebar | ✅ Igual que FE-TEN-06: los cuatro disparadores (alta, renombre, baja y restauración) refrescan el selector. El caso sigue valiendo por separado para verificar que el evento se emite en **todos** los caminos, no solo en el alta |

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
| FE-SET-10 | Falta `SETTINGS_ENCRYPTION_KEY` en el entorno | Banner rojo con el comando para generarla; guardar un secreto lo **rechaza el backend** (la UI muestra el banner pero no deshabilita el botón "Guardar"). 🔌 **Bloqueado (infra real):** requiere el backend levantado **sin** `SETTINGS_ENCRYPTION_KEY` (el stack efímero la hereda de `apps/api/.env`) — el test queda como `skip` documentado |
| FE-SET-11 | Guardar la key/host de un proveedor | Tras guardar, el dropdown de modelos se refresca solo |
| FE-SET-12 | Elegir "Otro — escribir a mano" en el dropdown de modelos | Cambia a un input de texto libre; un valor guardado fuera del catálogo se conserva marcado "(actual)" |
| FE-SET-13 | Botón "Cancelar" de un setting con cambios | Revierte el draft al valor efectivo, sin llamar al backend |
| FE-SET-14 | Pestañas nuevas: Mensajería WhatsApp (Twilio) / (Gupshup), Mensajería SMS (Twilio) / (Gupshup), Integración InvGate | Aparecen los grupos con sus campos; los secretos (🔒 `TWILIO_AUTH_TOKEN`, `GUPSHUP_API_KEY`, `GUPSHUP_SMS_PASSWORD`, `INVGATE_API_KEY`) arrancan vacíos con enmascarado. El layout pasó a grid de 2 columnas (sacó `max-w-4xl`) para acomodar tantos grupos |
| FE-SET-15 | Selectores de proveedor `WHATSAPP_PROVIDER` / `SMS_PROVIDER` | Dropdown con los valores del enum. ⚠️ Su descripción aclara que el cambio **requiere reiniciar el backend** (a diferencia del texto general de `/settings` que promete "sin reiniciar") — anotar la excepción |
| FE-SET-16 | Pestañas de `/settings` agrupadas por tema | Jerarquía de 3 niveles (Seguridad, LLM, Mensajería con sub-temas WhatsApp/SMS y proveedores Twilio/Gupshup, Integraciones) navegable por flechas (WAI-ARIA); un grupo del catálogo no mapeado cae en la pestaña "Otros", no desaparece (rama con una sub-pestaña por grupo suelto); el punto de estado (activo/incompleto) se propaga a las ramas. ⚠️ Hoy "Otros" aparece con el catálogo real: los grupos `Simulación` (habilitar el simulador de conversaciones) y `Otros` (minutos de inactividad y ventana para retomar la charla) no están mapeados en la jerarquía del frontend. No rompe nada —para eso está la rama defensiva—, pero esas opciones quedan en el cajón de sastre en vez de su sección |
| FE-SET-17 | Tipear en varias filas con drafts sin guardar y guardar una | Solo se resetea el draft de la fila guardada (mergea esa fila y refresca el estado de proveedores con `refreshStatus`), **sin pisar** lo tipeado en las demás — antes un `load()` completo borraba todos los drafts |

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
| FE-CS-11 | Fuentes de verdad en modo consolidado (**Todas las empresas / Todas mis empresas**) | ✅ **Consolida** como Usuarios/Áreas/Roles: trae las fuentes de todas las empresas (`/context-sources/all` para el superusuario, `/mine` para el común) y suma la columna **Empresa**. Es **solo lectura**: el alta se esconde y un aviso pide elegir una empresa puntual en el selector. Se terminó el alta a ciegas en una empresa de respaldo sin avisar en cuál |
| FE-CS-12 | La pestaña **Skills** de esta pantalla en el mismo modo consolidado | ✅ Mismo tratamiento que FE-CS-11 (`/skills/all` y `/skills/mine`): el arreglo abarca **las dos pestañas**. El caso queda separado para verificar que ninguna se dejó atrás |

## 3.10 Flujos IVR — listado y editor (`/dashboard/flows`, `/dashboard/flows/edit?id=…`)

**Precondición:** el listado usa `/flows/all` (superadmin) o `/flows` (común). El editor es
`@xyflow/react` (ReactFlow). La barra de asignación de empresas/roles sólo aparece si el usuario
puede listar todas las empresas.

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-FLW-01 | Listado de flujos | Tarjetas con nombre, badges "Default"/"Inactivo", chips de empresas o "Sin empresas" |
| FE-FLW-02 | Botones "Nuevo/Editar/Default/Eliminar" | Según `flows:create/update/delete` |
| FE-FLW-03 | Marcar un flujo como "Default" | `POST /flows/:id/default`; se refleja en la tarjeta |
| FE-FLW-04 | Abrir el editor de un flujo nuevo (`/new`) | Crea un nodo `start` por defecto; canvas listo |
| FE-FLW-05 | Arrastrar un tipo de la paleta al canvas | ⏭️ **Excluido** (gesto de canvas difícil de automatizar, aporta poco valor): usa drag-and-drop nativo de HTML5. Crea el nodo con su `data` por defecto en la posición soltada |
| FE-FLW-06 | Conectar dos nodos (arrastrar de un handle a otro) | ⏭️ **Excluido** (gesto de canvas difícil de automatizar, aporta poco valor): drag preciso entre handles SVG. Crea la arista; `start` tiene dos salidas (`known`/`unknown`), `menu` una por opción |
| FE-FLW-07 | Borrar una arista | ⏭️ **Excluido** (gesto de canvas difícil de automatizar, aporta poco valor): hover exacto sobre un `<path>` SVG para revelar el ×. Botón × al pasar el mouse (no al click); la arista desaparece del estado (usa `deleteElements`) |
| FE-FLW-08 | Seleccionar un nodo | El panel derecho muestra los campos propios de su tipo (texto, opciones, `variableName`, `systemPrompt`, etc.) |
| FE-FLW-09 | Nodo `transfer_agent` | Métodos email/ticket (phone deshabilitado), asignados con orden (round robin), observadores y colaboradores |
| FE-FLW-10 | Header: Contexto y "Fuente de verdad" | El dropdown de fuente lista las `ContextSource` activas del tenant; se vincula al flujo |
| FE-FLW-11 | Modal "Empresas y roles" | Acordeón por empresa con checkboxes de roles; aviso ámbar si una empresa queda con 0 roles |
| FE-FLW-12 | Checkbox "Inicio" | Deshabilitado sin empresas; marca el flujo de inicio por (empresa+rol) |
| FE-FLW-13 | Guardar un flujo nuevo vs. existente | Nuevo: `POST /flows`. Existente: `PATCH /flows/:id` + `POST /flows/:id/assign-tenants` |
| FE-FLW-14 | Guardar sin empresas asignadas | Pide confirmación ("quedará sin empresas") |
| FE-FLW-15 | Payload de guardado | Sólo `{id,type,position,data}` de nodos y los campos declarados de aristas (limpia `measured`/`selected`/`dragging` de ReactFlow, así el backend no rechaza con 400) |
| FE-FLW-16 | Borrar el nodo/arista seleccionado con Backspace/Delete | ⏭️ **Excluido** (gesto de canvas difícil de automatizar, aporta poco valor): depende de selección previa y foco del canvas. Se elimina del canvas (`deleteKeyCode`) |
| FE-FLW-17 | Reordenar asignados con ↑/↓ en `transfer_agent` | Cambia el orden del round robin; se persiste en el `data` del nodo al guardar |
| FE-FLW-18 | Header del editor: selector de **Skill** | Reemplaza al dropdown viejo "context"; lista `GET /skills` (filtra `isActive`) y vincula la Skill al flujo (`skillId`); "sin skill" desvincula |
| FE-FLW-19 | Nodo **SMS** (verde) en la paleta | ⏭️ **Excluido** (gesto de canvas difícil de automatizar, aporta poco valor): hereda el drag nativo de la paleta (ver FE-FLW-05). Se arrastra al canvas; su panel tiene `message` + selector de **destinatarios** (usuarios del tenant, mismo criterio que `transfer_agent`, no números a mano) |
| FE-FLW-20 | Nodo **Generar Ticket** (`ticket_create`) con catálogo InvGate | `category`/`priority`/`ticketType` como dropdowns poblados desde `GET /invgate/catalog/*`; si el catálogo no cargó, **caen a input de texto libre**; más el campo descripción. La tarjeta del nodo muestra categoría y tipo |
| FE-FLW-21 | Nodo `llm_query`: toggle `systemPromptMode` | "reemplaza" / "agrega" respecto del prompt base del flujo (ver CHAT-N-LLM-06) |
| FE-FLW-22 | Dentro del editor de un flujo (`/dashboard/flows/edit?id=…`), cambiar la empresa en el selector del sidebar | ✅ **Saca del editor y vuelve al listado** de flujos, en vez de dejar el flujo de una empresa abierto con los desplegables de otra. Y aunque alguien reconstruya ese estado mezclado a mano, el backend ya no lo acepta: el saneo de referencias cruzadas descarta lo que no pertenezca a una empresa válida (BE-FLW-25) y las rutas por id cortan por pertenencia (BE-FLW-14) |
| FE-FLW-23 | Abrir un flujo (o "Nuevo Flujo") en "Todas las empresas" y revisar los dropdowns **Skill**, **Fuente de verdad**, **Sub-flujo** y los pickers de usuario de *Transferir Agente* | **Deberían** poblarse según la empresa **del flujo**, no la empresa **activa**. ⚠️ Hoy se pueblan con la empresa activa (o la traducida en consolidado): abrir un flujo de `tenant1` en "Todas las empresas" deja "Fuente de verdad" **vacío** aunque `tenant1` tenga fuente. Riesgo de integridad: una fuente/skill ya asignada se ve como "Sin fuente" y **puede borrarse al guardar**, y permite cruzar datos de una empresa a un flujo de otra. Complemento de FE-FLW-22 (aquél es la no-redirección; éste, el **contenido** cruzado de los dropdowns): `❌` |
| FE-FLW-24 | Abrir cualquier flujo en el editor **con InvGate sin configurar**, y mirar la red/consola | ✅ Los tres catálogos (`priorities`, `types`, `categories`) responden **200 con lista vacía**, no 500: cada uno corta antes de armar la URL cuando falta la base o las credenciales. Antes, sin configurar, se terminaba construyendo una URL inválida y el error subía como 500 crudo en cada apertura del editor — la UI degradaba bien (el nodo Generar Ticket cae a texto libre, FE-FLW-20) pero ensuciaba consola y logs con un error que no era tal |
| FE-FLW-25 | Entrar a `/dashboard/flows` con un usuario **sin** `flows:read` (ej. el rol `Sin permisos`, por URL directa) | **Debería** mostrar "Permiso denegado: flows:read", como las pantallas hermanas (Áreas, Roles, Usuarios y Fuentes de verdad ante su propio 403). ⚠️ Hoy `GET /flows` da **403** y la pantalla muestra "No hay flujos configurados." —el `catch` sólo hace `console.error` y deja la lista vacía, sin estado de error—, así que el usuario **no distingue** "empresa sin flujos" de "no tengo acceso". Flujos es la **única** de su clase que oculta el 403: `❌` hasta igualar el aviso de las hermanas (misma postura que FE-SEC-05) |
| FE-FLW-26 | Botón "Duplicar" un flujo | `GET /flows/:id` + `POST /flows` con `name+" (copia)"`, nodos/aristas/`contextSourceId`/`skillId`; redirige al editor del nuevo (nace sin empresas asignadas). Gateado por `flows:create` |
| FE-FLW-27 | Botón "Exportar" | Descarga un `.flow.json` (`name/description/nodes/edges/contextSourceId/skillId`); gateado por `flows:read` |
| FE-FLW-28 | Botón "Importar" un `.flow.json` | Valida superficialmente (`name` presente, `nodes`/`edges` arrays) y hace `POST /flows`; un JSON sin esos campos → alert de formato inválido, no llama a la API. Gateado por `flows:create` |
| FE-FLW-29 | Importar en la empresa B un `.flow.json` exportado de A (o editado) con ids embebidos (`contextSourceId`/`skillId`/`userId` de assignees/recipients, `flowId` de un `subflow`) | `POST /flows` sanea esos ids contra la empresa destino: `contextSourceId`/`skillId` ajenos quedan en `null`, los `userId` que no son miembros de una empresa válida se filtran, y el `flowId` de un `subflow` se borra sólo si es claramente ajeno (un subflujo global se respeta). El conjunto válido es la empresa activa más las que asigne el propio payload. **El SuperAdmin queda exceptuado a propósito**: administra el sistema entero y puede vincular recursos de cualquier empresa, así que el caso se ejecuta con un usuario común de la empresa destino — que es donde la protección actúa: `✅` |
| FE-FLW-30 | Pestañas **Principal / Guardia / Feriado** del editor | El canvas carga el flujo de la pestaña activa y guarda contra **ese** flujo (Principal usa el id de la URL; las variantes, el suyo propio). Al abrir el editor se traen las variantes ya configuradas; cambiar de pestaña con una variante existente carga su grafo, no el del Principal |
| FE-FLW-31 | Elegir una pestaña de variante que **todavía no existe** | Abre el modal de creación con los tres orígenes del grafo inicial: duplicar el Principal (opción por defecto), copiar otro flujo (con selector) o empezar en blanco. Al confirmar, `POST /flows/:id/variants` y el canvas pasa a la variante nueva (§1.26 BE-VAR-02) |
| FE-FLW-32 | Botón **"Copiar flujo…"**, disponible solo en las pestañas de variante | Reemplaza el grafo del canvas por el de otro flujo, **sin** crear una variante nueva ni tocar nombre y descripción — sirve para resincronizar una variante existente contra otro flujo. Verificar que en la pestaña Principal no aparece |
| FE-FLW-33 | Paneles de los nodos nuevos y rediseñados | **Notificación**: texto, etiqueta del botón, modo confirmar/link (con el campo URL solo en link) y el tilde "Espera una foto" solo en confirmar. **Condición**: variable, operador y valor, con el valor oculto para "existe"/"no existe", y la tarjeta del nodo mostrando la comparación con **dos salidas** rotuladas. **Webhook**: método, URL y cuerpo JSON (el cuerpo desaparece con `GET`). **Inicio**: saludo con `{{variable}}` y el tilde "No enviar saludo", que deshabilita el campo de texto |
| FE-FLW-34 | Los flujos **variante** en el listado y en los desplegables del editor | No aparecen en `/dashboard/flows` ni en el selector de sub-flujo ni en el de "copiar flujo": se llega a ellos solo por las pestañas de su flujo base (§1.26 BE-VAR-08). Es lo que evita que alguien asigne empresas o marque como inicio una variante por error |

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

## 3.13 Calendario de feriados/guardias (`/dashboard/schedule-calendar`)

**Precondición:** pantalla de calendario por empresa, con vistas de mes, semana y día. El ítem del
menú aparece con `schedule-calendar:read` (§1.2). Las entradas son las de §1.25 y alimentan la
elección de flujo alternativo (§1.26).

| ID | Escenario | Resultado esperado |
|----|-----------|--------------------|
| FE-CAL-01 | Entrar a la pantalla y recorrer las vistas mes / semana / día | Muestra las entradas de la empresa activa en la grilla, navegables por período. Los feriados (día completo) van en la franja de arriba; las guardias con horario, en la grilla horaria |
| FE-CAL-02 | Una guardia que **cruza la medianoche** (ej. 20:00 a 08:00) en la vista de semana o día | Se dibuja como dos tramos, uno hasta medianoche y otro desde, cada uno en su columna y en su horario real. La grilla horaria no puede pintar una barra que cruce columnas, así que sin partirla el evento se iba entero al renglón de "todo el día". Los feriados **no** se parten: una entrada de varios días se ve como una sola barra continua arriba |
| FE-CAL-03 | Alta desde el modal: tipo, título, rol, rango y "todo el día" | Crea la entrada y aparece en la grilla. El selector de rol ofrece los roles de la empresa e incluye la opción "todos los roles"; el tipo sale del catálogo (`GET /schedule-calendar/types`), no de una lista escrita a mano en el frontend |
| FE-CAL-04 | Repetición en el modal: frecuencia y "hasta" (indefinido o con fecha) | Con frecuencia elegida se habilita el "hasta", con sus dos modos; sin frecuencia el "hasta" no aplica. Las ocurrencias repetidas se dibujan en la grilla del período que se esté mirando, con el mismo criterio que usa el backend para resolverlas (§1.25 BE-CAL-08) |
| FE-CAL-05 | Editar y borrar una entrada existente | Abre el modal con los valores cargados, guarda con `PATCH` y borra con confirmación; la grilla se actualiza |
| FE-CAL-06 | Importar los feriados de un año y **deshacer** ese import | El botón de importar pide el año y muestra cuántos se crearon; el de deshacer borra el import de ese año **sin tocar** las entradas cargadas a mano (§1.25 BE-CAL-11). Los errores de la API externa se muestran en pantalla, no en la consola |
| FE-CAL-07 | La pantalla con un rol **sin** los permisos de calendario | Sin `schedule-calendar:read` el ítem no está en el menú y entrar por URL directa muestra el estado de sin acceso. Sin `create`/`update`/`delete`, los botones correspondientes no se ofrecen — y forzar la request igual la rechaza el backend (misma postura que FE-SEC-01) |

---

# 🔒 Apéndice A — Auditoría de seguridad

Hallazgos sobre el código **actual**, verificados contra la fuente. Descritos por su
contenido e impacto (sin referencias de archivo/línea, según lo acordado). Cada uno tiene un
ID para referenciarlo desde los casos de arriba (ver "Trazabilidad rápida" al final).

**Resumen:** la base de autorización multitenant/RBAC y el cifrado de secretos están bien
resueltos. El foco principal sigue siendo un **bypass de 2FA por fuerza bruta** y la **ausencia de
rate limiting**, que es lo que lo vuelve práctico.

**Qué se cerró en esta actualización:** el aislamiento de flujos entre empresas (**SEC-03**, salvo
la ruta de "marcar por defecto" — BE-FLW-22), la firma del webhook de **Twilio** (parte de
**SEC-16**), el nodo `sms` cruzando empresas (**SEC-18**), las credenciales de Gupshup SMS
viajando en la URL (**SEC-21**, por reemplazo de la API) y la autenticación de
`/conversations/simulate` (**SEC-02**, mitigado: exige login y queda cerrado en producción, aunque
el tenant sigue viniendo del cuerpo, ahora a propósito). Los webhooks de **SMS** dejaron de existir,
así que esa parte de SEC-16 se cierra por eliminación de la superficie.

**Qué queda abierto de esa familia:** los webhooks de **Meta** (SEC-04) y **Gupshup** (SEC-16) no
verifican nada — y el de Gupshup, además, dispara una descarga contra una URL que controla quien
manda el POST (BE-GUP-10). Se suman dos focos nuevos del rango: el **nodo `webhook`** llama a
cualquier destino sin restricción, con el cuerpo interpolado con datos de la charla
(CHAT-N-WHK-04), y el **selector de empresa** revela a qué empresas pertenece un teléfono ante un
remitente no verificado (BE-ITR-13). También sigue **la Skill de una empresa filtrándose a otra en
un flujo compartido** (SEC-17).

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

### SEC-02 — `/conversations/simulate` sin autenticación y con el tenant en el body — 🟡 **mitigado**
- **Qué pasaba:** el endpoint que inyecta mensajes al orquestador no tenía ningún guard y
  cualquiera con acceso de red podía inyectar mensajes como si fueran de cualquier teléfono en
  cualquier empresa: crear conversaciones, invocar al LLM (costo monetario) y llegar a crear
  tickets o transferencias.
- **Qué cambió:** ahora exige **login** (`JwtAuthGuard`) y, además, el endpoint entero queda
  **cerrado por defecto en producción** (`CONVERSATIONS_SIMULATE_ENABLED`, BE-SET-22): responde
  404, no 403 — no debería ni figurar como existente. Con el ruteo por membresía, sin el guard un
  anónimo podía además enumerar a qué empresas pertenece un teléfono (BE-ITR-13).
- **Qué queda:** el tenant sigue viniendo del cuerpo y el cuerpo sigue sin ser un DTO. Es
  **deliberado**: `tenantId` es opcional a propósito, porque probar el ruteo por membresía exige
  no fijar empresa. Es autenticación, no autorización: cualquier persona logueada puede simular
  cualquier tenant o teléfono. Se acepta porque el cierre en producción es el control real.

### SEC-03 — Fuga entre empresas en la gestión de flujos (IDOR) — 🟡 **casi cerrado**
- **Qué pasaba:** los endpoints de un flujo por id (ver, editar, borrar, asignar empresas, marcar
  por defecto) exigían el permiso `flows:*` pero no filtraban por empresa. Un administrador de
  cualquier empresa podía pasar el id de un flujo ajeno y leerlo, reescribir su lógica, borrarlo o
  reasignarlo.
- **Qué cambió:** ver, editar, borrar, asignar empresas y las tres rutas de variantes pasan por un
  corte de pertenencia y devuelven **404** (no 403, para no filtrar que el id existe en otra
  empresa). El scope lo pone la **membresía** del usuario, no la empresa activa del header, así que
  sigue funcionando abrir un flujo de otra de sus empresas. Se suma la validación de las empresas
  **destino** al asignar (BE-FLW-23) y el saneo de referencias cruzadas al crear o editar
  (BE-FLW-25). El SuperAdmin queda exceptuado a propósito.
- **Qué queda:** `POST /flows/:id/default` **nunca recibió el corte** (BE-FLW-22). Es la peor de
  las cinco en impacto: `isDefault` es un fallback **global del sistema entero**, así que con un
  permiso de nivel empresa se cambia el flujo por defecto de todo el despliegue, y se puede
  promover uno ajeno.
- **Sugerencia:** gatearla con el candado de tenant de sistema, no solo con pertenencia.

### SEC-04 — El webhook de WhatsApp (POST) no verifica la firma de Meta
- **Qué pasa:** el handshake GET valida el verify token, pero el POST de mensajes no valida
  ninguna firma con el App Secret de Meta.
- **Cómo se explota:** quien conozca la URL del webhook publica mensajes falsos con cualquier
  remitente; el sistema los rutea por la membresía de ese teléfono y los procesa como reales.
- **Impacto:** suplantación de usuarios por la puerta pública, avance de flujos y gasto de
  LLM. Mismo efecto que SEC-02 pero desde el webhook. Con el ruteo por membresía se agrega la
  enumeración de empresas por teléfono (BE-ITR-13).
- **Sugerencia:** validar `X-Hub-Signature-256` con el App Secret antes de encolar el mensaje.
  Twilio ya tiene su equivalente resuelto (SEC-16): el mismo patrón aplica acá.

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

### SEC-08 — Fuga entre empresas al consultar un ticket en el flujo (`ticket_query`) — ✅ RESUELTO
- **Qué pasaba:** el nodo que consulta un ticket lo buscaba por id **sin filtrar por la empresa**.
  Si el flujo alimenta el id desde una variable que llenó el usuario, este podía pasar el id
  de un ticket de otra empresa y recibir su asunto y estado.
- **Impacto:** lectura de datos de tickets de otros tenants.
- **✅ Resuelto:** `ticket_query` usa ahora `ticket.findFirst({ where: { tenantId, OR: [{ id }, { invgateId }] } })`
  — match exacto por `id` o número de InvGate, scopeado por empresa, sin coincidencia parcial.
  Verificado en CHAT-N-TKQ-03.

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

### SEC-16 — Los webhooks de canal no verifican firma ni autenticidad (🟠 Alto) — 🟡 **parcialmente cerrado**
- **Qué pasaba:** los cuatro webhooks —`POST webhooks/twilio`, `webhooks/gupshup`,
  `webhooks/twilio-sms`, `webhooks/gupshup-sms`— aceptaban cualquier `POST` sin validar firma ni
  origen. Quien conociera la URL publicaba mensajes falsos con cualquier remitente y el sistema los
  procesaba como reales.
- **Qué se cerró:** **Twilio WhatsApp** ahora valida `X-Twilio-Signature` (HMAC-SHA1 del auth token
  sobre la URL completa más los parámetros ordenados) antes de encolar, con comparación en tiempo
  constante (BE-TWA-10/16). Los **dos webhooks de SMS se eliminaron**: el canal quedó 100% saliente,
  así que esa superficie no existe más (BE-SMS-04).
- **Qué queda:** **Gupshup WhatsApp** sigue sin ninguna verificación (BE-GUP-06), y es la peor de
  las que quedan porque además dispara una **descarga** contra una URL que viaja en el propio
  payload, sin validar host ni tamaño (BE-GUP-10). Dos salvedades del lado de Twilio: el guard **no
  corta** si falta `TWILIO_AUTH_TOKEN` o `TWILIO_WEBHOOK_PUBLIC_URL` —solo advierte, para no dejar
  un despliegue sin recibir mensajes de un día para el otro—, así que un despliegue sin esa carga
  queda igual de expuesto; y cargar mal esa URL (con el path incluido) corta **todos** los
  entrantes con un simple "firma inválida" en el log (BE-TWA-17).
- **Sugerencia:** para Gupshup, un secreto compartido o una lista blanca de IP, y validar el destino
  de la descarga de media. Convendría además no procesar en un webhook cuyo proveedor no está activo.

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

### SEC-18 — El nodo `sms` no scopea los destinatarios por empresa (🟡 Medio) — ✅ **cerrado**
- **Qué pasaba:** el nodo `sms` resolvía los destinatarios sin filtrar por empresa. El editor solo
  ofrece usuarios del tenant, pero el id viaja en el `data` del flujo y no se re-validaba en
  ejecución: un flujo compartido o manipulado con un `recipientId` de otra empresa hacía que el bot
  le mandara un SMS a alguien de ese otro tenant, confirmando además que ese teléfono existe.
- **Qué cambió:** la búsqueda de destinatarios exige membresía en la empresa de la conversación y
  excluye empresas dadas de baja, mismo criterio que ya usaba el reparto rotativo de agentes de
  `transfer_agent`. Cubierto por CHAT-N-SMS-04.

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

### SEC-21 — Gupshup SMS legacy manda usuario y contraseña en la query string (🟢 Bajo) — ✅ **cerrado**
- **Qué pasaba:** el conector de SMS por Gupshup usaba la API legacy "Enterprise SMS", que recibe
  `userid` y `password` como parámetros de la **query string** de un `GET`. TLS los cubre en
  tránsito, pero la URL completa puede quedar registrada en los logs de cualquier proxy o pasarela
  intermedia.
- **Qué cambió:** esa API se reemplazó por la API de SMS de Gupshup, que usa `POST` con la API key
  en el header `Authorization` y los parámetros en el cuerpo. Las claves `GUPSHUP_SMS_USERID` y
  `GUPSHUP_SMS_PASSWORD` dejaron de existir. Cubierto por BE-SMS-10/13.
- **Nota:** se cerró como efecto de un cambio funcional (la cuenta legacy estaba rota del lado de
  Gupshup), no por una corrección deliberada de seguridad — vale igual, pero conviene saberlo.

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
- SEC-08 → CHAT-N-TKQ-03 ✅ (cerrado: `ticket_query` scopeado por `tenantId`)
- SEC-09 → CHAT-N-CND-06
- SEC-10 → BE-AUTH-21
- SEC-11 → CHAT-LLMF-03
- SEC-12 → BE-SEC-03
- SEC-13 → BE-AUTH-18
- SEC-14 → BE-AUTH-22
- SEC-15 → CHAT-N-SUB-03
- SEC-16 → BE-TWA-10 ✅ + BE-SMS-09 ✅ (por eliminación) + BE-GUP-06 ❌ (webhooks de canal sin
  validar firma); bordes del guard de Twilio en BE-TWA-16/17, descarga sin validar en BE-GUP-10
- SEC-17 → BE-SKL-08 + BE-SKL-09 (fuga de la Skill entre empresas en un flujo compartido)
- SEC-18 → CHAT-N-SMS-04 ✅ (cerrado: destinatarios del nodo `sms` filtrados por empresa)
- SEC-19 → BE-AUTH-28 (sesión deslizante sin techo, revocación ni chequeo de deshabilitado)
- SEC-20 → BE-IG-11 (InvGate sin HTTPS)
- SEC-21 → BE-SMS-10 ✅ (cerrado: la API nueva manda las credenciales por header, no en la URL)

Los **21 hallazgos** quedan con caso de aceptación propio; ninguno depende ya sólo de cobertura
indirecta.

**Estado al día de hoy:** cerrados del todo **SEC-08**, **SEC-18** y **SEC-21**. Parcialmente
cerrados **SEC-02** (mitigado: exige login y queda cerrado en producción), **SEC-03** (solo queda
`POST /flows/:id/default`, BE-FLW-22) y **SEC-16** (queda Gupshup WhatsApp). Los demás siguen
abiertos.

**Riesgos nuevos sin número de hallazgo**, surgidos de funcionalidad de este rango — se anotan acá
para que no queden sueltos aunque no tengan `SEC-*` propio:

- Nodo `webhook` sin restricción de destino, con el cuerpo interpolado → **CHAT-N-WHK-04**
- Descarga de media de Gupshup sin validar host ni tamaño → **BE-GUP-10** (familia SEC-16)
- Enumeración de empresas por teléfono a través del selector → **BE-ITR-13** (ligado a SEC-04/16)
- `POST /flows/:id/default` sin candado, cambia un default global → **BE-FLW-22** (resto de SEC-03)
- Datos personales en los registros en disco, sin cifrar → **BE-LOG-03**

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
| context-sources | GET `/` · `/all` · `/:id` · `/types` · POST `/:id/test-connection` | POST `/` | PATCH `/:id` | DELETE `/:id` |
| schedule-calendar | GET `/` · `/:id` · `/types` | POST `/` · `/import-ar-holidays/:year` | PATCH `/:id` | DELETE `/:id` · `/import-ar-holidays/:year` |
| metrics | GET `/dashboard` | — | — | — |
| devices · conversations · tickets · channels · llm | — | — | — | — |

Notas:

- **Sin endpoint protegido aún:** `devices`, `conversations`, `tickets`, `channels`, `llm` están
  en el catálogo (para repartir el permiso antes de proteger sus módulos), pero ninguna operación
  los exige hoy. `metrics` salió de esa lista: ya protege `GET /metrics/dashboard` (§1.27).
- **Permisos alternativos (`RequireAnyPermission`, semántica "o"):** `GET /roles` acepta
  `roles:read` **o** `users:create` — alcanza con uno. El detalle de permisos de cada rol solo
  viaja para el primero (BE-RBAC-25/26). Es la única celda de esta matriz con más de un permiso
  posible.
- **Candado extra `SystemTenantGuard`** (además del permiso RBAC): `users/all`, `areas/all`,
  `areas/by-tenant/:id`, **todo** el CRUD de `tenants`, `roles/all`, `roles/by-tenant/:id`,
  `flows/all`, `context-sources/all`, `skills/all`, y **todo** `settings` (a nivel clase). El
  negativo es "desde un tenant que no es el de sistema → 403" (BE-TEN-03, BE-ARE-04/08,
  BE-RBAC-10, BE-SET-02).
- **Sin `@RequirePermission`** (autorización por-empresa dentro del servicio): `users/mine`,
  `users/multi`, `users/:id/full`, `users/check-availability`, `users/:id/memberships`,
  `areas/mine`, `roles/mine`, `flows/mine`, `context-sources/mine`, `skills/mine`; y `auth/me`
  (sólo `JwtAuthGuard`). `conversations/simulate` también: solo `JwtAuthGuard`, más el interruptor
  `CONVERSATIONS_SIMULATE_ENABLED` (BE-SET-22).

## B.2 — Matriz de aislamiento multitenant

**Resolución del tenant activo** (header `X-Tenant-Id`): la matriz completa está en §1.3
(BE-MT-01…11) y no se repite. Resumen de contextos → resultado: 1 tenant sin header = usa el
único; varios sin header = 400; header propio = OK; header ajeno (usuario común) = 403; header
ajeno (usuario de sistema) = OK con rol de sistema; empresa inexistente o dada de baja = 404; sin
ninguna membresía = 403.

**Aislamiento por id** — pedir un recurso de OTRA empresa *teniendo* el permiso. Es donde vivía el
IDOR de flujos (SEC-03), hoy cerrado salvo una ruta:

| Recurso (operación por id) | Con id de otra empresa | Caso |
|---|---|---|
| roles (`GET/PATCH/DELETE /:id`) | 404 aislado | BE-RBAC-13 |
| users (`GET /:id`) | 404 "no existe en este tenant" | BE-USR-20 |
| areas (`GET/PATCH/DELETE /:id`) | 404 aislado | BE-ARE-10 / 19 / 22 |
| context-sources (`GET /:id`) | 404 aislado | BE-CS-03 |
| schedule-calendar (`GET/PATCH/DELETE /:id`) | 404 aislado | BE-CAL-06 |
| flows (`GET/PATCH/DELETE /:id`) | 404 aislado ✅ | BE-FLW-14 |
| flows (`assign-tenants`) | 404 aislado ✅ | BE-FLW-16 |
| flows (`default`) | **sin corte** ❌ — cambia un default global | BE-FLW-22 |
| flows (`variants`, los tres verbos) | 404 aislado ✅ | BE-VAR-06 / 07 |
| settings (`:key`) | n/a — `key` es única global, no por tenant | §1.7 |

**Aislamiento en ejecución** — un flujo compartido entre empresas corriendo una conversación de
**una** de ellas no debe alcanzar recursos de las otras:

| Qué se resuelve en ejecución | Comportamiento | Caso |
|---|---|---|
| Destinatarios del nodo `sms` | filtrados por la empresa de la charla ✅ | CHAT-N-SMS-04 |
| Asignados de `transfer_agent` | filtrados por la empresa de la charla ✅ | CHAT-N-TRF-08 |
| Ticket consultado por `ticket_query` | filtrado por empresa, y por cliente en InvGate ✅ | CHAT-N-TKQ-03 / 09 |
| Skill del flujo | **sin re-chequeo** ❌ (SEC-17) | BE-SKL-08 |
| Referencias embebidas al guardar | saneadas contra las empresas válidas ✅ | BE-FLW-25 / FE-FLW-29 |

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
| `acme` | `Alta sin roles` | `users:read` + `users:create`, **sin** `roles:read` (para FE-USR-16 y BE-RBAC-25/26: el alta tiene que funcionar por el permiso alternativo, recibiendo id y nombre de cada rol pero **no** su matriz de permisos) |
| `acme` | `Agenda` | Las cuatro acciones de `schedule-calendar` y nada más: sirve para el ABM del calendario (§1.25) y para los negativos de la pantalla (FE-CAL-07), donde otro rol sin ese permiso no ve el ítem del menú |
| `acme` | `Guardia` | Rol **portador de calendario**: existe para colgarle entradas de feriado y guardia acotadas a un rol (BE-CAL-07) y para que su flujo de inicio tenga variantes (`F-VARIANTES`) |
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
| `flor@acme.test` | `acme` / Alta sin roles | `+5491100000006` | Alta de usuarios sin poder leer los roles (FE-USR-16) |
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
| `F-VARIANTES` | `acme` + rol `Guardia`, marcado **Inicio** para ese rol | Flujo Principal con **las dos variantes** configuradas (Feriado y Guardia), cada una con un texto de arranque distinguible para saber cuál corrió. Precondición de §1.26, de CHAT-START-08 y de las pestañas del editor (FE-FLW-30…34) |
| `F-NODOS-2` | `acme`, sin marcar inicio | Los nodos que faltaban en `F-NODOS`: `notification` en sus dos modos (confirmar con "Espera una foto" y link), `condition` en formato **nuevo** (con solo la rama afirmativa cableada, para CHAT-N-CND-11, y otra con una arista sin handle), `webhook` con cuerpo JSON apuntando a un receptor de prueba **local**, y `ticket_query` contra InvGate |

> `F-NODOS` incluye a propósito un nodo `subflow` que apunta a un flujo **borrado** y una
> condición con expresión regular inválida: son las precondiciones de dos casos de fallo.
>
> El nodo `webhook` de `F-NODOS-2` apunta a un receptor **de prueba y local**, nunca a un servicio
> productivo ni a un endpoint público: la llamada es real (CHAT-N-WHK-01) y el cuerpo se interpola
> con las variables de la charla, así que un destino equivocado publica datos de la conversación
> hacia afuera. El caso adversarial de destino interno (CHAT-N-WHK-04) se ejercita en un ambiente
> aislado, no contra la red del despliegue.

## C.5.1 — Calendario de feriados/guardias

| Empresa | Entrada | Para qué |
|---------|---------|----------|
| `acme` | Feriado de un día, `roleId` **null** | Aplica a todos los roles: el caso base de `resolveStatus` y de la variante Feriado |
| `acme` | Guardia 20:00→08:00 del rol `Guardia`, repetición **semanal** sin "hasta" | Cruza medianoche (FE-CAL-02), repite indefinidamente (BE-CAL-08) y es la que dispara la variante Guardia |
| `acme` | Feriado y guardia **solapados** el mismo instante, mismo rol | Verifica que gana feriado (BE-CAL-07) |
| `acme` | Entrada mensual anclada un **31** | Documenta el desborde de días conocido (BE-CAL-09) |
| `acme` | Import de feriados de un año completo (`source` = importado) | Reimportar sin duplicar y deshacer en bloque sin tocar las manuales (BE-CAL-11) |
| `globex` | Una entrada cualquiera | Aislamiento por id (BE-CAL-06) y que no se mezcle en el `resolveStatus` de `acme` |

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
