# Plan de Trabajo - Chatbot de Soporte Omnicanal con IA

**Proyecto:** PCI Chatbot  
**Stack:** NestJS (API) + Next.js (Web) + PostgreSQL + RabbitMQ + Prisma  
**Fecha:** Agosto 2026

> ⚠️ **Regla del proyecto:** ante *todo* cambio (código, docs, schema, configuración) hay
> que correr `/graphify . --update` antes de dar la tarea por terminada, y reflejar acá el
> cambio de estado del hito. Ver [AGENTS.md](../AGENTS.md).

---

## Hito 0 - Setup ✅ COMPLETADO

### Infraestructura base
- [x] Monorepo pnpm workspaces (`apps/api` + `apps/web`)
- [x] NestJS 11 scaffold en `apps/api`
- [x] Next.js 16 + React 19 + Tailwind 4 en `apps/web`
- [x] PostgreSQL (servidor `192.168.0.123`) configurado
- [x] RabbitMQ (servidor `192.168.0.123`) configurado
- [x] Docker Compose local eliminado (infra externa confirmada)
- [x] `.env` con placeholders y `JWT_SECRET` generado
- [x] `pnpm-workspace.yaml` con `allowBuilds` para pnpm 11

### Base de datos y ORM
- [x] Prisma 5.22.0 instalado en `apps/api`
- [x] **Seed idempotente** creado (`prisma/seed.ts`)
  - Tenant por defecto: "Sistema PCI" (slug: `system`)
  - Rol `SuperAdmin` con 44 permisos CRUD sobre todos los recursos
  - Usuario admin: `admin@pci.local` / `changeme123`
  - Settings por defecto en BD: OTP TTL (300s), Fingerprint TTL (90 días)
  - Script: `pnpm --filter api run db:seed`
- [x] Modelo de datos completo con 9 entidades:
  - `User`, `Tenant`, `Role`, `RolePermission`, `UserTenant`
  - `Device` (fingerprint)
  - `Conversation`, `Message`
  - `Ticket` (integración Invgate)
  - `Metric` (auditoría)
  - `Setting` (parámetros backend)
- [x] `PrismaService` + `PrismaModule` global
- [x] `AppConfigService` (lee BD con fallback a env vars)
- [x] Relaciones de multitenant y RBAC dinámico definidas

### Esqueleto de módulos API
- [x] 11 módulos de dominio creados con comentarios de constraints:
  - `Auth`, `Users`, `Tenants`, `Rbac`, `Devices`
  - `Conversations`, `Invgate`, `Llm`, `Channels`, `Broker`, `Metrics`
- [x] `LlmProvider` interface (contrato provider-agnostic)
- [x] `@nestjs/config` global para variables de entorno
- [x] Build y tests pasan en ambos apps

---

## Hito 1 - Core de Seguridad 🔄 EN PROGRESO

### Autenticación y 2FA ✅ COMPLETADO
- [x] **AuthModule:** Registro de usuarios (`POST /auth/register`)
  - Validación de email único con `class-validator`
  - Password hash con bcrypt (salt rounds 10)
- [x] **AuthModule:** Login (`POST /auth/login`)
  - Verificación de credenciales con bcrypt
  - Si fingerprint conocido y vigente → emite JWT directamente
  - Si fingerprint nuevo/expirado → envía OTP por email → pide `verify-otp`
- [x] **AuthModule:** OTP 2FA vía Email (`POST /auth/verify-otp`)
  - Código numérico de 6 dígitos generado aleatoriamente
  - TTL parametrizable desde BD (default 300s) vía `AppConfigService`
  - `EmailService` es abstracción provider-agnostic; implementación `StubEmailService` para desarrollo
  - Al validar OTP, registra automáticamente el nuevo dispositivo (fingerprint)
- [x] **AuthModule:** Fingerprint de dispositivo
  - V1 = phone + User-Agent (base64, decición fijada en spec §7)
  - TTL parametrizable desde BD (default 90 días)
  - Almacenamiento en tabla `Device` con `expiresAt`
- [x] JWT Strategy + `JwtAuthGuard` para protección de endpoints
- [x] `ValidationPipe` global en `main.ts` (whitelist, transform)

### RBAC Dinámico ✅ COMPLETADO
- [x] CRUD de Roles (por tenant) — `POST/GET/PATCH/DELETE /roles`
  - Scoping automático por `tenantId` del JWT
  - Incluye relación con permisos en las respuestas
- [x] CRUD de Permisos (resource + action) — `POST/GET/DELETE /roles/:roleId/permissions` y `DELETE /roles/permissions/:id`
  - Permisos asociados a roles mediante `RolePermission`
- [x] `RolesGuard` — global, reusable
  - Lee `@RequirePermission('resource', 'action')` del handler/clase
  - Consulta en tiempo real los permisos del usuario en el tenant activo
  - Si no hay decorator, permite el acceso (flexible para endpoints públicos)
- [x] Decorator `@RequirePermission(resource, action)`
  - Tipado fuerte, metadata accesible por `Reflector`
- [x] Endpoint `GET /auth/me`
  - Devuelve usuario + tenants + roles + permisos completos
  - Ideal para construir menús dinámicos en el frontend
- [x] Endpoints de RBAC protegidos con `@RequirePermission()`
  - Solo usuarios con `roles:*` y `permissions:*` pueden gestionar RBAC
  - El seed creó al admin con todos estos permisos

---

## Hito 2 - Lógica de Negocio 🔄 EN PROGRESO

### Broker (RabbitMQ) ✅ COMPLETADO
- [x] `BrokerModule` con `BrokerService`
  - Conexión a RabbitMQ en `192.168.0.123` vía `amqplib`
  - Reconexión automática con backoff de 5s
  - `publish(queue, message)` con mensajes persistentes
  - `subscribe(queue, handler)` con ack/nack
  - Tipado fuerte: `BrokerMessage` con `pattern`, `data`, `tenantId`, `timestamp`
- [x] Desacople de canales: el core publica/consume por el broker, nunca depende de WhatsApp

### Capa de Abstracción LLM ✅ COMPLETADO (6 proveedores)
- [x] Implementar `OpenAiProvider` (primera implementación concreta de `LlmProvider`)
  - Usa SDK de OpenAI pero SOLO dentro del provider (business logic nunca lo toca)
  - Configurable: `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-4o-mini`)
- [x] Implementar `GeminiProvider`
  - SDK `@google/generative-ai`, modelo default `gemini-1.5-flash`
  - Adaptación de roles (assistant → model para Gemini)
- [x] Implementar `ClaudeProvider`
  - SDK `@anthropic-ai/sdk`, modelo default `claude-3-5-sonnet-20241022`
  - Manejo de system prompt separado (formato Claude)
- [x] Implementar `OpenRouterProvider`
  - Reutiliza SDK de OpenAI con `baseURL: https://openrouter.ai/api/v1`
  - Modelo default: `openai/gpt-4o-mini`
- [x] Implementar `OpenCodeGoProvider`
  - Provider genérico con `fetch` HTTP
  - Requiere `OPENCODEGO_API_URL` y `OPENCODEGO_API_KEY`
  - Formato compatible con OpenAI Chat Completions (ajustable cuando se defina la API real)
- [x] **Implementar `MiniMaxProvider`** (pedido 2026-08-05)
  - MiniMax expone `/v1/chat/completions` compatible con el formato de OpenAI
    ([doc oficial](https://platform.minimax.io/docs/api-reference/text-openai-api)), así que
    reutiliza el SDK de OpenAI apuntando a `baseURL: https://api.minimax.io/v1` — mismo
    patrón que `OpenRouterProvider`, sin código nuevo de parsing
  - Modelo default `MiniMax-M2.5`; catálogo conocido para el dropdown de `/settings`:
    `MiniMax-M3` (1M de contexto), `M2.7`, `M2.5`, `M2.1`, `M2`
  - `MINIMAX_API_KEY` queda documentada como compartida a futuro con la API de audio de
    MiniMax (T2A) — ver "Audio (STT/TTS)" en Próximos pasos. Por ahora **solo texto**:
    no hay ningún código de síntesis/transcripción todavía, a propósito
- [x] `LlmService` provider-agnostic
  - Merge de config: tenant-specific > env vars > defaults
  - Inyecta `systemPrompt` automáticamente si no está en los mensajes
- [x] **Selector dinámico de proveedor** (`LlmProviderFactory`)
  - Lee `LLM_PROVIDER` de BD (Setting) primero, fallback a env var
  - Soporta: `openai`, `gemini`, `claude`, `openrouter`, `opencodego`, `minimax`
  - Default: OpenAI si el proveedor es desconocido

### Integración Invgate ⏳ PENDIENTE
- [ ] Conexión API con usuario técnico dedicado
- [ ] Crear tickets automáticos desde conversaciones
- [ ] Consultar estado de tickets existentes
- [ ] Actualizar tickets con respuestas del usuario
- [ ] Mapeo de campos Invgate ↔ nuestro modelo `Ticket`

### Procesamiento de Conversaciones ✅ COMPLETADO
- [x] `BrokerModule` suscrito a cola `whatsapp.incoming`
  - Reconexión automática si RabbitMQ cae
  - Handler desacoplado: no sabe que viene de WhatsApp
- [x] `ConversationsService` — Orquestador core
  1. **Identificación:** busca/crea `User` por teléfono (`UsersService.findOrCreateByPhone`)
  2. **Conversación:** busca/crea `Conversation` activa por `userId + tenantId + channel`
  3. **Persistencia:** guarda mensaje del usuario en `Message`
  4. **Decisión:** detecta keywords de escalamiento (`ticket`, `agente`, `escalar`, `no funciona`)
     - Si escala → crea `Ticket` en BD + responde con número de ticket
     - Si no → consulta LLM con últimos 10 mensajes de contexto
  5. **Respuesta:** guarda respuesta del asistente en `Message`
  6. **Envío:** publica a `whatsapp.outgoing` vía `BrokerService`
- [x] `ChannelsService` — wrapper para publicar mensajes a canales
- [x] **`/conversations/simulate` pasa por RabbitMQ de punta a punta** (pedido 2026-08-04)
  - Antes llamaba a `handleMessage` en proceso, sin tocar el broker — no simulaba nada
  - Ahora publica en una cola propia `whatsapp.simulate.incoming` (separada de la real
    `whatsapp.incoming`, para no mezclar tráfico de prueba con producción) y espera la
    respuesta vía RabbitMQ, no en memoria
  - Patrón RPC estándar: `BrokerService.request()` con `correlationId` + una cola de
    respuesta exclusiva por conexión. `handleMessage` respeta `msg.replyTo` al publicar
    la respuesta; sin `replyTo` (mensajes reales) se comporta exactamente igual que antes
  - Timeout de 90s → `504 Gateway Timeout` con el motivo, en vez de colgar la request
  - **Tres bugs de robustez del broker aparecieron al implementar esto y quedaron
    arreglados, no son específicos de simulate:**
    1. `channel.ack()`/`channel.nack()` sobre un canal ya cerrado por el servidor tiran
       una excepción **sincrónica** que quedaba sin capturar dentro del callback de
       `consume()` — **tiraba abajo todo el proceso Node**, no solo el mensaje en curso.
       Ahora `safeAck`/`safeNack` la contienen
    2. Cola de respuesta anónima (`assertQueue('', ...)`): RabbitMQ nombra estas colas
       `amq.gen-*`, y `amq.*` es un prefijo reservado del servidor — este broker (y
       muchos, según su config) rechaza que un cliente declare ahí. Se pasó a nombre
       propio (`whatsapp.rpc.reply.<uuid>`)
    3. **El bug que de verdad rompía el request/reply**: `publish()` reafirma toda cola
       con `{durable: true}` a secas. La cola de respuesta es `exclusive: true`, y
       reafirmarla sin esa propiedad hace que RabbitMQ la vea como "otra declaración,
       recurso bloqueado" (405) y cierre el canal — la respuesta nunca llegaba y el
       request se colgaba hasta el timeout. `publish()` ahora acepta `{ assert: false }`
       para saltear el re-assert cuando el llamador ya sabe que la cola existe
  - Verificado con concurrencia real (3 requests en paralelo, sin cruce de respuestas
    entre `correlationId`s) y multi-turno (misma conversación, memoria de estado)
- [x] **Herramientas para probar el bot sin WhatsApp**
  - `POST /conversations/simulate` ahora **devuelve la respuesta del bot** (`reply`).
    Antes solo confirmaba "Mensaje procesado" y había que ir a mirar la tabla `Message`
    o los logs: inútil para un endpoint cuyo propósito es probar
  - `pnpm --filter api chat` — chat interactivo por consola (`apps/api/scripts/chat.mjs`)
    con comandos `/estado` (flujo y nodo actual + variables), `/reset` y `/salir`.
    Resuelve solo el tenant si no se le pasa
- [x] **`llm_query` terminal ya no resetea el flujo**
  - Un `llm_query` sin aristas de salida se tomaba como fin de flujo, así que **cada
    mensaje volvía a arrancar desde `start`** y repetía el saludo y los nodos previos
  - Ahora la conversación queda parada ahí: los mensajes siguientes van derecho al modelo
  - Un nodo que apunta a sí mismo también se interpreta como "esperá acá" en vez de
    ejecutarse en bucle — en un `llm_query` eso eran 25 llamadas al modelo por mensaje
- [x] Endpoint `POST /conversations/simulate` — testing sin RabbitMQ
  - ⚠️ **Sin guard de autenticación y recibe `tenantId` por body.** Aceptado a propósito
    mientras el proyecto no sea funcional. **Cerrar antes de exponer el API fuera de la red
    interna** (agregar `JwtAuthGuard` + tomar el tenant de `@CurrentTenant()`).
- [x] Flujo completo end-to-end: mensaje → usuario → conversación → LLM/ticket → respuesta
- [x] **Cierre automático por inactividad** (pedido 2026-08-10): `ConversationsService`
  corre un `@Cron` cada 10 minutos (`ScheduleModule`, nuevo — `apps/api/src/app.module.ts`)
  que cierra toda `Conversation` `active` sin `Message` en la última hora
  (`INACTIVITY_TIMEOUT_MS`), reusando `closeConversation()`. El próximo mensaje del
  usuario, si llega dentro de `RESUME_WINDOW_MS` (12h), retoma la misma `Conversation`
  pero con el flujo reseteado — arranca de nuevo sin perder el historial de `Message`

### Configurabilidad general de flujos IVR ✅ COMPLETADO (pedido 2026-08-04)
- [x] **Campo `context`** — fuente de datos que respalda las respuestas del flujo
  - Lista cerrada, no texto libre: `none` (default) / `invgate` / `internal_kb` / `other`.
    Definida una sola vez en `apps/api/src/modules/flow/flow-context.ts`
    (`FLOW_CONTEXT_OPTIONS`) y duplicada en el dropdown del frontend — son 4 valores
    fijos, no ameritan un endpoint dedicado (mismo criterio que `nodeTypeList`, que
    tampoco viene del backend)
  - Migración manual `20260804160000_add_flow_context`: columna `TEXT NOT NULL
    DEFAULT 'none'` + índice — los flujos existentes quedan en "genérico" sin que
    haya que tocarlos
  - Validado con `@IsIn(FLOW_CONTEXT_VALUES)` en ambos DTOs; un valor fuera de la
    lista rechaza con 400 y dice cuáles son los válidos
  - `flow.service.ts` no necesitó cambios: `create`/`update` ya spreadean el resto
    del DTO (`...flowData` / `...rest`), así que el campo pasa solo
  - Dropdown en el header del editor, junto a nombre y descripción
  - Verificado end-to-end: default sin mandarlo, valor explícito, rechazo de valor
    inválido, y actualización vía `PATCH`
- [x] **Checkboxes de selección múltiple de tenants**
  - El backend ya existía (`tenantIds` en `CreateFlowDto`, `POST /flows/:id/assign-tenants`);
    faltaba la UI. Ahora el editor tiene una barra debajo del header con un checkbox
    por tenant — "Disponible en: [ ] TenantA [ ] TenantB..."
  - Caso de uso explícito del usuario: un menú de sucursales puede diferir entre
    tenants, así que un mismo flujo (o sub-flujo) se puede compartir entre
    empresas o quedar exclusivo de una, de forma independiente por tenant
  - `GET /tenants/all` (nuevo): lista **todos** los tenants del sistema, no solo
    el activo. Gateado con `SystemTenantGuard` — es cross-tenant por naturaleza
    (elegir a qué empresas asignar algo exige poder verlas todas), mismo criterio
    que `/settings`. Antes no había forma de listar todos los tenants desde el
    frontend: `GET /tenants` está scoped a `findMyTenants` (solo el tenant activo)
    a propósito, por aislamiento — se dejó así, se agregó el endpoint nuevo aparte
  - `SystemTenantGuard` se movió de `modules/settings/guards/` a
    `common/guards/`: dejó de ser específico de Settings en cuanto Tenants
    también lo necesitó. Mensaje de error generalizado ("esta operación" en vez
    de "la configuración del sistema")
  - Si el editor no puede ver la lista completa (no está en el tenant de sistema),
    la barra de checkboxes simplemente no aparece — no es un error bloqueante
- [x] **"Flujo de inicio" — por tenant, no global**
  - Aclaración del usuario: NO es el nodo `start` dentro del flujo. Es una
    propiedad — cada tenant tiene como máximo un flujo de inicio, y es
    configurable con un checkbox aparte ("Inicio"). Si el flujo tiene varios
    tenants asignados, marcarlo como inicio lo vuelve el flujo de inicio para
    *todos* los tenants seleccionados en ese momento
  - Motivación explícita: poder personalizar el mensaje de bienvenida según
    fechas u ocasiones (cambiar qué flujo es "el de inicio" sin tocar el flujo
    de siempre)
  - **`TenantFlow.isStart`, no `Flow.isStart`** — decisión de modelo deliberada:
    un mismo flujo puede ser de inicio para el tenant A y no para el B, así que
    el dato no puede vivir a nivel `Flow`. Distinto del `Flow.isDefault`
    preexistente, que es un default *global de todo el sistema*
  - Invariante "un tenant, un flujo de inicio como máximo" se aplica en
    `FlowService.applyTenantAssignment` (transacción: al marcar un flujo como
    inicio para unos tenants, desmarca cualquier OTRO flujo que lo fuera para
    esos mismos tenants — sin tocar su estado en tenants que no estén en la
    selección actual)
  - **Esto resuelve, de paso, el bug de ambigüedad que habíamos marcado antes**:
    `findActiveFlowForTenant` hacía `tenantFlow.findFirst({where:{tenantId}})`
    sin ningún orden — con varios flujos asignados a un tenant (que es
    justamente el caso de uso que estos checkboxes habilitan), cuál "ganaba"
    era impredecible. Ahora filtra explícitamente por `isStart: true`,
    determinístico por construcción (la invariante garantiza como máximo uno).
    El viejo `Flow.isDefault` global queda como fallback de compatibilidad si
    el tenant no tiene ningún flujo de inicio propio configurado
  - Verificado con dos tenants de prueba: flujo 1 marcado inicio para A y B →
    flujo 2 marcado inicio solo para A → flujo 1 pierde el inicio en A pero lo
    conserva en B (verificado en BD, exactamente 1 por tenant) → un mensaje real
    a un número nuevo en el tenant B activa el flujo correcto (flujo 1)

### Motor de Flujos Conversacionales (IVR) ✅ COMPLETADO
- [x] Modelo de datos: `Flow`, `TenantFlow`, y campos `currentFlowId` / `currentNodeId` /
      `flowState` en `Conversation` (migración `add_flow_ivr_tables`)
- [x] `FlowModule` con CRUD completo (`/flows`), scopeado por tenant y protegido con
      `@RequirePermission('flows', ...)`
- [x] Motor de ejecución en `ConversationsService.executeFlow()`
  - Precedencia: si el tenant tiene un flujo activo, corre el flujo; si no, cae al
    orquestador LLM
  - Estado persistido por conversación (`flowState`), con reseteo al terminar el flujo
- [x] 13 tipos de nodo: `start`, `message`, `menu`, `input`, `condition`, `ticket_create`,
      `ticket_query`, `transfer_agent`, `llm_query`, `delay`, `variable`, `webhook`, `subflow`
  - ⏳ `transfer_agent` y `webhook` son stubs: responden texto fijo, no ejecutan la acción
- [x] Editor visual en Next.js con ReactFlow (`/dashboard/flows` y `/dashboard/flows/[id]`)
  - Componentes `flow-nodes.tsx` y `flow-edges.tsx`
- [x] Soporte de sub-flujos (nodo `subflow` con nodo de entrada configurable)
- [x] **Encadenamiento de nodos no interactivos**
  - Antes se ejecutaba **un nodo por mensaje entrante**: un flujo
    `start → message → llm_query` necesitaba tres mensajes del usuario para llegar
    a consultar al LLM
  - Ahora `executeFlow` itera hasta llegar a un nodo que pida esperar o al final del
    flujo, y concatena las respuestas en un solo mensaje de salida
  - `MAX_FLOW_STEPS = 25` corta ciclos entre nodos no interactivos
  - `delay` acotado a 10s: encadenando, un delay largo colgaría la request entera
- [x] **`menu` e `input` con espera en dos fases**
  - El set estático de "nodos interactivos" no alcanzaba: al encadenar, el nodo
    consumía el mismo mensaje que lo activó. Ahora cada nodo devuelve `waitForInput`
  - Primera llegada: muestra el prompt y espera (marca `flowState.__awaiting`)
  - Segunda: el body ya es la respuesta del usuario → la guarda y avanza
  - `input` antes quedaba trabado para siempre: capturaba el body pero se quedaba
    en el mismo nodo sin avanzar nunca
- [x] **El nodo `start` nunca detectaba un número desconocido** (bug reportado 2026-08-04)
  - Causa: `handleMessage` creaba el `User` por teléfono **antes** de correr el flujo
    (paso 1, `findOrCreateByPhone`). Para cuando el nodo `start` preguntaba "¿existe
    este usuario?", la respuesta siempre era sí — porque lo acababa de crear él mismo
    un instante antes. La rama `unknown` era, en la práctica, inalcanzable
  - Se aprovechó para resolver algo más que pedía el usuario: "conocido" ahora
    significa **registrado en el tenant, con rol** (`UserTenant` + `Role`), no
    simplemente "ya existe una fila en `User`" — que era cierto para cualquier
    número que hubiera escrito una sola vez
  - `UsersService.findMembershipByPhone(phone, tenantId)` — nueva consulta contra el
    registro real de usuarios, trae el usuario y su rol en ese tenant
  - `handleMessage` la corre primero; solo cae al `findOrCreateByPhone` (ghost user
    placeholder) si no hay membresía registrada. El resultado (`user` + `identity`)
    se enhebra por `executeFlow` → `executeNode`, así el nodo `start` ya no vuelve a
    consultar nada — usa lo que `handleMessage` ya resolvió
  - `flowState` ahora expone `userRole` / `userRoleId` además de `isKnownUser`, para
    que otros nodos (`condition`, por ejemplo) puedan ramificar por rol
  - Beneficio no buscado: un usuario registrado ahora saluda con su **nombre real**
    (`firstName`/`lastName` de su alta), no con el placeholder "Usuario WhatsApp"
  - Verificado con un usuario SuperAdmin real vs. un teléfono nuevo: el registrado
    saluda por su nombre y trae `userRole: "SuperAdmin"`; el nuevo toma la rama
    `unknown` del flujo (antes imposible) y no arrastra ningún rol
- [x] **El nodo `start` enruta por el handle del editor**
  - El motor leía `data.knownTargetNodeId` / `unknownTargetNodeId`, pero el editor
    visual dibuja aristas con `sourceHandle: 'known' | 'unknown'`. Al no encontrar
    target caía en "primera arista que salga del nodo", así que un usuario
    desconocido podía irse por la rama de conocido según el orden del array
  - `resolveNextNode` ahora prioriza: target explícito → arista por `sourceHandle` →
    primera arista. `data.*TargetNodeId` sigue andando para flujos viejos
  - Verificado con la arista `unknown` puesta primera a propósito: el usuario
    conocido igual sale por la rama correcta
- [x] **Guardado del flujo: saneo del payload de ReactFlow**
  - El `ValidationPipe` global usa `forbidNonWhitelisted: true`, y ReactFlow agrega
    estado de runtime a los nodos (`measured` con el tamaño calculado, `selected`,
    `dragging`) que hacía fallar el guardado con 400
  - El frontend ahora manda solo lo que define el flujo: nodos con
    `id/type/position/data` y aristas con `id/source/target/type/handles/label`
  - `FlowEdgeDto.type` **sí** se agregó al DTO: elige el renderer de la arista
    (`DeletableEdge`). Relajar la validación en vez de declararlo habría hecho que
    `whitelist: true` lo descartara en silencio y se perdiera el botón de borrar
  - El `alert` de error ahora muestra el mensaje del backend en vez de "Error al guardar"
- [x] **Borrado de aristas en el editor**
  - `DeletableEdge` usaba `setEdges` de `useReactFlow`, que escribe solo en el store
    interno. Como la página maneja las aristas de forma controlada (`useEdgesState`
    + `edges={edges}`), el estado del padre no cambiaba y el siguiente render
    restauraba la arista: parecía que el borrado no hacía nada
  - Ahora usa `deleteElements`, que genera un change de tipo remove y viaja por
    `onEdgesChange` — que es lo que actualiza el estado del padre
  - Se quitó el borrado al hacer click sobre la flecha: un click accidental borraba
    sin aviso. Queda el botón × al pasar el mouse
  - `deleteKeyCode={['Backspace','Delete']}` para borrar con teclado lo seleccionado
- [x] **`menu`/`input` menos estrictos: interpretación semántica y cancelación coloquial**
      (pedido 2026-08-05)
  - Antes, si la respuesta no matcheaba literal (número/label/value), `menu` repetía
    "Opción no válida" en loop. El usuario pidió: evaluar lo que dice el usuario, no
    solo comparar texto exacto, y poder cancelar la gestión en curso en lenguaje coloquial
  - `interpretMenuChoice()`: cuando no hay match literal, se le pregunta al LLM (clasificador
    de una sola llamada, `temperature: 0`) si el mensaje corresponde a alguna opción en
    lenguaje natural (ej. "se me rompió la impresora" → opción de soporte técnico) o si es
    una cancelación ("dejalo", "mejor no"). Solo se gasta esta llamada cuando el match
    literal ya falló — cero costo extra en el camino feliz
  - `input`: filtro barato por palabras clave (`looksLikeCancelAttempt`) antes de aceptar
    cualquier texto como el dato pedido; solo si hay sospecha de cancelación se confirma
    con el LLM (`confirmCancelIntent`). Así una respuesta normal (email, nombre) no paga
    ninguna llamada extra
  - Nuevo campo `cancelFlow` en el resultado de `executeNode`, manejado en `executeFlow`:
    termina el flujo igual que un fin normal (mismo `resetFlow`), sin seguir ninguna arista
    del nodo donde el usuario estaba parado
  - **Si el mensaje no matchea ninguna opción NI es cancelación**, en vez de insistir con
    el menú, el LLM toma la conversación (reutiliza `orchestratorLlm`, el mismo que ya
    atiende mensajes fuera de flujo) para entender el problema y recopilar datos.
    `flowState.__llmFallback = node.id` hace que los próximos mensajes de esa conversación
    ya no vuelvan a evaluar contra las opciones — quedan en conversación libre, igual que
    el patrón ya existente de `llm_query` terminal. Por ahora solo conversa y junta
    contexto: no genera ticket ni busca en una base de conocimiento (pendiente de que se
    definan las fuentes de conocimiento)
  - Ambas llamadas al LLM son best-effort: si el proveedor falla, no cancela ni fuerza un
    match — cae al comportamiento anterior antes que arriesgar una ruta equivocada
  - Verificado en vivo contra un servidor real (`opencodego`): lenguaje natural mapeado
    correctamente a una opción, cancelación coloquial confirmada (conversación reseteada
    en BD), y texto sin sentido sigue repitiendo el menú sin forzar un match falso
- [x] **Opción "Volver" automática en todo menú que no sea el raíz** (pedido 2026-08-12)
  - Regla: cualquier `menu` debe ofrecer volver al menú anterior, salvo que no exista uno
    (el menú por el que arranca el flujo). Se resolvió en el motor, no a mano en cada nodo
    del editor — así funciona para todos los menús existentes y futuros sin cablear nada
  - `flowState.__menuStack: {nodeId, flowId}[]` — pila de navegación **de esta conversación
    en tiempo de ejecución**, no del grafo estático del flujo: cada vez que se elige una
    opción real (no "Volver") se apila el menú que se abandona (`case 'menu'`,
    `ConversationsService`). Vacía = no hay menú anterior → no se ofrece "Volver". Al elegir
    una opción real se apila SIEMPRE, sin mirar qué tipo de nodo sigue — si hay nodos no
    interactivos en el medio (`input`, `variable`, etc.) antes del próximo menú, la pila ya
    tiene la entrada correcta para cuando se necesite
  - "Volver" es una opción sintética (`value: '__volver'`, reservado — el editor solo genera
    valores numéricos por defecto) que se agrega a `options` únicamente para mostrar y
    matchear (`displayOptions`), nunca se persiste en el `Flow.nodes` del editor. Participa
    del match literal Y de `interpretMenuChoice` (el clasificador LLM), así que también
    entiende "volvé", "atrás", etc., no solo el label exacto
  - Al elegir "Volver" (`navigateMenuBack`) se desapila el tope y se navega ahí. Si ese menú
    pertenece a otro `Flow` (se llegó vía nodo `subflow`), reusa el mecanismo existente de
    cambio de flujo (`flowState.__subflow`, ya consumido por el loop de `executeFlow`) en vez
    de duplicar esa lógica — soporta cruzar de vuelta un límite de subflow sin código nuevo
  - `buildMenuInteractive` ya cortaba en 10 opciones (WhatsApp): si un menú ya tenía 10 y le
    toca sumar "Volver", se pasa el límite y cae solo al modo texto plano — sin límite, sin
    romper nada, comportamiento ya existente reutilizado tal cual
  - Verificado en vivo contra el flujo real (`Test Flow`): menú raíz (`__menuStack` vacía) →
    elegir opción → nodo `input` intermedio → submenú (`__menuStack` con el raíz apilado,
    "Volver" ofrecido) → elegir "Volver" → vuelve exactamente al menú raíz con la pila vacía
    de nuevo. El caso de cruzar un `subflow` al volver quedó implementado y tipado, pero sin
    ejercitar en vivo todavía (no había un caso de prueba a mano con esa forma exacta)

### Conector real de WhatsApp y Email ✅ COMPLETADO (pedido 2026-08-05)
- [x] **`WhatsAppService` — envío real por la Cloud API de Meta**
  - Hasta ahora nadie consumía la cola `whatsapp.outgoing`: `ChannelsService` y
    `ConversationsService.handleMessage` publicaban ahí y los mensajes se perdían en el
    aire. `WhatsAppService.onModuleInit()` la suscribe y llama a
    `graph.facebook.com/{version}/{phoneNumberId}/messages`
  - Solo `type: "text"` — funciona dentro de la ventana de 24hs desde el último mensaje
    del usuario (política de Meta). Mensajes iniciados por el negocio fuera de esa
    ventana necesitan un `template` aprobado, no soportado todavía
  - Probado contra credenciales reales de sandbox: la llamada a la Graph API funciona
    (confirmado pegándole directo, sin pasar por la cola); el intento de entrega falló
    por `(#131030) Recipient phone number not in allowed list` — restricción normal del
    modo sandbox de Meta (hay que agregar el número de prueba a mano en
    Meta for Developers), no un bug del código
- [x] **`WhatsAppWebhookController` — recepción real**
  - `GET /webhooks/whatsapp`: handshake de verificación de Meta. Compara
    `hub.verify_token` contra `WHATSAPP_WEBHOOK_VERIFY_TOKEN` y devuelve `hub.challenge`.
    Sin `JwtAuthGuard` a propósito — Meta no manda ningún token nuestro, la prueba de
    identidad es conocer el verify token
  - `POST /webhooks/whatsapp`: recibe el payload real de Meta, extrae `messages[].text.body`
    y publica a `whatsapp.incoming` con el mismo shape que ya esperaba `handleMessage`.
    Mensajes que no son `type: text` (audio, imagen, stickers) se loguean y se descartan
    — no hay pipeline de audio todavía (ver Próximos pasos)
  - Verificado de punta a punta con un túnel de ngrok expuesto unos minutos: el handshake
    respondió 200 con el challenge correcto
  - ⚠️ **Sin verificación de firma** (`X-Hub-Signature-256` con el App Secret de Meta):
    hoy cualquiera que conozca la URL puede publicar mensajes falsos en `whatsapp.incoming`.
    Mismo tipo de deuda que `/conversations/simulate` sin guard — cerrar antes de exponerlo
    fuera de una prueba acotada
  - ⚠️ **Un solo tenant por número de WhatsApp**: el webhook resuelve el tenant destino por
    el nuevo setting `WHATSAPP_TENANT_ID` (o el tenant más antiguo si no está definido) —
    limitación directa de que los settings todavía son globales, no por tenant (ver el
    pendiente en "Configuración del sistema")
- [x] **Email real por SMTP** — reemplaza `StubEmailService` (que solo logueaba en consola)
  - `SmtpEmailService` usa `nodemailer`, resuelve host/puerto/usuario/contraseña/remitente
    vía `AppConfigService` **en cada envío** (no una vez al arrancar), así un cambio desde
    `/settings` aplica sin reiniciar el backend — mismo criterio que el resto de la config
  - Sin `EMAIL_SMTP_HOST` configurado, cae al mismo comportamiento que el viejo stub
    (loguea en consola): no rompe los entornos de desarrollo que nunca configuraron SMTP
  - `StubEmailService` se borró — quedaba redundante, el fallback ya está en el service real
- [x] **Nuevas secciones en `/settings`**: "Mensajería: WhatsApp" (`WHATSAPP_API_TOKEN` secret,
      `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
      secret, `WHATSAPP_TENANT_ID`) y "Mensajería: Email" (`EMAIL_SMTP_HOST/PORT/SECURE/
      USER/PASS`, `EMAIL_FROM`) — mismo patrón cifrado/cascada BD→env→default que las
      claves de LLM. Los tokens quedaron cargados en BD durante las pruebas, cifrados con
      `SecretsCipher`

---

## Hito 3 - Multitenant y Menús ⏳ PENDIENTE

### Aislamiento de datos ✅ COMPLETADO
- [x] **El tenant salió del JWT** (refactor)
  - Antes: el `tenantId` iba en el payload del token y `TenantInterceptor` lo leía de ahí.
    Consecuencia: cambiar de tenant exigía reemitir el token, y el selector del sidebar
    (`setActiveTenant`) solo tocaba `localStorage` → **la UI cambiaba de tenant pero el API
    seguía operando sobre el viejo**
  - Ahora: el JWT es `{ sub, email }`. El tenant activo viaja por header `X-Tenant-Id`
    en cada request
- [x] `TenantGuard` (`src/common/guards/tenant.guard.ts`) reemplaza a `TenantInterceptor`
  - Es **guard y no interceptor** porque en NestJS los guards corren antes, y `RolesGuard`
    necesita el tenant ya resuelto
  - Valida la pertenencia contra `UserTenant` y deja `request.tenantId` / `request.userTenant`
  - Con un solo tenant el header es opcional; con varios es obligatorio (400 si falta)
  - Orden fijo en todos los controladores: `@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)`
- [x] `@CurrentTenant()` lee `request.tenantId` (antes `request.user.tenantId`)
  - Usado en todos los controladores CRUD (`roles`, `users`, `tenants`, `flows`, `settings`)
- [x] `apiFetch` del frontend manda el header desde `localStorage`; `setActiveTenant` recarga
      la vista para que todo se refresque contra el tenant nuevo
- [x] CORS con `allowedHeaders` explícito, si no el browser bloquea `X-Tenant-Id`
- [x] Servicios tenant-scoped
  - `RoleService`: todas las operaciones filtran por `tenantId`
  - `UsersService.findAll()`: solo usuarios del tenant activo (via `UserTenant`)
  - `TenantsService.findMyTenants()`: solo devuelve el tenant activo (aislamiento estricto)
- [x] Todos los endpoints del dashboard respetan el tenant activo del JWT

### Panel Admin (Next.js) ✅ COMPLETADO
- [x] Sistema de autenticación en frontend
  - `AuthContext` + `useAuth` hook con localStorage para JWT
  - Flujo completo: credenciales → OTP → fingerprint → dashboard
- [x] Sidebar dinámico según permisos de `/auth/me`
  - `hasPermission(resource, action)` filtra items de menú
  - Selector de tenant activo si el usuario pertenece a varios
  - Logout con redirección a login
- [x] **CRUD de usuarios completo** (`/dashboard/users`)
  - Modelo: `User.name` se partió en `firstName` / `lastName`
    (migración manual `20260803120000_split_user_name`, escrita a mano para no perder
    los datos existentes — la autogenerada dropeaba la columna sin copiar nada)
  - `GET /users` devuelve el rol que cada usuario tiene *en el tenant activo*
  - `POST /users` con rol **obligatorio**; valida que el rol pertenezca al tenant
    (si no, se filtrarían permisos entre empresas)
  - Si el email ya existe en el sistema, agrega la membresía al tenant en vez de fallar:
    la misma persona puede trabajar en varias empresas
  - `PATCH /users/:id` edita nombre, apellido, teléfono, rol y contraseña (el email no)
  - `DELETE /users/:id` da de baja del tenant. Solo borra el registro si el usuario quedó
    sin tenants **y** sin historial (conversaciones / tickets / métricas); si tiene, lo
    conserva y lo explica en la respuesta. No podés darte de baja a vos mismo
  - Frontend con formulario unificado alta/edición, y botones filtrados por permiso
  - Sin `legajo`: pendiente de definir si aplica siempre
- [x] Páginas CRUD protegidas por RBAC:
  - `/dashboard/users` — CRUD completo
  - `/dashboard/roles` — listado + crear roles + agregar permisos
  - `/dashboard/tenants` — listado + crear tenants
- [x] Dashboard home con cards de resumen y permisos del usuario
- [x] API client (`lib/api.ts`) con interceptación de JWT
- [x] Endpoints del API creados: `GET /users`, `GET/POST /tenants`

### Menús dinámicos desde backend ⏳ PENDIENTE
- [ ] API endpoint: `/menu` que devuelve menús según permisos del rol
- [ ] Estructura de menú configurable desde backend (no hardcoded)

### Configuración del sistema (`/settings`) ✅ COMPLETADO — backend
- [x] `SettingsModule` con CRUD sobre la tabla `Setting`
  - `GET /settings`, `GET /settings/:key`, `POST /settings`, `PATCH /settings/:key`,
    `DELETE /settings/:key`
  - `GET /settings` devuelve valor efectivo + `source` (`db` / `env` / `default`)
  - `DELETE` borra la fila de BD: la clave vuelve a resolverse por env var o default
- [x] Catálogo de claves permitidas (`settings.catalog.ts`) con tipo, rango, grupo y label
  - Autenticación y 2FA: `OTP_ENABLED`, `OTP_TTL_SECONDS`, `OTP_CODE_LENGTH`
  - Dispositivos: `DEVICE_FINGERPRINT_TTL_DAYS`
  - LLM: `LLM_PROVIDER`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_SYSTEM_PROMPT`
  - Cualquier key fuera del catálogo se rechaza con `400` (nadie inyecta config arbitraria)
  - Los secrets **no** están en el catálogo: van solo por env var / vault
- [x] **OTP configurable desde el backoffice**
  - `OTP_ENABLED` reemplaza al `if (process.env.NODE_ENV === 'development')` que estaba
    hardcodeado en `AuthService.login()`. Si nunca se fijó valor, `AppConfigService.otpEnabled()`
    conserva el bypass en desarrollo → comportamiento previo intacto
  - `OTP_CODE_LENGTH` reemplaza los 6 dígitos hardcodeados de `sendOtp()` (rango 4-8,
    con clamp defensivo por si viene una env var cruda fuera de rango)
  - `AppConfigService` suma `getBoolean()`, `otpEnabled()` y `otpCodeLength()`
- [x] Acceso restringido a superusuario con doble candado
  - `SystemTenantGuard`: el tenant activo del JWT debe ser el de sistema (`SYSTEM_TENANT_SLUG`)
  - `@RequirePermission('settings', <action>)`: el seed solo se lo da al rol `SuperAdmin`
  - El corte es por tenant de sistema, no por nombre de rol → no viola RBAC dinámico
- [x] `LlmService` ahora lee `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` / `LLM_SYSTEM_PROMPT` vía
      `AppConfigService` (antes solo miraba env vars, así que los valores de BD no tenían efecto)
- [x] **Pantalla `/settings`** en Next.js (ruta raíz, no bajo `/dashboard`, pero comparte
      `Sidebar` + `AuthGuard` vía su propio layout)
  - Parámetros agrupados por categoría, con input tipado según el catálogo
    (select para boolean/enum, number con min/max, textarea para el system prompt)
  - Badge por clave con el origen del valor efectivo: `guardado en BD` / `desde .env` /
    `valor por defecto`
  - Botón **Restaurar** (`DELETE`) para borrar el valor de BD y volver a env/default
  - Modo solo lectura si falta `settings:update`; mensaje explícito si el API responde 403
  - Ítem "Configuración" en el sidebar visible solo con `settings:read` **y** tenant de
    sistema activo (`NEXT_PUBLIC_SYSTEM_TENANT_SLUG`)
- [x] **Configuración completa por proveedor de LLM** (pedido 2026-08-03)
  - Cada proveedor con su grupo propio: API key, modelo y host donde aplica
    (`OPENCODEGO_API_URL` era el que faltaba para poder apuntar a un host propio)
  - `OPENAI_BASE_URL` y `OPENROUTER_BASE_URL` para proxies / endpoints compatibles
  - `GET /settings/providers/status`: qué proveedor está activo y qué le falta a cada uno.
    La pantalla avisa *antes* de que falle un mensaje real
- [x] **Secrets cifrados en reposo** — desviación acotada de la spec §5
  - `SecretsCipher` (AES-256-GCM) con clave maestra `SETTINGS_ENCRYPTION_KEY`, solo en env
  - Sin esa variable el backend **rechaza** guardar secrets: no hay fallback a texto plano
  - Solo escritura: `GET` devuelve enmascarado + `isSet`, nunca el valor
  - `AppConfigService.get()` descifra transparente para los consumidores
  - Rotar la clave maestra invalida los secrets guardados (hay que recargarlos)
  - Invgate sigue siendo solo env var
- [x] **Dropdown de modelos consultado a cada proveedor** (`LlmModelsService`)
  - `GET /settings/providers/:provider/models`, con caché en memoria de 5 min y
    `?refresh=true` para saltearla
  - OpenAI / OpenRouter por endpoint compatible `{base}/models`;
    Gemini por `v1beta/models` filtrando los que soportan `generateContent`;
    Claude por `api.anthropic.com/v1/models` con header `anthropic-version`;
    **opencode por `{host}/config/providers`** — no es compatible con OpenAI
  - `requestJson()` valida el `content-type` antes de parsear: las SPAs devuelven HTML
    con status 200 en rutas inexistentes, y sin ese chequeo el error que veía el usuario
    era `Unexpected token '<'`. Ahora dice que la URL apunta a una interfaz web
  - Modelos de opencode como `providerID/modelID` (así los direcciona opencode);
    verificado contra una instancia real: 394 modelos, 383 tras filtrar, 18 de `opencode-go`
  - **El catálogo de OpenRouter es público**: se lista sin cargar la key (~340 modelos)
  - Timeout de 8s y fallback a lista conocida con el motivo del fallo, para que el
    dropdown nunca quede vacío
  - Filtra modelos que no sirven para chat (embeddings, whisper, tts, dall-e, moderation)
  - La UI ofrece "Otro — escribir a mano" y conserva el valor guardado aunque no esté
    en el catálogo, marcado `(actual)`
  - Al entrar solo se consulta el proveedor activo; el resto tiene botón "Buscar modelos"
- [x] **`OpenCodeGoProvider` reimplementado sobre la API de sesiones de opencode** ✅
  - Antes posteaba a `{host}/chat/completions` asumiendo formato OpenAI: esa ruta no
    existe en opencode y su SPA devolvía HTML con 200, así que fallaba al parsear
  - Ahora: `POST /session` → `POST /session/{id}/message` → `DELETE /session/{id}`
  - Body del mensaje: `{ model: {providerID, modelID}, agent, system, parts:[{type:'text',text}] }`
  - **Sesión efímera por consulta**, decisión deliberada: `LlmProvider` es una interfaz
    sin estado. Una sesión por `Conversation` exigiría persistir el `sessionID` (columna
    nueva) y romper la interfaz para los cinco proveedores. El historial ya viaja en cada
    llamada, así que el contexto lo administra nuestro orquestador
  - La respuesta trae partes `step-start` / `reasoning` / `text` / `step-finish`: **solo se
    usan las de tipo `text`**; `reasoning` es razonamiento interno y no debe llegar al usuario
  - `OPENCODEGO_AGENT` nuevo, default **`plan`**. El default de opencode es `build`, que
    ejecuta herramientas sobre la máquina del servidor — inaceptable para un bot que
    atiende usuarios finales
  - La API key pasa a ser **opcional** para este proveedor: un `opencode serve` local no
    autentica. Lo obligatorio es el host
  - **Limitación:** la API de opencode no expone `temperature` ni `maxTokens`, así que esos
    settings no tienen efecto acá. El `systemPrompt` sí
  - Verificado end-to-end contra un servidor real: flujo `start → message → llm_query`
    respondiendo en un solo mensaje con `opencode-go/kimi-k2.6`
  - **Bug encontrado probando el wiring de fuentes de verdad (2026-08-11):**
    `orchestratorLlm` (fallback de menú sin match) no tenía try/catch alrededor de su
    `llmService.chat()` final — un timeout real de OpenCode Go (`REQUEST_TIMEOUT_MS = 120s`
    en `OpenCodeGoProvider`) tiraba una excepción sin capturar hasta `handleMessage`, y el
    usuario se quedaba sin ninguna respuesta (ni siquiera un error). Arreglado con un
    catch que devuelve un mensaje genérico de disculpa. `interpretMenuChoice` (la otra
    llamada LLM del flujo de menú) ya tenía su propio catch — no le pasaba esto
  - **`SIMULATE_TIMEOUT_MS` estaba en 90s, por debajo del propio timeout interno de
    120s de OpenCode Go** que el comentario de al lado ya advertía — expiraba con 504
    antes de que la llamada real pudiera terminar, ni bien ni mal. Subido a 300s para
    cubrir el peor caso real: dos llamadas LLM separadas (`interpretMenuChoice` +
    `orchestratorLlm`) que pueden caer cada una en el timeout de 120s, más hasta ~32s
    si además consulta una fuente de verdad vinculada
- [x] **Los providers dejaron de leer configuración por su cuenta**
  - `LlmProviderFactory` resuelve API key + modelo + baseUrl y los pasa armados
    (`ResolvedProviderConfig`); antes cada provider leía `ConfigService` (solo env),
    así que nada de lo cargado por `/settings` tenía efecto
  - Los providers ya no llevan `@Injectable()`: no los instancia Nest
  - La factory valida antes de instanciar y devuelve un error claro
    ("OpenCode Go necesita el host configurado") en vez de fallar dentro del SDK
- [ ] ⏳ Settings por tenant: hoy imposible porque `Setting.key` es `@unique` global.
      Requiere migrar a `@@unique([key, tenantId])` y ajustar los `findUnique` de
      `AppConfigService` y `LlmProviderFactory`. Se vuelve más urgente con WhatsApp real:
      hoy un solo número de WhatsApp solo puede servir a un tenant (`WHATSAPP_TENANT_ID`)
- [x] **Pestañas en `/settings`** (pedido 2026-08-05) — la página se había vuelto
      interminable: 5 proveedores de LLM + Mensajería apilados verticalmente en una sola
      columna
  - Tablist accesible (WAI-ARIA APG): `role="tablist"/"tab"/"tabpanel"`, `aria-selected`,
    `aria-controls`, roving `tabindex`, navegación con flechas ←→ y Home/End con
    activación automática. Un solo panel montado a la vez, no los 10 grupos ocultos con CSS
  - Cada pestaña muestra un punto de estado (azul = proveedor activo, ámbar = configuración
    incompleta) sin necesidad de entrar
  - Todo el resto de la lógica (modelos por proveedor, secrets enmascarados, restaurar/
    borrar, cascada BD→env→default) quedó intacta — solo cambió el contenedor de layout
  - Verificado en el browser real: las 10 pestañas, navegación por teclado, y que el
    scroll horizontal a 400px de ancho ya era un problema preexistente del layout del
    sidebar (confirmado en `/dashboard/users`, no introducido acá) — fuera de alcance
- [x] **Bug: el dropdown de modelos "solo funcionaba" en el proveedor activo**
  - Al entrar a la página se precargaba la lista de modelos solo del proveedor activo
    (para no hacer una ráfaga de 5 llamadas externas); el resto mostraba un campo de
    texto plano hasta tocar "Buscar modelos" a mano — de un vistazo parecía roto en
    todos los proveedores menos ese
  - Ahora cambiar de pestaña dispara la carga de modelos de ese proveedor automáticamente
    (una vez, cacheada) — el dropdown aparece solo en cualquier pestaña de LLM

---

## Fuentes de verdad (context sources) 🔄 EN PROGRESO (pedido 2026-08-06)

Sistema de suministro de contexto independiente por flujo: cada flujo puede vincularse a
una fuente de verdad externa (MCP remoto, servicio de RAG, proceso n8n, o proceso propio
suscripto a una cola de nuestro RabbitMQ) que administra el backoffice. No se instala ni se
hostea nada de esto — son parámetros de conexión a un servicio que ya corre en otro lado (o,
para `broker`, el nombre de una cola sobre la conexión a RabbitMQ que ya usa el sistema).

### Modelo y administración ✅ COMPLETADO — primera etapa
- [x] Modelo `ContextSource` (Prisma): por tenant (como `Area`), `type` + `config` (Json)
  — `apps/api/prisma/schema.prisma`, migración `20260807023944_add_context_sources`
- [x] Catálogo de tipos y sus campos (`mcp` | `rag` | `n8n` | `broker`), misma idea que
  `settings.catalog.ts` — `apps/api/src/modules/context-sources/context-source-types.catalog.ts`
- [x] Secrets de `config` (API keys, tokens) cifrados con `SecretsCipher` (AES-256-GCM, mismo
  mecanismo que `Setting`), nunca devueltos en claro por la API — enmascarados + `<campo>IsSet`
- [x] CRUD completo con RBAC (`context-sources:read|create|update|delete`) —
  `apps/api/src/modules/context-sources/{context-sources.service,controller,module}.ts`
- [x] "Probar conexión" (`POST /context-sources/:id/test-connection`): un chequeo de
  alcanzabilidad HTTP por tipo, publicado por el broker (RPC RabbitMQ, no HTTP directo) —
  respeta el constraint de AGENTS.md de desacople de I/O externo por broker. Consumer en
  `apps/api/src/modules/context-sources/broker/context-source-connector.service.ts`
- [x] Menú lateral "Fuentes de Verdad" → `/dashboard/context-sources`: listado, alta/edición
  con formulario dinámico por tipo (placeholders de ejemplo, campos secretos enmascarados),
  botón "Probar conexión" — `apps/web/src/app/dashboard/context-sources/page.tsx`
- [x] El editor de flujo (`/dashboard/flows/[id]`) suma un dropdown "fuente de verdad" que
  vincula el flujo a una `ContextSource` del tenant activo (`Flow.contextSourceId`, nullable).
  Convive con el `Flow.context` viejo (enum de 4 valores fijos), que queda deprecado pero sin
  quitar — ver "Deuda técnica pendiente" más abajo

### Ejecución real — 🔄 EN PROGRESO (segunda etapa, pedido 2026-08-11)

- [x] **Wiring en el motor de flujos** (pedido 2026-08-11): cuando la charla se sale del flujo
  armado (`case 'menu'` sin match de opción → modo `__llmFallback`, ver
  `ConversationsService.executeNode`), `orchestratorLlm` consulta la `ContextSource` vinculada
  al `Flow` en curso (`flow.contextSourceId`, threaded desde `executeFlow` a través de
  `executeNode`, se actualiza solo si la charla entra a un `subflow`) y **inyecta la respuesta
  como mensaje de sistema** antes de llamar al LLM — no se le devuelve la respuesta cruda al
  usuario, mismo patrón que el contexto de ticket que ya existía ahí. Sin respuesta útil
  (`ok:false`, timeout, tipo no soportado) sigue sin ese contexto — nunca corta la conversación.
- [x] **Cola dedicada para la consulta real** (`CONTEXT_SOURCE_QUERY_QUEUE =
  'context-source.query'`, separada de `CONTEXT_SOURCE_TEST_QUEUE`): mismo patrón RPC por el
  broker, timeout más generoso (`QUERY_TIMEOUT_MS = 30s` en el connector, `32s` en el wrapper de
  `ContextSourcesService.queryKnowledge`, pensados para una consulta en vivo — no un botón de
  admin) — `apps/api/src/modules/context-sources/broker/context-source-connector.service.ts`
- [x] **Connector real, solo `broker` por ahora** (era el único tipo con contrato probado en
  producción): `ContextSourceConnectorService.queryBroker` publica `{"text": "<pregunta>"}` y
  espera `{answer, error}` — contrato verificado end-to-end contra DonQuijote (el RAG de
  referencia, `responseMode: fixedQueue`). `mcp`/`rag`/`n8n` devuelven `ok:false` con mensaje
  explícito ("consulta en vivo todavía no implementada") en vez de fallar — quedan pendientes:
  - `mcp`: handshake JSON-RPC del protocolo (`initialize` → `tools/list` / `resources/list` →
    invocar), no solo un GET a `serverUrl`
  - `rag`: contrato de request/response del endpoint de consulta es hoy desconocido/genérico
    (no hay un estándar) — probablemente haga falta un campo más en el catálogo para el
    "shape" del request, o aceptar que cada RAG necesita su propio adapter
  - `n8n`: contrato de reachability conocido (webhook), pero no hay definido qué payload
    espera ni qué campo de la respuesta es "la respuesta" — análogo al caso de `rag`
- ⚠️ **Riesgo verificado en producción, no solo teórico**: probando `queryKnowledge` contra
  DonQuijote (`responseMode: fixedQueue`, sin eco de `correlationId` todavía — ver el pedido ya
  hecho al equipo del RAG en la sección de arriba), los dos primeros llamados devolvieron
  `ok:false` con latencia de ~10ms — resultó ser el fallback FIFO (`BrokerService.
  resolveOldestPendingForQueue`) drenando mensajes viejos sin consumir que habían quedado
  atascados en `rag.DonQuijote.out` de sesiones de prueba anteriores, no respuestas a la
  pregunta hecha. El tercer llamado, con la cola ya vacía, expiró a los 15s sin respuesta —
  DonQuijote no estaba escuchando/respondiendo en el momento de la prueba. Conclusión: el
  wiring nuevo funciona (publica, escucha, interpreta, degrada con gracia), pero **una cola de
  respuesta fija sin correlationId acumula basura de sesiones viejas y se la puede atribuir a
  la pregunta equivocada** — mismo motivo por el que ya se le pidió al equipo del RAG que
  implemente el eco de `correlationId` (o, mejor, `replyTo`)
- [x] **Bug de formato encontrado y arreglado (2026-08-11):** DonQuijote devolvía
  siempre `error: "Mensaje vacío: enviá JSON {'text': '...'}"`, incluso mandando
  `{"text": "..."}` — porque viajaba anidado en `data` (`{pattern, data: {text}, ...}`,
  el sobre interno de `BrokerMessage`), no en la raíz del JSON publicado, que es donde
  DonQuijote lo busca. `dispatchBrokerRequest` ahora aplana los campos de `data` también
  en la raíz del mensaje publicado — compatible con un consumidor que lea el sobre
  completo (`data.text`) y con uno que solo lea la raíz (`text`)
- [x] **Segundo bug de formato, encontrado y arreglado (2026-08-11):** el eco de
  `correlationId` del RAG ya funciona (confirmado por el equipo del RAG y verificado acá),
  pero `queryBroker` seguía devolviendo `ok:false` ("sin ningún campo answer") con
  DonQuijote respondiendo bien. Causa: `queryBroker` leía `reply.data.answer`, pero
  DonQuijote no envuelve su respuesta bajo `data` — manda `{rag_id, answer, sources,
  error, correlationId}` en la raíz del JSON (verificado inspeccionando la respuesta cruda
  con `BrokerService.requestViaQueue` directo, sin pasar por el parseo). `reply.data` daba
  `undefined` y la respuesta real, que sí estaba ahí, se descartaba silenciosamente. Mismo
  patrón de bug que el de arriba pero en la dirección opuesta (entrante en vez de
  saliente). Fix: `queryBroker` ahora usa `reply.data` si es un objeto, si no cae a
  `reply` directamente — soporta ambos contratos sin romper a un consumidor que sí
  envuelva bajo `data`
  (`apps/api/src/modules/context-sources/broker/context-source-connector.service.ts`).
  Verificado end-to-end con el servidor real como único consumidor de
  `rag.DonQuijote.out` (sin scripts de diagnóstico compitiendo por la cola): varias
  preguntas distintas devolvieron `ok:true` con respuestas correctas y bien fundamentadas
  (citas de `DonQuijote.txt`, incluso "no tengo esa información" cuando corresponde)
- ⚠️ **Aparte, se confirmó que competir por `rag.DonQuijote.out` rompe las respuestas**:
  RabbitMQ reparte los mensajes de una cola por round-robin entre consumidores, sin mirar
  `correlationId` — si el server real y un script de diagnóstico (u otra instancia del
  backend) consumen la misma `responseQueueName` al mismo tiempo, la respuesta puede
  llegarle al proceso equivocado y el otro expira por timeout. Con `responseMode:
  fixedQueue` **solo puede haber un consumidor activo a la vez** sobre esa cola de
  respuesta — limitación real, no solo teórica, para cualquier escenario con más de una
  instancia del backend corriendo (horizontal scaling). No hay fix de código para esto:
  es inherente al modo `fixedQueue` tal como lo pidió DonQuijote (sin `replyTo` dinámico)
- ⚠️ **Contaminación de historial en charlas ya afectadas por el bug de arriba**: mientras
  el bug de parseo estuvo activo, cada respuesta en una charla que preguntaba algo fuera
  del flujo quedó como un mensaje de asistente con texto tipo "cerremos esta charla y
  empecemos de nuevo" (ver `orchestratorLlm`). Como esa función manda los últimos 10
  mensajes de la charla como historial al LLM, una charla con varios de esos turnos
  rotos sigue arrastrando ese patrón incluso después del fix — no es un bug nuevo,
  es historial ya escrito. Se cura solo: se limpia a los ~10 mensajes nuevos, o al cabo de
  `RESUME_WINDOW_MS` (12h) cuando la charla deja de ser retomable y arranca una nueva con
  historial vacío. Confirmado inyectando el mismo contexto de RAG (con la respuesta
  correcta) con historial limpio vs. historial contaminado: con historial limpio el LLM
  responde bien ("Rocinante."); con el historial real de la charla de prueba, sigue
  devolviendo el texto de "reinicio" — la causa es el historial, no el LLM ni el RAG
- [ ] **Multi-tenant de `Flow.contextSourceId`:** un `Flow` puede estar asignado a varios tenants
  (`TenantFlow`, N:N) pero `ContextSource` es por tenant — hoy el FK es un solo valor global
  del flujo, no por tenant. Si un flujo compartido entre dos empresas necesita una fuente
  distinta por empresa, hace falta una tabla puente (`FlowContextSource` con `tenantId`) en
  vez del FK directo actual. Limitación documentada, no resuelta — mismo patrón que la
  limitación ya conocida de `Setting.key` global (ver AGENTS.md)
- [x] **Consulta al RAG solo cuando hace falta, no en cada turno (pedido 2026-08-11):** antes,
  una vez que una charla entraba en `__llmFallback` con una `contextSourceId` vinculada,
  `orchestratorLlm` consultaba el RAG en **todos** los turnos siguientes — un simple "gracias"
  pagaba los mismos ~10-30s de latencia que una pregunta real. Fix: se prueba responder
  "local" primero (una sola llamada al LLM sin RAG), con una instrucción extra en el prompt
  del orquestador para que, si de verdad necesita la fuente, responda ÚNICAMENTE con un texto
  sentinel exacto (`NECESITA_FUENTE`, ver `NEEDS_SOURCE_SENTINEL` en `conversations.service.ts`).
  Solo si el LLM devuelve ese sentinel se consulta `queryKnowledge` y se reintenta con el
  contexto inyectado — el turno siguiente vuelve a intentar local, no queda "pegado" en modo
  RAG. Mismo patrón de "pedile al LLM un token corto y confiá en él" que ya usan
  `interpretMenuChoice`/`confirmCancelIntent` en este archivo.
  - **Bug encontrado y arreglado en el mismo cambio:** si el LLM recibía el contexto real de
    la fuente y aun así repetía el sentinel textual (visto en producción con el proveedor
    OpenCode Go en modo `plan`), el texto crudo `"NECESITA_FUENTE"` se le mandaba tal cual al
    usuario como respuesta. Ahora, si eso pasa, se le manda directamente la respuesta de la
    fuente en vez del sentinel sin procesar.
- [x] **Historial de charla acotado a la sesión actual (pedido 2026-08-11):** al reanudar una
  charla cerrada dentro de `RESUME_WINDOW_MS` se reutiliza el mismo `Conversation.id` (para no
  perder flujo/ticket en curso), pero eso significaba que `orchestratorLlm` seguía mandándole
  al LLM los últimos 10 `Message` de la charla **sin importar si eran de antes o después del
  cierre** — un historial viejo (a veces con turnos rotos, ver el hallazgo de arriba sobre
  contaminación) se colaba como si fuera la charla actual. Fix: nuevo campo
  `Conversation.sessionStartedAt` (migración `20260811155122_add_session_started_at`), seteado
  al crear la conversación y en cada reanudación desde `closed`; `orchestratorLlm` filtra
  `Message.createdAt >= sessionStartedAt` (con fallback a `createdAt` para filas de antes de
  la migración). Los `Message` viejos no se borran — siguen en la fila para auditoría — solo
  dejan de viajar como contexto del LLM.
- [ ] Falta caché/rate-limit de consultas a la fuente dentro de una misma sesión (si la misma
  pregunta se repite en el mismo turno de fallback, hoy se re-consulta igual)
- 🔴 **Hallazgo crítico, no resuelto — contaminación cruzada en el proveedor OpenCode Go
  (2026-08-11):** probando el fix de arriba contra DonQuijote en vivo, el LLM final (proveedor
  `opencodego`, modelo `opencode-go/minimax-m3`, `agent: 'plan'`) devolvió una respuesta que
  citaba el **"Manual Completo de SOICA" (software de control de accesos)** — un proyecto sin
  ninguna relación con este chatbot ni con DonQuijote — como si fuera el contenido indexado,
  **ignorando por completo** el contexto real que `queryKnowledge` sí había traído
  correctamente de DonQuijote en esa misma llamada (confirmado con logs: hubo una consulta al
  RAG exitosa, sin ningún WARN, pero la respuesta final no usó esa respuesta). Ya se había visto
  una variante de esto antes en la sesión ("modo planificación", mención a un proyecto "WSF,
  firma digital" con notebooks de NotebookLM). Conclusión: el servidor/agente de OpenCode Go
  que estamos usando **no es confiable como fuente de verdad de lo que responde** — parece
  compartir estado o "memoria" con otro proyecto/cuenta no relacionado, algo que ningún cambio
  de prompt de nuestro lado puede arreglar. Esto es un problema de infraestructura/config del
  lado de OpenCode Go, no un bug de este código — pendiente de que alguien con acceso a ese
  servidor investigue si el endpoint/API key está compartido con otro proyecto o hay un bug de
  aislamiento de sesiones ahí. Mientras tanto, cualquier respuesta de este proveedor debería
  tratarse con desconfianza, no solo las que tocan una fuente de verdad.

---

## Hito 4 - Auditoría y Métricas ⏳ PENDIENTE

### Registro estructurado
- [ ] Middleware para loguear cada interacción:
  - timestamp, userId, tenantId, channel, responseTimeMs, resolution
- [ ] Tabla `Metric` poblada automáticamente
- [ ] Endpoints de consulta de métricas (con RBAC)
- [ ] Dashboard básico en Next.js (gráficos de volumen, tiempos de respuesta)

---

## Hito 5 - Go Live ⏳ PENDIENTE

### Canales adicionales
- [x] ~~WhatsApp Business API: webhooks y envío de mensajes~~ — implementado 2026-08-05,
      ver "Conector real de WhatsApp y Email" en el Hito 2. Falta cerrar la firma del
      webhook y verificar el número en la allow-list del sandbox antes de ir a producción
- [ ] Web chat (widget embebible)
- [ ] Email como canal de entrada

### Despliegue
- [ ] Configuración de producción (env vars, secrets)
- [ ] Health checks y monitoreo
- [ ] Pruebas de carga
- [ ] Documentación de deployment

---

## Decisiones técnicas archivadas

| Decisión | Valor | Justificación |
|----------|-------|---------------|
| ORM | Prisma 5.22.0 | Estable, type-safe, soporte NestJS nativo |
| Fingerprint v1 | phone + User-Agent | Decisión fijada en spec §7, no re-litigar |
| OTP TTL default | 300 segundos | Balance seguridad/usabilidad |
| Fingerprint TTL default | 90 días | Solicitado por usuario, configurable desde BD |
| Infra | Externa (192.168.0.123) | PostgreSQL + RabbitMQ en servidor dedicado |
| RBAC | Dinámico (datos, no código) | Roles/permisos creados desde backend, nunca hardcoded |
| LLM | Provider-agnostic | Business logic nunca llama OpenAI/Gemini/Claude directamente |
| Secrets de LLM | BD cifrada + solo escritura | Desvío acotado de spec §5 para configurar proveedores desde el backoffice (2026-08-03) |
| Secrets de Invgate | Env var únicamente | Sin necesidad de configurarlo desde la UI, se mantiene la regla original |
| Tenant activo | Header `X-Tenant-Id`, no JWT | Un usuario pertenece a varios tenants; con el tenant en el token, cambiar de empresa exigía reemitirlo |
| Nombre de usuario | `firstName` + `lastName` | Campos separados, pedido explícito |
| Baja de usuario | Baja del tenant, no borrado físico | Conversaciones, tickets y métricas lo referencian |
| Acceso a `/settings` | Tenant de sistema + `settings:*` | Corte por tenant, no por nombre de rol, para no romper RBAC dinámico |
| Envío saliente de WhatsApp | Solo `type: text` | Ventana de 24hs de Meta; mensajes fuera de ventana necesitan `template` aprobado, no implementado (2026-08-05) |
| Menú sin match en flujos IVR | LLM conversa y recopila datos, no repite el menú | Pedido explícito del usuario; decide autoservicio/ticket cuando existan fuentes de conocimiento definidas (2026-08-05) |
| Credencial de MiniMax | Una sola key para chat y audio (T2A) | MiniMax usa el mismo Bearer token para ambas APIs — no hace falta duplicar el setting (2026-08-05) |
| Fuentes de verdad (`ContextSource`) | Por tenant, FK simple desde `Flow` | Reusable entre flujos de la misma empresa sin duplicar credenciales; el dropdown del editor pidió una relación 1 valor por flujo, no N:N (2026-08-06) |
| I/O de fuentes de verdad | Vía broker (RPC RabbitMQ), no HTTP directo desde el controller | Mismo constraint que WhatsApp: el core no depende de detalles de un canal/integración externa (AGENTS.md, "Desacople de canales") |
| Punto de consulta de la fuente de verdad en el flujo | Fallback `__llmFallback` de `menu` (charla fuera de flujo), no cada `llm_query` | Coincide con el pedido ya cerrado el 2026-08-05 de qué hacer sin match de menú; un `llm_query` explícito ya tiene su propio `systemPrompt` armado a mano (2026-08-11) |

---

## Módulos aún vacíos (stubs)

Están declarados en `app.module.ts` pero son cáscaras `@Module({})` sin service ni controller:

| Módulo | Estado real |
|--------|-------------|
| `invgate/` | Sin implementar. Los tickets se crean solo en la tabla local `Ticket` |
| `metrics/` | Sin implementar. La tabla `Metric` existe pero nada la escribe |
| `devices/` | Vacío — la lógica de fingerprint vive en `auth/device.service.ts` |

---

## Próximo paso inmediato

**Hitos 0-3 completados**, más el motor de flujos IVR, la configuración del sistema
(con pestañas), y un conector real de WhatsApp + Email (probado contra sandbox de Meta).

**Opciones para continuar:**

**A. Auditoría y Métricas**
1. Middleware automático: loguear cada interacción en tabla `Metric`
2. Endpoints `GET /metrics` con filtros por tenant/fecha (con RBAC)
3. Actualizar dashboard de Next.js con datos reales de métricas

**B. Integración Invgate**
1. Pendiente hasta obtener credenciales (`INVGATE_API_URL`, `INVGATE_API_USER`, `INVGATE_API_KEY`)

**C. Menús dinámicos desde backend**
1. API endpoint `/menu` que devuelve estructura de menú según permisos
2. Reemplazar el menú hardcodeado del frontend por este endpoint

**D. Deuda técnica pendiente**
1. Cerrar `POST /conversations/simulate` antes de exponer el API
2. `GET /flows/:id` no filtra por tenant (a diferencia de `findAll`)
3. Búsqueda de tickets con `id: { contains: ... }` en el orquestador LLM: match parcial de
   substring sobre un cuid, puede traer el ticket equivocado
4. Implementar el nodo `webhook` (hoy stub)
5. Webhook de WhatsApp sin verificar `X-Hub-Signature-256` (App Secret de Meta) — cualquiera
   que conozca la URL puede publicar mensajes falsos en `whatsapp.incoming`
6. `WHATSAPP_TENANT_ID` es un solo valor global: un número de WhatsApp = un tenant, hasta
   que existan settings por tenant
7. Sin rate limit de solicitudes de teléfonos desconocidos (no registrados en el tenant):
   hoy `handleMessage` crea un `User`/`Conversation` nuevo por cada mensaje entrante sin
   límite — un número desconocido puede spamear el flujo (y disparar llamadas a LLM/email/
   ticket) sin ninguna contención
8. `Flow.context` (enum viejo de 4 valores fijos) sigue vivo en paralelo a
   `Flow.contextSourceId` (fuente de verdad real) — no se migró ni se sacó del editor.
   Decidir si se termina deprecando del todo una vez que la ejecución real de fuentes de
   verdad esté andando (ver Hito "Fuentes de verdad")

**E. Fuentes de verdad — segunda etapa (ejecución real)**
1. Ver "Fuentes de verdad (context sources)" arriba, sección "Ejecución real — PENDIENTE":
   wiring en `ConversationsService`, connector real por tipo (handshake MCP, contrato de RAG),
   cola RPC dedicada para la consulta en vivo, y la limitación de `Flow.contextSourceId` como
   FK única (no por tenant) si un flujo compartido lo necesita

**F. Audio (STT/TTS) — pedido explícitamente para después**
1. `WHATSAPP_TENANT_ID` (recepción) y `WhatsAppService` (envío) solo manejan `type: text`
   hoy — hace falta extender el webhook para descargar audio de la Media API de Meta y
   `WhatsAppService` para subir y mandar `type: audio`
2. La interfaz `LlmProvider` es puramente texto (`generateCompletion(): Promise<string>`) —
   no tiene lugar para devolver audio; STT/TTS necesitan su propia interfaz, no una extensión
3. MiniMax T2A (`POST /v1/t2a_v2`) ya tiene la credencial cargada (`MINIMAX_API_KEY`, ver
   "Capa de Abstracción LLM") — devuelve el audio en hex o una URL de 24hs, no hay
   proveedor de transcripción (STT) todavía identificado

**Resuelto (2026-08-04):**
- ~~`.env.example` traía `DEVICE_FINGERPRINT_TTL_DAYS=30` mientras el default del código y
  el seed son 90~~ — unificado a 90
- `pnpm run dev:api` fallaba con `Cannot find module '.../dist/main'`: `tsconfig.build.json`
  no excluía `prisma/` del build, así que TypeScript calculaba el `rootDir` común entre
  `src/` y `prisma/` y emitía todo bajo `dist/src/main.js` en vez de `dist/main.js`.
  `prisma/seed.ts` ya corre aparte vía `ts-node` (`db:seed`), así que se agregó `prisma`
  al `exclude` de `tsconfig.build.json` sin tocar nada más

**Resuelto (2026-08-05):**
- ~~`menu` insistía "Opción no válida" en loop~~ — interpretación semántica vía LLM +
  fallback a conversación libre cuando no matchea nada
- ~~El dropdown de modelos "solo funcionaba" en OpenCode Go~~ — era el único proveedor
  precargado al entrar; ahora cualquier pestaña carga sus modelos sola

¿Por cuál seguimos?

---

*Documento vivo: actualizar a medida que se completan tareas.*
