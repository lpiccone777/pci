# AGENTS.md

## Repo state

Greenfield. The only file is `docs/chatbot.md` — the project spec (in Spanish) and the **source of truth** for scope and architecture. There is no scaffold, no `package.json`, no commands yet. Do not assume scripts exist; check the actual manifests before running or citing any command.

## Planned stack and layout (confirmed conventions)

- pnpm workspaces monorepo: `apps/api` (NestJS backend) + `apps/web` (Next.js frontend)
- PostgreSQL, RabbitMQ (decided over LavinMQ), external LLM providers, Invgate API for tickets
- First channel: WhatsApp Business API. OTP 2FA via email first, SMS later

## Locked decisions (spec §7 — do not re-litigate)

- Device fingerprint v1 = **phone + User-Agent only**
- Initial data model tables: Users, Tenants, Roles, Permissions, Devices, Conversations, Tickets, Metrics

## Constraints that are easy to violate — honor them in all generated code

- **Multitenant:** data isolation by Tenant ID is mandatory at the DB level; every query must be tenant-scoped. A user may belong to multiple tenants.
- **RBAC is dynamic:** roles and permissions are data created from the backend, not code. Never hardcode role enums or permission checks against fixed role names; frontend menus/buttons are driven by the role's permission list.
- **LLM abstraction:** business logic must never call a provider SDK (OpenAI/Gemini/Claude) directly — go through the provider-agnostic layer. Temperature, max tokens, system prompt, and provider are configurable per tenant or per endpoint.
- **Channel decoupling:** the core orchestrator must not depend on WhatsApp specifics. All channel I/O flows through the broker (RabbitMQ, persistent queues).
- **Invgate:** ticket create/read/update goes through a dedicated technical API user, not end-user credentials.
- **Secrets:** LLM and Invgate API keys only via env vars / vault — never committed.

## Language

Spec, docs, and user-facing communication are in **Spanish**.

## Graphify Knowledge Graph

This project has a navigable knowledge graph in `graphify-out/`.

- **Interactive visualization:** `graphify-out/graph.html` — open in any browser
- **Audit report:** `graphify-out/GRAPH_REPORT.md` — community analysis with 43 labeled communities
- **Raw graph data:** `graphify-out/graph.json` — 503 nodes, 792 edges, GraphRAG-ready

### For future agents

When answering questions about codebase architecture, file relationships, or project content, check `graphify-out/graph.json` first. If it exists and the question is about the codebase (not a rebuild command), skip detection/extraction and query the existing graph directly via `graphify query "<question>"` or inline NetworkX traversal.

The graph was built with these community labels (largest first):
1. **Messaging & Conversations** (58 nodes) — Broker, Channels, Conversations, Users, LLM module
2. **RBAC & Authorization** (47 nodes) — Roles, Permissions, Guards, Decorators, Tenant interceptor
3. **Auth & Config** (44 nodes) — Auth controller/service, DTOs, Device service, Prisma
4. **Frontend Admin Panel** (33 nodes) — Next.js pages, components, hooks, dashboard UI
5. **Core App Modules** (32 nodes) — App module, Metrics, Devices, Invgate, Prisma module
6. **LLM Providers** (24 nodes) — OpenAI, Gemini, Claude, OpenRouter, OpenCodeGo providers
7. **Tenants Module** (21 nodes) — Tenant controller, service, module
8. **Data Model** (20 nodes) — Prisma entities: User, Role, Ticket, Metric, Setting, etc.
9. **API Tooling** (19 nodes) — devDependencies, tsconfig, jest, eslint
10. **API Dependencies** (16 nodes) — production dependencies
11. **Project Documentation** (15 nodes) — Plan de trabajo, READMEs, docs
12. **Web Dependencies** (15 nodes) — frontend packages
13. **Architecture Spec** (11 nodes) — AGENTS.md concepts: PostgreSQL, RabbitMQ, Multitenant, LLM
14. **Web TypeScript Config** (8 nodes) — tsconfig, next.config, tailwind
15. **API TypeScript Config** (7 nodes) — nest config, tsconfig
16-43. **Smaller communities** — Individual configs, docs, scripts (Package Metadata, Jest Config, Nest CLI, individual entity docs, etc.)
