# Planificación: flows alternativos por rol para feriados y guardias

**Estado:** documento de análisis. No incluye cambios de código.
**Repo:** `chatbot/pci` (rama `martin-dev`)

## 1. Objetivo

Que cada flow tenga hasta **2 flows alternativos**:

- **Feriado**: se activa cuando la fecha/hora actual cae dentro de un rango marcado como feriado para el rol del usuario.
- **Guardia**: se activa cuando cae dentro de un rango marcado como guardia para el rol del usuario.

Si ninguno aplica, se usa el flow **Principal** (comportamiento actual, sin cambios).

En el editor visual, cada flow va a tener una **barra selectora en la esquina superior derecha** con tres opciones — **Principal / Guardia / Feriado** — que alterna qué grafo se está viendo/editando en el canvas. No es un nodo dentro del grafo: son grafos completos e independientes, agrupados como variantes del mismo flow lógico.

La configuración de qué días/horarios son feriado o guardia, por rol, se hace en un **calendario visual** aparte (se sugiere `react-big-calendar`).

## 2. Cómo funciona hoy (relevado del código)

Stack: monorepo pnpm — `apps/api` (NestJS + Prisma + PostgreSQL) y `apps/web` (Next.js estático). Editor visual de flows en `apps/web/src/app/dashboard/flows/edit/page.tsx` usando `@xyflow/react` (React Flow v12).

**Modelo de un flow** — `Flow { nodes: Json, edges: Json }` en `apps/api/prisma/schema.prisma:289-325`, formato nativo de ReactFlow. El motor de ejecución vive en `apps/api/src/modules/conversations/conversations.service.ts`, con un `switch(node.type)` que ya soporta, entre otros: `start, message, menu, input, condition, ticket_create, ticket_query, transfer_agent, llm_query, delay, variable, webhook, subflow, end`.

**Aclaración importante:** el nodo `subflow` que ya existe en el motor **no tiene relación con esta feature**. Es un nodo dentro de un grafo que deriva la conversación hacia *otro* flow para continuar con otro contexto (ej. "te derivo al flow de reclamos"). Lo que se pide acá es distinto: no es un nodo que salta a otro flow durante la conversación, sino **variantes completas de un mismo flow lógico** que se eligen *antes* de arrancar la conversación, según rol + calendario. Hay que evitar reutilizar el mecanismo de `subflow` para esto, para no mezclar dos conceptos que se van a comportar distinto.

**Rol del usuario** — se resuelve por teléfono en `conversations.service.ts:249-254`:

```ts
const membership = await this.usersService.findMembershipByPhone(from, tenantId);
const identity = { isKnown: !!membership, roleId: membership?.role.id ?? null, roleName: membership?.role.name ?? null };
```

**Selección del flow de arranque por rol** — `FlowService.findActiveFlowForTenant(tenantId, roleId)` en `flow.service.ts:181-206`, vía las tablas `TenantFlow.isStart` + `TenantFlowRole`. El propio schema lo documenta: *"El motor de flujos IVR decide por rol, nunca por área"* (`schema.prisma:83-84`). Es decir: **hoy el sistema ya elige flow según rol** — lo que falta es agregar la dimensión temporal (feriado/guardia) a esa misma decisión.

**Estado de conversación** — `Conversation.flowState: Json?`, `currentFlowId`, `currentNodeId` (`schema.prisma:189`). Se fija al iniciar la conversación y no se resuelve dos veces.

**Calendario/feriados/guardias/horarios** — no existe nada hoy. Es terreno limpio.

## 3. Diseño propuesto

### 3.1 Modelo de datos: flow alternativo = otra fila `Flow` completa

Cada flow "Principal" puede tener asociadas hasta dos filas `Flow` adicionales (Guardia, Feriado), cada una con su propio `nodes`/`edges` independiente — no comparten grafo. Se vinculan mediante una tabla de mapeo, siguiendo el mismo patrón que ya usa el proyecto para `TenantFlowRole` (tabla de relación, sin tocar el modelo `Flow` en sí):

```prisma
enum ScheduleType {
  FERIADO
  GUARDIA
}

model ScheduleCalendarEntry {
  id        String       @id @default(cuid())
  tenantId  String
  roleId    String?      // null = aplica a todos los roles
  type      ScheduleType
  title     String
  startAt   DateTime
  endAt     DateTime
  allDay    Boolean      @default(true)
  // fase 2: recurrenceRule String? (RRULE, para feriados anuales tipo 25/12)
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id])
  role   Role?  @relation(fields: [roleId], references: [id])
}

model FlowAlternative {
  id            String       @id @default(cuid())
  tenantId      String
  baseFlowId    String       // el flow "Principal"
  type          ScheduleType // FERIADO | GUARDIA
  variantFlowId String       // el Flow alternativo (grafo propio)

  baseFlow    Flow @relation("baseFlow", fields: [baseFlowId], references: [id])
  variantFlow Flow @relation("variantFlow", fields: [variantFlowId], references: [id])

  @@unique([baseFlowId, type])
}
```

**Alternativa de modelado** (a evaluar): en vez de la tabla de mapeo, agregar `parentFlowId` + `variantType` directamente al modelo `Flow` (self-relation). Es más simple de consultar ("dame las variantes del flow X"), pero mezcla en la misma tabla flows "reales" (elegibles como `isStart`) con flows que sólo existen como variante de otro. La tabla de mapeo separada evita esa ambigüedad y es más consistente con el patrón ya usado en el proyecto (`TenantFlowRole`).

### 3.2 Resolución en runtime (arranque de conversación)

Igual que hoy se resuelve el rol, se agrega la dimensión temporal en el mismo punto:

```
findActiveFlowForTenant(tenantId, roleId)
        ↓ (hoy)
   Flow "Principal" del rol

findActiveFlowForTenant(tenantId, roleId, atDate = now)
        ↓ (propuesto)
   1. status = ScheduleService.resolveStatus(tenantId, roleId, atDate)
        → NORMAL | FERIADO | GUARDIA
   2. si status != NORMAL → buscar FlowAlternative (baseFlowId, status)
   3. si no hay alternativa configurada para ese status → fallback al flow Principal
        (tenants que no configuran nada siguen funcionando igual que hoy)
```

Se calcula **una sola vez, al iniciar la conversación** (mismo momento en que hoy se fija `currentFlowId`) — no se re-evalúa a mitad de una conversación larga que cruce medianoche.

### 3.3 UX del editor: barra selectora Principal / Guardia / Feriado

En `apps/web/src/app/dashboard/flows/edit/page.tsx`, agregar en la esquina superior derecha un selector (tabs o segmented control) con tres opciones:

```
┌─────────────────────────────────────────────────┐
│  [Nombre del flow]         [Principal|Guardia|Feriado] │
├─────────────────────────────────────────────────┤
│                                                   │
│              (canvas de ReactFlow)               │
│                                                   │
└─────────────────────────────────────────────────┘
```

Comportamiento:
- Al entrar al editor de un flow, se cargan sus `FlowAlternative` existentes. El selector muestra las 3 opciones; **Principal** siempre existe, **Guardia**/**Feriado** pueden no estar configuradas todavía.
- Al elegir una pestaña sin variante creada aún, ofrecer **"Crear variante"** con opción de arrancar en blanco o **duplicar el grafo del Principal** como punto de partida (evita reescribir todo desde cero — probablemente el caso más común, ya que un flow de guardia suele ser el mismo flow con algunos pasos recortados).
- Cambiar de pestaña intercambia qué `flowId` está cargado en el canvas (fetch/guardado apuntan al `Flow` de esa variante, no al Principal).
- Indicador visual (ej. punto/badge) en cada pestaña para distinguir variantes configuradas de no configuradas.
- Guardar (`save`) persiste siempre contra la variante actualmente seleccionada.

### 3.4 Módulo de calendario

**Backend** — nuevo módulo `apps/api/src/modules/schedule-calendar/`:
- `schedule-calendar.controller.ts`: CRUD de entradas, scoped por tenant + rol. Proteger con permisos nuevos en `permissions.catalog.ts` (ej. `schedule_calendar:read`, `schedule_calendar:write`), siguiendo el patrón ya usado por `rbac`.
- `schedule-calendar.service.ts`: CRUD + `resolveStatus(tenantId, roleId, atDate)`, consumido por `FlowService`.

**Frontend** — nueva pantalla de administración, ej. `apps/web/src/app/dashboard/schedule-calendar/page.tsx`, usando **react-big-calendar**:
- Vistas mes/semana/día mostrando entradas FERIADO (rojo) y GUARDIA (naranja) como eventos, con `eventPropGetter` para el color por tipo/rol.
- Selector de rol para filtrar o mostrar coloreado por rol (multi-tenant con varios roles).
- Modal de alta/edición: tipo (Feriado/Guardia), rol(es) afectados (multi-select o "todos"), rango de fechas, toggle día completo vs. horario específico (start/end time) — el pedido menciona "horarios" explícitamente, así que se necesita granularidad horaria, no solo fecha.
- Requiere localizer de `react-big-calendar` (`date-fns` o `moment`) — verificar si `date-fns` ya es dependencia de `apps/web` antes de sumar `moment`.

## 4. Preguntas abiertas antes de implementar

1. ¿Feriado y guardia son mutuamente excluyentes el mismo día/rol, o pueden coexistir? Si coexisten, ¿qué prioridad gana para elegir el flow alternativo?
2. ¿Guardias con horario que cruza medianoche (ej. 20:00–08:00) deben soportarse desde el MVP?
3. ¿Feriados recurrentes anuales (25/12 todos los años) se necesitan desde el MVP, o se cargan manualmente cada año al principio (fase 2 con RRULE)?
4. Si un rol no tiene variante configurada para feriado o guardia, ¿el fallback al flow Principal es aceptable, o debería bloquear/avisar al admin que falta configurar?
5. ¿El calendario es por tenant, o conviene separar un calendario "global" de feriados nacionales reutilizable entre tenants, más uno "local" de guardias específicas del tenant?
6. ¿Alcanza con evaluar el estado al iniciar la conversación, o hay casos (conversaciones muy largas) donde debería re-evaluarse?
7. Al crear una variante nueva desde el editor, ¿la opción "duplicar desde Principal" es la única vía, o también debería poder duplicarse desde otra variante existente (ej. armar Feriado a partir de Guardia)?

## 5. Fases de implementación (para cuando se apruebe el diseño)

1. **Schema**: migración Prisma con `ScheduleCalendarEntry` + `FlowAlternative`, permisos nuevos en `permissions.catalog.ts`.
2. **Backend**: módulo `schedule-calendar` (CRUD + `resolveStatus`), extender `FlowService.findActiveFlowForTenant` para aceptar la fecha y resolver la variante.
3. **Frontend**: pantalla de calendario (`react-big-calendar`) + barra selectora Principal/Guardia/Feriado en el editor de flows, con flujo de "crear variante" (en blanco o duplicando el Principal).
4. **Tests**: casos límite de `resolveStatus` (solapamientos, zona horaria, guardias que cruzan medianoche), test E2E simulando arranque de conversación en día feriado.
5. **Rollout**: sin variantes configuradas, comportamiento idéntico al actual — se puede activar tenant por tenant sin riesgo.

## 6. Resumen de la recomendación

- Un flow alternativo (Guardia/Feriado) es una fila `Flow` completa e independiente, con su propio grafo — **no** un nodo dentro del grafo, y **no** relacionado con el nodo `subflow` existente (que es una feature distinta, de derivación en tiempo real entre flows durante la conversación).
- La resolución de qué flow ejecutar (Principal/Guardia/Feriado) se hace a nivel de `FlowService`, en el mismo punto donde hoy se resuelve por rol, al iniciar la conversación.
- El editor de flows suma una barra selectora arriba a la derecha (Principal/Guardia/Feriado) que alterna qué grafo está cargado en el canvas.
- Modelar el calendario como eventos (`ScheduleCalendarEntry`) con tipo, rol opcional y rango de fecha/hora — directamente compatible con el formato que espera `react-big-calendar`.
- Diseño 100% retrocompatible: tenants/flows sin variantes configuradas siguen funcionando exactamente igual que hoy.
