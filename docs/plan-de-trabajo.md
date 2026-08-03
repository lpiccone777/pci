# Plan de Trabajo - Chatbot de Soporte Omnicanal con IA

**Proyecto:** PCI Chatbot  
**Stack:** NestJS (API) + Next.js (Web) + PostgreSQL + RabbitMQ + Prisma  
**Fecha:** Agosto 2026

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

### Capa de Abstracción LLM ✅ COMPLETADO (5 proveedores)
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
- [x] `LlmService` provider-agnostic
  - Merge de config: tenant-specific > env vars > defaults
  - Inyecta `systemPrompt` automáticamente si no está en los mensajes
- [x] **Selector dinámico de proveedor** (`LlmProviderFactory`)
  - Lee `LLM_PROVIDER` de BD (Setting) primero, fallback a env var
  - Soporta: `openai`, `gemini`, `claude`, `openrouter`, `opencodego`
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
- [x] Endpoint `POST /conversations/simulate` — testing sin RabbitMQ
- [x] Flujo completo end-to-end: mensaje → usuario → conversación → LLM/ticket → respuesta

---

## Hito 3 - Multitenant y Menús ⏳ PENDIENTE

### Aislamiento de datos ✅ COMPLETADO
- [x] `TenantInterceptor` global
  - Lee `tenantId` del JWT payload
  - Valida que el usuario pertenezca al tenant (`UserTenant`)
  - Inyecta `tenantId` y `userTenant` en `request` para downstream
- [x] `@CurrentTenant()` decorator
  - Extrae `tenantId` del request de forma tipada
  - Usado en todos los controladores CRUD (`roles`, `users`, `tenants`)
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
- [x] Páginas CRUD protegidas por RBAC:
  - `/dashboard/users` — listado + crear usuarios
  - `/dashboard/roles` — listado + crear roles + agregar permisos
  - `/dashboard/tenants` — listado + crear tenants
- [x] Dashboard home con cards de resumen y permisos del usuario
- [x] API client (`lib/api.ts`) con interceptación de JWT
- [x] Endpoints del API creados: `GET /users`, `GET/POST /tenants`

### Menús dinámicos desde backend ⏳ PENDIENTE
- [ ] API endpoint: `/menu` que devuelve menús según permisos del rol
- [ ] Estructura de menú configurable desde backend (no hardcoded)

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
- [ ] WhatsApp Business API: webhooks y envío de mensajes
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
| Secrets | Env vars / BD Setting | Nunca commiteados |

---

## Próximo paso inmediato

**Hitos 0-3 completados en su totalidad.**

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

¿Por cuál seguimos?

---

*Documento vivo: actualizar a medida que se completan tareas.*
