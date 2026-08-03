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
│   ├── api/                    # Backend — NestJS
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # Modelo de datos
│   │   │   └── seed.ts         # Datos iniciales
│   │   ├── src/
│   │   │   ├── auth/           # Autenticación, 2FA, JWT
│   │   │   ├── users/          # Gestión de usuarios
│   │   │   ├── tenants/        # Multitenant
│   │   │   ├── roles/          # RBAC dinámico
│   │   │   ├── conversations/  # Conversaciones y mensajes
│   │   │   ├── tickets/        # Integración Invgate
│   │   │   ├── llm/            # Capa de abstracción LLM
│   │   │   ├── channels/       # Conectores de canal (WhatsApp)
│   │   │   ├── broker/         # RabbitMQ (productores/consumidores)
│   │   │   ├── devices/        # Fingerprint de dispositivos
│   │   │   ├── metrics/        # Auditoría y métricas
│   │   │   └── flows/          # Flujos conversacionales (ReactFlow)
│   │   └── .env
│   └── web/                    # Frontend — Next.js
│       ├── src/
│       │   ├── app/            # App Router (páginas)
│       │   ├── components/     # Componentes React
│       │   └── hooks/          # Custom hooks
│       └── .env
├── docs/
│   └── chatbot.md              # Especificación completa del proyecto
├── graphify-out/               # Grafo de conocimiento del codebase
├── package.json                # Scripts del monorepo
├── pnpm-workspace.yaml         # Configuración de workspaces
└── .env.example                # Variables de entorno de ejemplo
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

### RBAC dinámico
Los roles y permisos se crean desde el backend, no están hardcodeados. El frontend construye menús y botones en función del array de permisos del rol del usuario.

### Capa de abstracción LLM
Nunca llames directamente a los SDK de OpenAI, Gemini o Claude desde la lógica de negocio. Siempre usa el servicio de LLM del backend (`apps/api/src/llm/`), que permite cambiar de proveedor sin impacto.

### Desacoplamiento de canales
El core no conoce detalles de WhatsApp. Toda comunicación con canales externos fluye a través de RabbitMQ.

### Invgate
Las operaciones de ticket usan un **usuario técnico** con credenciales API, nunca las credenciales del usuario final.

### Secrets
Las API keys de LLM e Invgate solo se configuran mediante variables de entorno. No se commitean nunca.

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

## 🤝 Contribución

1. Crea una rama desde `main`: `git checkout -b feature/nombre-feature`
2. Realiza tus cambios siguiendo las convenciones del proyecto.
3. Asegúrate de que `pnpm lint` y `pnpm test` pasen en la app correspondiente.
4. Abre un Pull Request con descripción clara del cambio.

---

## 📄 Licencia

Proyecto privado — PCI.
