
# Documento de Contexto del Proyecto: **Soporte Omnicanal con IA**

**Versión:** 1.0
**Fecha:** Octubre 2023
**Estado:** Propuesta Inicial / Definición de Alcance

---

## 1. Resumen Ejecutivo
El presente proyecto tiene como objetivo el desarrollo de un **Chatbot de Soporte Inteligente** con capacidad de conectarse a múltiples canales de mensajería (comenzando con WhatsApp). La solución no solo actuará como un receptor de tickets, sino que funcionará como un **asistente virtual de primera línea** capaz de resolver incidencias en el momento de la consulta.

El sistema se apalancará en una arquitectura robusta basada en eventos (Broker), integración profunda con **Invgate** (para la gestión de tickets) y un modelo de permisos dinámico (RBAC) para garantizar la seguridad y escalabilidad en un entorno **Multitenant**.

---

## 2. Objetivos Estratégicos
1.  **Omnicanalidad real:** Centralizar la comunicación mediante un broker de mensajería para desacoplar el Core del negocio de los canales específicos (WhatsApp, Web, Email, etc.).
2.  **Automatización del Soporte:** Resolver problemas simples de manera autónoma vía LLM, derivando a un agente humano (o generando ticket en Invgate) solo cuando sea necesario.
3.  **Seguridad y Control:** Autenticación robusta (2FA) y trazabilidad de dispositivos (Fingerprint) para garantizar que solo usuarios autorizados accedan al sistema.
4.  **Flexibilidad Corporativa:** Soporte para que un mismo usuario gestione múltiples empresas (Multitenant) y roles dinámicos que definan el acceso a funcionalidades específicas.

---

## 3. Arquitectura Propuesta

### 3.1. Stack Tecnológico
- **Backend:** NestJS (Node.js) - *Arquitectura modular y orientada a objetos/eventos.*
- **Frontend:** Next.js (React) - *SSR y generación de dashboards/paneles de administración.*
- **Base de Datos:** PostgreSQL - *Relacional robusto para manejar transacciones de usuarios, roles y tenants.*
- **Broker de Mensajería:** RabbitMQ / LavinMQ - *Gestión de colas y eventos asíncronos entre el Chatbot y los canales externos.*
- **LLM Externo:** Integración con proveedores externos (OpenAI, Google Gemini, Claude, etc.) mediante una capa de abstracción que permita cambiar de proveedor sin impacto en el negocio.

### 3.2. Flujo de Alto Nivel (Diagrama Conceptual)
1.  **Usuario** escribe en WhatsApp.
2.  **Conector WhatsApp** publica el mensaje en el **Broker**.
3.  El **Orquestador (NestJS)** consume el mensaje.
4.  **Validación de Identidad:**
    - Si es un nuevo dispositivo: Solicita 2FA (Mail/SMS) y registra el Fingerprint.
    - Si es conocido: Procesa directamente.
5.  **Procesamiento del Problema:**
    - El LLM analiza la consulta.
    - Si puede resolverlo: Devuelve la respuesta al usuario a través del Broker/WhatsApp.
    - Si NO puede: Invoca a la **API de Invgate** para crear un ticket con la información recopilada.
6.  **Auditoría:** Se registra la interacción (métrica) para futuros dashboards.

---

## 4. Componentes Funcionales Clave

### 4.1. Módulo de Autenticación y Seguridad (RBAC + 2FA)
- **Registro y Login:** Se validará la identidad del usuario.
- **2FA (Two-Factor Authentication):** Envío de código OTP vía **Email** (inicialmente) y planificado para SMS.
- **Fingerprint de Dispositivo:** Al autenticarse, se toma una huella del navegador/dispositivo. Este fingerprint queda asociado al usuario y tiene una **validez parametrizable** (ej. 30 días) desde el backoffice (Backup/Configuración). Si expira, se solicita 2FA nuevamente.
- **RBAC Dinámico:**
    - Los roles no son fijos (Admin, User, etc.); pueden ser **creados dinámicamente desde el backend**.
    - Cada rol tiene una lista de permisos (CRUD sobre recursos específicos) que determinan qué menús y botones visualiza el usuario en el frontend Next.js.

### 4.2. Módulo de Gestión de Tickets (Invgate)
- **Usuario Técnico:** Se dispondrá de un usuario específico en Invgate con permisos API para la creación y actualización de tickets.
- **Acciones:** El chatbot podrá:
    - **Crear** tickets automáticos cuando la consulta sea compleja.
    - **Consultar** el estado de tickets existentes.
    - **Actualizar** información del ticket con las respuestas del usuario durante la conversación.

### 4.3. Módulo Multitenant
- Cada usuario puede pertenecer a **una o más empresas** (Tenants).
- Al iniciar una conversación o sesión, el sistema detecta el contexto (empresa) para aplicar las configuraciones específicas (ej. flujos de aprobación, base de conocimiento del LLM, etc.).
- El aislamiento de datos entre empresas es obligatorio a nivel de base de datos (filtros por Tenant ID).

### 4.4. Módulo de Menús Dinámicos
- Los menús del panel administrativo (Next.js) se construyen en base al rol del usuario logueado.
- Un administrador global podrá asignar, desde el backend, qué opciones de menú (Dashboard, Tickets, Usuarios, Reportes) están disponibles para cada rol creado dinámicamente.

### 4.5. Módulo de Métricas y Auditoría (Fase Futura)
- Se almacenará un registro de **cada consulta realizada** (timestamp, usuario, tenant, tiempo de respuesta, canal, resolución final).
- Esta data permitirá construir dashboards en el futuro sin necesidad de modificar el core, ya que la información estará estructurada en la BD desde el inicio.

### 4.6. Capa de Abstracción de LLM
- **Multi-proveedor:** El sistema debe estar preparado para usar distintos motores de IA.
- **Configuración:** Parámetros como *Temperature, Max Tokens, System Prompt* y el proveedor específico serán configurables por tenant o por endpoint.

---

## 5. Consideraciones Técnicas No Funcionales

- **Alta Disponibilidad:** El broker (RabbitMQ) debe ser persistente para no perder mensajes si el backend cae.
- **Escalabilidad:** NestJS permite una arquitectura de microservicios si en el futuro se separa el módulo de tickets del módulo de chat.
- **Rendimiento en Chat:** El uso de WebSockets o Server-Sent Events (SSE) para el frontend, combinado con el broker, asegura respuestas en tiempo real.
- **Seguridad:** Todas las comunicaciones vía HTTPS y los secrets (API Keys de LLM e Invgate) almacenados en un Vault o variables de entorno cifradas.

---

## 6. Entregables Principales (Hitos)

1.  **Hito 0 - Setup:** Infraestructura (NestJS, Next.js, PostgreSQL, RabbitMQ) y conexión a WhatsApp (Business API).
2.  **Hito 1 - Core de Seguridad:** Implementación de 2FA (Mail), Fingerprint y RBAC dinámico.
3.  **Hito 2 - Lógica de Negocio:**
    - Integración con API de Invgate (Crear/Leer tickets).
    - Abstracción del LLM y conexión con un proveedor inicial (ej. OpenAI).
4.  **Hito 3 - Multitenant y Menús:** Asegurar el aislamiento de datos y la generación de UI dinámica.
5.  **Hito 4 - Auditoría:** Logs de métricas para futuros dashboards.
6.  **Hito 5 - Go Live:** Despliegue en entorno productivo y pruebas de carga.

---

## 7. Próximos Pasos

- Definir el alcance del **Fingerprint** (¿qué datos componen la huella? IP, User-Agent, Screen, Canvas?). -> para la etapa inicial telefono y user-Agent  
- Elección final entre RabbitMQ y LavinMQ (preferencia por RabitMQ por madurez y documentación). Usemos RabbitMQ
- Diseño detallado del modelo de datos en PostgreSQL (Tablas: Users, Tenants, Roles, Permissions, Devices, Conversations, Tickets, Metrics). ok
- Creación del UX/UI del dashboard en Next.js. 

---
