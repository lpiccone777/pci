# Graph Report - .  (2026-08-06)

## Corpus Check
- 18 files · ~50,138 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1135 nodes · 2354 edges · 70 communities (57 shown, 13 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 181 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Abstracción de proveedores LLM|Abstracción de proveedores LLM]]
- [[_COMMUNITY_Auth Service (login, OTP)|Auth Service (login, OTP)]]
- [[_COMMUNITY_Device Fingerprint y Email SMTP|Device Fingerprint y Email SMTP]]
- [[_COMMUNITY_Módulos NestJS (configsettingsdevices)|Módulos NestJS (config/settings/devices)]]
- [[_COMMUNITY_Secrets e Invgate (constraints)|Secrets e Invgate (constraints)]]
- [[_COMMUNITY_Conversations Controller y Broker|Conversations Controller y Broker]]
- [[_COMMUNITY_Layout y Auth Guard del frontend|Layout y Auth Guard del frontend]]
- [[_COMMUNITY_Reconocimiento de usuario en el flujo|Reconocimiento de usuario en el flujo]]
- [[_COMMUNITY_Seed y catálogo de Settings|Seed y catálogo de Settings]]
- [[_COMMUNITY_Editor de aristas del flujo (ReactFlow)|Editor de aristas del flujo (ReactFlow)]]
- [[_COMMUNITY_Motor de flujos cancelación e interpretación|Motor de flujos: cancelación e interpretación]]
- [[_COMMUNITY_DTOs del módulo Flow|DTOs del módulo Flow]]
- [[_COMMUNITY_Config ESLintNext (web)|Config ESLint/Next (web)]]
- [[_COMMUNITY_Dependencias ESLint (dev)|Dependencias ESLint (dev)]]
- [[_COMMUNITY_tsconfig del backend|tsconfig del backend]]
- [[_COMMUNITY_Dependencias npm del backend|Dependencias npm del backend]]
- [[_COMMUNITY_Frontend Next.js y multitenant|Frontend Next.js y multitenant]]
- [[_COMMUNITY_tsconfig del frontend|tsconfig del frontend]]
- [[_COMMUNITY_RBAC dinámico y guards de settings|RBAC dinámico y guards de settings]]
- [[_COMMUNITY_CurrentTenant y RequirePermission|CurrentTenant y RequirePermission]]
- [[_COMMUNITY_AGENTS.md y convenciones del repo|AGENTS.md y convenciones del repo]]
- [[_COMMUNITY_Broker RPC colas y bugs resueltos|Broker RPC: colas y bugs resueltos]]
- [[_COMMUNITY_Arquitectura general del sistema|Arquitectura general del sistema]]
- [[_COMMUNITY_Desacople de canales por broker|Desacople de canales por broker]]
- [[_COMMUNITY_Motor de flujos encadenado y espera|Motor de flujos: encadenado y espera]]
- [[_COMMUNITY_RBAC y menús dinámicos|RBAC y menús dinámicos]]
- [[_COMMUNITY_Orquestador de conversaciones (deuda técnica)|Orquestador de conversaciones (deuda técnica)]]
- [[_COMMUNITY_Scripts npm del monorepo|Scripts npm del monorepo]]
- [[_COMMUNITY_BrokerService (conexión RabbitMQ)|BrokerService (conexión RabbitMQ)]]
- [[_COMMUNITY_Decisión de broker RabbitMQ|Decisión de broker: RabbitMQ]]
- [[_COMMUNITY_Convenciones del monorepo|Convenciones del monorepo]]
- [[_COMMUNITY_Constraints de Invgate y motor IVR|Constraints de Invgate y motor IVR]]
- [[_COMMUNITY_Cadena de guards y resolución de tenant|Cadena de guards y resolución de tenant]]
- [[_COMMUNITY_Constraints de canales e Invgate|Constraints de canales e Invgate]]
- [[_COMMUNITY_Aislamiento multitenant|Aislamiento multitenant]]
- [[_COMMUNITY_Editor visual de flujos (ReactFlow)|Editor visual de flujos (ReactFlow)]]
- [[_COMMUNITY_Convenciones de nomenclatura backend|Convenciones de nomenclatura backend]]
- [[_COMMUNITY_Flujo activo por tenant (TenantFlow)|Flujo activo por tenant (TenantFlow)]]
- [[_COMMUNITY_Guards de seguridad y secrets|Guards de seguridad y secrets]]
- [[_COMMUNITY_Entidades del dominio (Prisma)|Entidades del dominio (Prisma)]]
- [[_COMMUNITY_Resolución de tenant (X-Tenant-Id)|Resolución de tenant (X-Tenant-Id)]]
- [[_COMMUNITY_Módulo Channels (WhatsApp)|Módulo Channels (WhatsApp)]]
- [[_COMMUNITY_Estado del repo e infraestructura|Estado del repo e infraestructura]]
- [[_COMMUNITY_Metadata de package.json|Metadata de package.json]]
- [[_COMMUNITY_Config de Jest (tests)|Config de Jest (tests)]]
- [[_COMMUNITY_Checklist de cierre de tarea (graphify)|Checklist de cierre de tarea (graphify)]]
- [[_COMMUNITY_Motor de flujos IVR (13 tipos de nodo)|Motor de flujos IVR (13 tipos de nodo)]]
- [[_COMMUNITY_Scripts del monorepo raíz|Scripts del monorepo raíz]]
- [[_COMMUNITY_Config Jest e2e|Config Jest e2e]]
- [[_COMMUNITY_nest-cli.json|nest-cli.json]]
- [[_COMMUNITY_tsconfig y permisos locales|tsconfig y permisos locales]]
- [[_COMMUNITY_Migración split firstNamelastName|Migración split firstName/lastName]]
- [[_COMMUNITY_README del backend|README del backend]]
- [[_COMMUNITY_tsconfig.build.json|tsconfig.build.json]]
- [[_COMMUNITY_Device entity (fingerprint v1)|Device entity (fingerprint v1)]]
- [[_COMMUNITY_postcss.config.mjs|postcss.config.mjs]]
- [[_COMMUNITY_Convención de nomenclatura backend|Convención de nomenclatura backend]]
- [[_COMMUNITY_Modelo de datos inicial|Modelo de datos inicial]]
- [[_COMMUNITY_Convención de idioma español|Convención de idioma: español]]
- [[_COMMUNITY_API client (libapi.ts)|API client (lib/api.ts)]]
- [[_COMMUNITY_LlmProvider interface|LlmProvider interface]]
- [[_COMMUNITY_Message entity|Message entity]]
- [[_COMMUNITY_Setting entity|Setting entity]]
- [[_COMMUNITY_Usuario técnico dedicado de Invgate|Usuario técnico dedicado de Invgate]]
- [[_COMMUNITY_OTP 2FA por email|OTP 2FA por email]]
- [[_COMMUNITY_OTP 2FA por SMS (futuro)|OTP 2FA por SMS (futuro)]]

## God Nodes (most connected - your core abstractions)
1. `ConversationsService.executeNode` - 52 edges
2. `AppConfigService` - 38 edges
3. `LlmProviderFactory` - 35 edges
4. `ConversationsService (orquestador core)` - 35 edges
5. `OpenCodeGoProvider` - 31 edges
6. `Plan de Trabajo (documento vivo)` - 27 edges
7. `SettingsService` - 27 edges
8. `SettingsModule (CRUD sobre la tabla Setting)` - 26 edges
9. `AGENTS.md — convenciones y constraints para agentes` - 26 edges
10. `Hito 3 - Multitenant y Menús` - 26 edges

## Surprising Connections (you probably didn't know these)
- `Limitación conocida: Setting.key es @unique global` --semantically_similar_to--> `Limitación: settings globales por Setting.key @unique`  [INFERRED] [semantically similar]
  AGENTS.md → README.md
- `Regla del proyecto: /graphify . --update en el plan` --semantically_similar_to--> `Ante todo cambio, actualizá el grafo (README)`  [INFERRED] [semantically similar]
  docs/plan-de-trabajo.md → README.md
- `settings.catalog.ts (catalogo de claves permitidas)` --semantically_similar_to--> `Motor de flujos conversacionales IVR (executeFlow)`  [INFERRED] [semantically similar]
  AGENTS.md → docs/plan-de-trabajo.md
- `Autenticacion y OTP 2FA por email` --semantically_similar_to--> `Constraint: abstracción LLM vía LlmService`  [INFERRED] [semantically similar]
  docs/plan-de-trabajo.md → AGENTS.md
- `SystemTenantGuard` --semantically_similar_to--> `TenantInterceptor global y @CurrentTenant()`  [INFERRED] [semantically similar]
  AGENTS.md → docs/plan-de-trabajo.md

## Import Cycles
- None detected.

## Communities (70 total, 13 thin omitted)

### Community 0 - "Abstracción de proveedores LLM"
Cohesion: 0.06
Nodes (66): Abstracción LLM (LlmService, provider-agnostic), requestJson() valida content-type antes de parsear, Constraint: abstracción LLM vía LlmService, Constraint de abstraccion LLM: la logica de negocio nunca llama al SDK del proveedor, LlmModelsService (dropdown de modelos por proveedor), LlmProviderFactory / ResolvedProviderConfig, OpenCodeGoProvider (API de sesiones de opencode), OPENCODEGO_AGENT (default plan) (+58 more)

### Community 1 - "Auth Service (login, OTP)"
Cohesion: 0.05
Nodes (8): OTP_ENABLED, AppConfigService, OtpEntry, CreatePermissionDto, CreateRoleDto, UpdateRoleDto, RolePermission (modelo), RoleService

### Community 2 - "Device Fingerprint y Email SMTP"
Cohesion: 0.06
Nodes (52): Device fingerprint v1 (telefono + User-Agent), OTP_ENABLED (reemplazo del bypass hardcodeado de desarrollo), apps/api package.json, AuthModule, EmailMessage, AuthModule, Device (modelo, fingerprint), auth/device.service.ts (+44 more)

### Community 3 - "Módulos NestJS (config/settings/devices)"
Cohesion: 0.07
Nodes (10): UpdateSettingDto, UpsertSettingDto, FALLBACK_MODELS, LlmModelsService, ModelListResult, NON_CHAT_PATTERNS, LlmModule, LlmModelsService (+2 more)

### Community 4 - "Secrets e Invgate (constraints)"
Cohesion: 0.07
Nodes (50): Politica Invgate: usuario tecnico dedicado, Limitación conocida: Setting.key es @unique global, Constraint de secrets: nunca commiteados ni devueltos en texto plano, Constraint: secrets solo por env vars / vault, SecretsCipher AES-256-GCM (src/config/secrets.cipher.ts), Limitacion: Setting.key es @unique global (settings no son por tenant), Tabla Setting, Limitacion: Setting.key es @unique global (+42 more)

### Community 5 - "Conversations Controller y Broker"
Cohesion: 0.09
Nodes (8): BrokerMessage, NodeExecutionResult, ConversationsService.executeNode, publish({assert:false}) (bug: reassert de cola exclusive), Cola de respuesta con nombre propio (whatsapp.rpc.reply.<uuid>), safeAck/safeNack (bug: excepción sincrónica en canal cerrado), /conversations/simulate vía RabbitMQ RPC, BrokerModule / BrokerService

### Community 6 - "Layout y Auth Guard del frontend"
Cohesion: 0.09
Nodes (22): AuthGuard(), menuDefinition, MenuItem, Sidebar(), DashboardPage(), Flow, AuthContext, AuthProvider() (+14 more)

### Community 7 - "Reconocimiento de usuario en el flujo"
Cohesion: 0.08
Nodes (17): "Conocido" en el motor de flujos, executeNode (case 'start'), findOrCreateByPhone, ConversationsService.handleMessage, Split de User.name en firstName/lastName, prisma/seed.ts (seed idempotente), Modelo Tenant, Modelo User (+9 more)

### Community 8 - "Seed y catálogo de Settings"
Cohesion: 0.11
Nodes (19): ProviderName, prisma, Setting (tabla), settings.catalog.ts, ModelList, ProviderStatus, Setting, SettingsPage() (+11 more)

### Community 9 - "Editor de aristas del flujo (ReactFlow)"
Cohesion: 0.10
Nodes (23): DeletableEdge, ConditionNode, DelayNode, DeviceValidationNode, EndNode, InputNode, LlmQueryNode, MenuNode (+15 more)

### Community 10 - "Motor de flujos: cancelación e interpretación"
Cohesion: 0.08
Nodes (20): ConversationsService.cancelInteraction, ConversationsService.confirmCancelIntent, ConversationsService.executeFlow, ConversationsService.executeNode, ConversationsService.handleMessage, ConversationsService.interpretMenuChoice, flowState.__llmFallback sentinel, ConversationsService.looksLikeCancelAttempt (+12 more)

### Community 11 - "DTOs del módulo Flow"
Cohesion: 0.12
Nodes (6): AssignTenantsDto, UpdateFlowDto, FlowNodeDataDto, FlowNodeDto, FLOW_CONTEXT_OPTIONS, FLOW_CONTEXT_VALUES

### Community 12 - "Config ESLint/Next (web)"
Cohesion: 0.08
Nodes (23): dependencies, next, react, react-dom, @xyflow/react, devDependencies, eslint, @tailwindcss/postcss (+15 more)

### Community 13 - "Dependencias ESLint (dev)"
Cohesion: 0.08
Nodes (25): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, @nestjs/cli (+17 more)

### Community 14 - "tsconfig del backend"
Cohesion: 0.09
Nodes (22): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+14 more)

### Community 15 - "Dependencias npm del backend"
Cohesion: 0.10
Nodes (20): dependencies, amqplib, @anthropic-ai/sdk, bcrypt, class-transformer, class-validator, @google/generative-ai, @nestjs/common (+12 more)

### Community 16 - "Frontend Next.js y multitenant"
Cohesion: 0.13
Nodes (20): apiFetch (frontend), apps/web (Next.js 16 + React 19 + Tailwind 4), Baja de usuario = baja del tenant, CORS con allowedHeaders explícito, @CurrentTenant(), Hito 3 - Multitenant y Menus, JwtAuthGuard / JWT Strategy, Metric (auditoría) (+12 more)

### Community 17 - "tsconfig del frontend"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 18 - "RBAC dinámico y guards de settings"
Cohesion: 0.18
Nodes (17): Constraint: RBAC dinámico (datos, no código), Decision cerrada: device fingerprint v1 = telefono + User-Agent, Doble candado de acceso a /settings (tenant de sistema + permiso), Constraint RBAC dinamico: roles y permisos son datos, no codigo, @RequirePermission(resource, action), GET /auth/me, PermissionMetadata, Autenticación y 2FA por OTP email (+9 more)

### Community 19 - "CurrentTenant y RequirePermission"
Cohesion: 0.17
Nodes (4): @CurrentTenant() decorator, CurrentTenant, SystemTenantGuard, SystemTenantGuard

### Community 20 - "AGENTS.md y convenciones del repo"
Cohesion: 0.15
Nodes (17): AGENTS.md — convenciones y constraints para agentes, Regla: actualizar el grafo ante todo cambio, graphify-out/ (grafo de conocimiento del codebase), Invgate (usuario técnico dedicado), Monorepo pnpm workspaces, apps/api (NestJS 11 + Prisma 5.22 + PostgreSQL), apps/web (Next.js 16 + React 19 + Tailwind 4), AGENTS.md — convenciones y constraints para agentes (+9 more)

### Community 21 - "Broker RPC: colas y bugs resueltos"
Cohesion: 0.19
Nodes (17): Bug: colas anónimas amq.gen-*, BrokerService.request() — patrón RPC, BrokerService.request, ensureReplyConsumer, Bug: publish() y cola exclusive (405 RESOURCE_LOCKED), safeAck / safeNack, BrokerService.publish, apps/api/scripts/chat.mjs (+9 more)

### Community 22 - "Arquitectura general del sistema"
Cohesion: 0.15
Nodes (16): 2FA Mail/SMS, docs/chatbot.md, Next.js frontend, Orquestador NestJS, PostgreSQL, RabbitMQ broker, RBAC Dinámico, Soporte Omnicanal con IA (+8 more)

### Community 23 - "Desacople de canales por broker"
Cohesion: 0.14
Nodes (16): Desacople de canales vía broker, AGENTS.md, Desacople de canales, Email como canal de entrada, Hito 4 - Auditoria y Metricas (pendiente), Tabla Metric, Módulo metrics/ (stub), Auditoria y metricas - pendiente (+8 more)

### Community 24 - "Motor de flujos: encadenado y espera"
Cohesion: 0.13
Nodes (16): Sesión efímera por consulta en OpenCode Go, Bloqueante: OpenCodeGoProvider no puede hablar con opencode, chat.mjs (chat interactivo por consola), Modelo Conversation, Encadenamiento de nodos no interactivos (MAX_FLOW_STEPS), menu e input con espera en dos fases (waitForInput), Modelo Flow, FlowModule (CRUD /flows) (+8 more)

### Community 25 - "RBAC y menús dinámicos"
Cohesion: 0.20
Nodes (16): Constraint: RBAC dinámico (roles y permisos como datos), Módulo de Menús Dinámicos, GET /auth/me endpoint, AuthContext / useAuth, Hito 1 — Core de Seguridad (auth, OTP 2FA, RBAC), Menús dinámicos desde backend (endpoint /menu, pendiente), Panel Admin Next.js (AuthContext, sidebar dinamico, CRUDs), @RequirePermission(resource, action) (+8 more)

### Community 26 - "Orquestador de conversaciones (deuda técnica)"
Cohesion: 0.17
Nodes (16): Deuda técnica pendiente, FlowService.applyTenantAssignment, ConversationsService - orquestador core de mensajes, POST /conversations/simulate (deuda de seguridad aceptada), findActiveFlowForTenant: ambigüedad resuelta con isStart, Encadenamiento de nodos no interactivos (executeFlow), Hito 2 — Lógica de Negocio (broker, LLM, conversaciones, IVR), llm_query terminal ya no resetea el flujo (+8 more)

### Community 27 - "Scripts npm del monorepo"
Cohesion: 0.13
Nodes (15): scripts, build, chat, db:seed, format, lint, start, start:debug (+7 more)

### Community 29 - "Decisión de broker: RabbitMQ"
Cohesion: 0.16
Nodes (14): Broker: RabbitMQ elegido sobre LavinMQ, Constraint: desacople de canales por broker, Decisión cerrada: RabbitMQ como broker, RabbitMQ (broker elegido), BrokerMessage (pattern, data, tenantId, timestamp), BrokerModule / BrokerService (RabbitMQ via amqplib), Cola whatsapp.incoming, Cola whatsapp.outgoing (+6 more)

### Community 30 - "Convenciones del monorepo"
Cohesion: 0.19
Nodes (13): Convención de idioma: español, Invgate vía usuario técnico de API, Grafo de conocimiento graphify (graphify-out/), Monorepo pnpm workspaces (apps/api + apps/web), Prisma como ORM, Monorepo pnpm apps/api + apps/web, Secrets cifrados en la tabla Setting (desviación de spec §5), Especificación completa del proyecto (chatbot.md) (+5 more)

### Community 31 - "Constraints de Invgate y motor IVR"
Cohesion: 0.21
Nodes (13): Constraint: Invgate vía usuario técnico dedicado, BrokerModule / BrokerService sobre RabbitMQ, Capa de abstracción LLM con 5 proveedores, invgate/ (módulo vacío), Módulo invgate/ (stub), Motor de flujos conversacionales IVR (13 tipos de nodo), Orquestador core de conversaciones (ConversationsService), Hito 2 - Lógica de Negocio (+5 more)

### Community 32 - "Cadena de guards y resolución de tenant"
Cohesion: 0.26
Nodes (11): apiFetch del frontend (lib/api.ts), Cadena de guards @UseGuards(JwtAuthGuard, TenantGuard, RolesGuard), Orden fijo de guards: JwtAuthGuard, TenantGuard, RolesGuard, JwtAuthGuard, ORM: Prisma, Resolución del tenant por header X-Tenant-Id, TenantGuard (valida pertenencia contra UserTenant), Decisiones técnicas archivadas (tabla) (+3 more)

### Community 33 - "Constraints de canales e Invgate"
Cohesion: 0.18
Nodes (12): Constraint de desacople de canales: todo I/O de canal por el broker, Constraint Invgate: operaciones con usuario tecnico de API, Decision de broker: RabbitMQ (elegido sobre LavinMQ), BrokerMessage, BrokerService (RabbitMQ, colas persistentes, reconexión), ChannelsService (wrapper de publicacion a canales), Hito 2 - Logica de Negocio (en progreso), Infraestructura externa (192.168.0.123) (+4 more)

### Community 34 - "Aislamiento multitenant"
Cohesion: 0.18
Nodes (12): Constraint multitenant: aislamiento obligatorio por Tenant ID, Resolución del tenant vía header X-Tenant-Id (no en el JWT), Tenant activo por header X-Tenant-Id, Migración manual 20260803120000_split_user_name, Tenant activo vía header X-Tenant-Id, no JWT, Servicios tenant-scoped (RoleService, UsersService, TenantsService), apiFetch (lib/api.ts) — cliente HTTP con JWT y X-Tenant-Id, apiFetch: cliente HTTP que inyecta JWT y X-Tenant-Id (+4 more)

### Community 35 - "Editor visual de flujos (ReactFlow)"
Cohesion: 0.27
Nodes (12): DeletableEdge, flow-edges.tsx, FlowEdgeDto.type, Nodo start, Editor visual de flujos con ReactFlow (/dashboard/flows), Saneo del payload de ReactFlow al guardar, ValidationPipe global (whitelist, forbidNonWhitelisted, transform), ValidationPipe global (+4 more)

### Community 36 - "Convenciones de nomenclatura backend"
Cohesion: 0.27
Nodes (11): Convención de nomenclatura de módulos backend, Nomenclatura backend src/modules/<dominio>/, Decisión cerrada: Prisma como ORM, Hito 0 - Setup (completado), Seed idempotente (tenant Sistema PCI, SuperAdmin, settings), apps/api - Backend NestJS + Prisma + PostgreSQL, apps/web - Frontend Next.js + React + Tailwind, Estructura del proyecto pci-chatbot (+3 more)

### Community 37 - "Flujo activo por tenant (TenantFlow)"
Cohesion: 0.24
Nodes (11): findActiveFlowForTenant, Flow.isDefault, FlowService.applyTenantAssignment, TenantFlow.isStart, flow-context.ts (FLOW_CONTEXT_OPTIONS), Campo context (flujo IVR), Modelo Flow / TenantFlow, flow-nodes.tsx (+3 more)

### Community 38 - "Guards de seguridad y secrets"
Cohesion: 0.20
Nodes (9): Secrets (manejo de credenciales), Decisiones técnicas archivadas, Cadena de guards JwtAuthGuard, TenantGuard, RolesGuard, Multitenant por tenantId, Limitacion: Setting.key unique global impide settings por tenant, SystemTenantGuard — acceso solo superusuario a /settings, TenantGuard y header X-Tenant-Id, TenantGuard (+1 more)

### Community 39 - "Entidades del dominio (Prisma)"
Cohesion: 0.18
Nodes (11): API de Invgate, Módulo de Métricas y Auditoría, Módulo Multitenant, Conversation entity, Metric entity, Tenant entity, Ticket entity, User entity (+3 more)

### Community 40 - "Resolución de tenant (X-Tenant-Id)"
Cohesion: 0.33
Nodes (10): Constraint: aislamiento multitenant por Tenant ID, Resolución del tenant (X-Tenant-Id), Limitación: Setting.key único global, TenantGuard (src/common/guards/tenant.guard.ts), apiFetch (lib/api.ts), @CurrentTenant(), Aislamiento de datos por tenant (TenantInterceptor + @CurrentTenant), Hito 3 - Multitenant y Menús (+2 more)

### Community 41 - "Módulo Channels (WhatsApp)"
Cohesion: 0.22
Nodes (7): BrokerModule, ChannelsService, Conector WhatsApp, whatsapp.incoming queue, whatsapp.outgoing queue, Channel decoupling via broker, WhatsApp Business API

### Community 42 - "Estado del repo e infraestructura"
Cohesion: 0.22
Nodes (9): docs/chatbot.md (spec original), Infra externa PostgreSQL/RabbitMQ (192.168.0.123), Estado del repo, apps/api (NestJS + Prisma + PostgreSQL), graphify-out/graph.html, graphify-out/GRAPH_REPORT.md, graphify-out/ (grafo de conocimiento), docs/plan-de-trabajo.md (+1 more)

### Community 43 - "Metadata de package.json"
Cohesion: 0.22
Nodes (8): author, description, license, name, prisma, seed, private, version

### Community 44 - "Config de Jest (tests)"
Cohesion: 0.22
Nodes (9): jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, testEnvironment, testRegex, transform (+1 more)

### Community 45 - "Checklist de cierre de tarea (graphify)"
Cohesion: 0.36
Nodes (8): Checklist de cierre de tarea (build, plan, graphify, commit), Checklist de cierre de tarea, Grafo de conocimiento graphify del codebase, Regla obligatoria: actualizar el grafo ante todo cambio, graphify (CLI de grafo de conocimiento), Flujo de contribucion (rama, lint/test, plan, grafo, PR), Regla del README: actualizar el grafo ante todo cambio, Ante todo cambio, actualizá el grafo (README)

### Community 46 - "Motor de flujos IVR (13 tipos de nodo)"
Cohesion: 0.25
Nodes (8): Constraint: Invgate con usuario técnico de API, Editor visual de flujos con ReactFlow, Motor de flujos conversacionales IVR (executeFlow), 13 tipos de nodo de flujo (start, menu, ticket_create, llm_query…), Integración Invgate pendiente (falta de credenciales), Deuda: POST /conversations/simulate sin guard de autenticacion, Deuda tecnica pendiente, Convenciones importantes del proyecto (README)

### Community 47 - "Scripts del monorepo raíz"
Cohesion: 0.29
Nodes (6): name, private, scripts, build, dev:api, dev:web

### Community 48 - "Config Jest e2e"
Cohesion: 0.29
Nodes (6): moduleFileExtensions, rootDir, testEnvironment, testRegex, transform, ^.+\\.(t|j)s$

### Community 49 - "nest-cli.json"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 50 - "tsconfig y permisos locales"
Cohesion: 0.40
Nodes (4): API TypeScript Build Config (tsconfig.build.json), API Base TypeScript Config (tsconfig.json), permissions, allow

### Community 51 - "Migración split firstName/lastName"
Cohesion: 0.50
Nodes (5): Tabla de decisiones tecnicas archivadas, Migración 20260803120000_split_user_name, Migracion 20260803120000_split_user_name (firstName / lastName), Baja de usuario = baja del tenant, no borrado físico, Gestión de usuarios del tenant activo (/dashboard/users)

### Community 52 - "README del backend"
Cohesion: 0.50
Nodes (4): apps/api/README.md, NestJS framework, NestJS backend, NestJS backend

### Community 54 - "Device entity (fingerprint v1)"
Cohesion: 1.00
Nodes (3): Fingerprint de dispositivo, Device entity, Device fingerprint v1 = phone + User-Agent only

## Ambiguous Edges - Review These
- `Constraint: secrets solo por env vars / vault` → `Convencion (desactualizada): secrets solo por env var`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `Catálogo de claves editables (settings.catalog.ts)` → `Secrets cifrados en reposo (AES-256-GCM)`  [AMBIGUOUS]
  docs/plan-de-trabajo.md · relation: conceptually_related_to
- `POST /conversations/simulate sin guard de autenticación` → `opencode no es compatible con OpenAI`  [AMBIGUOUS]
  docs/plan-de-trabajo.md · relation: semantically_similar_to
- `Constraint de secrets: nunca commiteados ni devueltos en texto plano` → `Convencion (seccion Convenciones): API keys solo por env var, nunca en Setting`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `Convencion (seccion Convenciones): API keys solo por env var, nunca en Setting` → `Manejo de API keys como secrets cifrados (desviacion de spec 5)`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `Baja de usuario sin borrado físico` → `Hito 4 - Auditoría y Métricas`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to

## Knowledge Gaps
- **277 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+272 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Constraint: secrets solo por env vars / vault` and `Convencion (desactualizada): secrets solo por env var`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Catálogo de claves editables (settings.catalog.ts)` and `Secrets cifrados en reposo (AES-256-GCM)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `POST /conversations/simulate sin guard de autenticación` and `opencode no es compatible con OpenAI`?**
  _Edge tagged AMBIGUOUS (relation: semantically_similar_to) - confidence is low._
- **What is the exact relationship between `Constraint de secrets: nunca commiteados ni devueltos en texto plano` and `Convencion (seccion Convenciones): API keys solo por env var, nunca en Setting`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Convencion (seccion Convenciones): API keys solo por env var, nunca en Setting` and `Manejo de API keys como secrets cifrados (desviacion de spec 5)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Baja de usuario sin borrado físico` and `Hito 4 - Auditoría y Métricas`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `ConversationsService.executeNode` connect `Conversations Controller y Broker` to `Abstracción de proveedores LLM`, `Constraints de canales e Invgate`, `Auth Service (login, OTP)`, `Módulos NestJS (config/settings/devices)`, `Device Fingerprint y Email SMTP`, `Reconocimiento de usuario en el flujo`, `DTOs del módulo Flow`, `Arquitectura general del sistema`, `Motor de flujos: encadenado y espera`, `Orquestador de conversaciones (deuda técnica)`, `BrokerService (conexión RabbitMQ)`, `Constraints de Invgate y motor IVR`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._