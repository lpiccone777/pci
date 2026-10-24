# Plan del agente pci: integración del voicebot

**Repo:** `C:\Users\DM\Documents\desarrollo\chatbot\pci`. Solo escribís acá.

**Leé antes de empezar** (los tres primeros están en el repo del voicebot, que es el dueño del contrato):
- `C:\Users\DM\Documents\desarrollo\voicebot\docs\integracion-pci\README.md`: decisiones y metodología.
- `C:\Users\DM\Documents\desarrollo\voicebot\docs\integracion-pci\contrato.md`: la interfaz. No se
  cambia por tu cuenta; las propuestas van a su sección *Cambios propuestos*.
- `C:\Users\DM\Documents\desarrollo\voicebot\docs\integracion-pci\analisis.md`: incluye el relevamiento de pci.
- `AGENTS.md` de este repo. Sus reglas siguen vigentes:
  - multitenant y RBAC dinámico;
  - secrets cifrados y de solo escritura;
  - todo I/O externo por el broker;
  - `safeAck`/`safeNack`;
  - checklist de cierre: build, `plan-de-trabajo.md`, `/graphify . --update`, commit.

**Tu rol:** pci es la fuente de verdad de la configuración del voicebot y del stt, de los internos
y de los flujos de voz. **Ejecuta los flujos de voz** (D1): el voicebot solo los verbaliza.

Al empezar, sumar una sección *Voicebot* a `docs/plan-de-trabajo.md` que apunte a este plan, con el
mismo formato de hitos (✅ / 🔄 / ⏳ y fecha del pedido: 2026-10-23).

Estado (2026-10-24): ✅ H0 · ✅ H1 · ✅ H2 · ✅ H3 · 🔄 H4 (plan) · ⏳ H5. Contrato vigente: **1.14**. Rama: `feat/integracion-voicebot`.

## H0 — Contrato ✅

- [x] Revisar `contrato.md` desde el lado de pci. En especial:
  - §5 (turnos) contra `ConversationsService`;
  - DA1, DA2 y DA3, que tocan reglas de `AGENTS.md`.
  - Anotar objeciones en *Cambios propuestos*. Hecho: C1–C8 y C27–C30, aprobadas y aplicadas en 1.0.

## H1 — Subpestaña Voicebot y endpoints de configuración ✅ (2026-10-24)

Cerrado de punta a punta (verificado por el coordinador, 2026-10-24): el voicebot y el stt leen sus
endpoints con token real, la importación de los `.env` corrió con `--apply`, y llegaron
`config.changed` v4 (`sections: ["conversacion"]`, sin reinicio) y v5 (`["stt"]`,
`restart.stt: true` → el stt salió con código 75). "Probar conexión" queda en H5.

- [x] **Catálogo** (`settings/voicebot-settings.catalog.ts`; nombres con prefijo `VOICEBOT_`/`STT_` y `envNames` por consumidor, contrato §3.4. `STT_SINK` no se edita: se deriva de `VOICEBOT_SOURCE` + `STT_SINK_CONSOLE` [C39]):
  - Grupos nuevos en `settings.catalog.ts` y `SETTINGS_GROUP_ORDER` con las claves de contrato §3.4.
    Los nombres de clave son exactamente los del contrato.
  - Las marcadas 🔒 van `secret: true`.
  - Defaults = los de hoy en el voicebot (`voicebot/apps/api/src/config/env.validation.ts`, `.env.example`).
  - Validaciones con `min`/`max` y `allowedValues` donde corresponda (`VOICEBOT_SOURCE`: `amqp|http`;
    `MINIMAX_LLM_API`: `anthropic|openai`).
- [x] **UI** (`enabledBy`, `reconnects`, `restartsStt` en `SettingDefinition`; la UI muestra además el nombre con que lo recibe cada servicio):
  - En `GROUP_HIERARCHY` (`apps/web/src/app/settings/page.tsx:86`), `mensajeria → voicebot → {general, livekit, rabbitmq, entrada-stt, stt, tts, llm, conversacion, sip-entrante, sip-saliente, llamadas-salientes, internos}`.
  - **Habilitación condicional**: con `VOICEBOT_ENABLED` en falso, solo se ve *General*; las demás
    hojas aparecen deshabilitadas u ocultas.
    - Hoy no existe ese mecanismo: construirlo genérico (p. ej. `enabledBy` en `SettingDefinition`),
      no un `if` por key.
  - Marcar en la UI las claves que **reconectan** (pueden cortar llamadas) y las que **reinician el STT**.
- [x] **Endpoints de servicio** (`modules/integrations/`, `common/guards/service-token.guard.ts`; DA2 aprobada):
  - `GET /integrations/voicebot/config` y `GET /integrations/stt/config` (contrato §3.1 y §3.2),
    con un guard de token de servicio propio, fuera de `JwtAuthGuard`/`TenantGuard`.
  - Tokens `VOICEBOT_SERVICE_TOKEN` y `STT_SERVICE_TOKEN` como secrets del catálogo.
  - Devuelven secrets en claro **solo si DA2 se aprueba**; nunca loguear el cuerpo.
- [x] **Versión de configuración** (tabla `IntegrationConfigVersion`, migración `20261023120000_integration_config_version`, aplicada en la base de desarrollo el 2026-10-24): un contador que sube con cada cambio de una clave de estos
  grupos o de un interno. Lo devuelven los endpoints y va en el evento.
- [x] **Evento `config.changed`** (exchange `voicebot.events`, DA3; `BrokerService.publishToExchange`) al guardar o restaurar una clave de estos grupos (contrato §3.3).
  El transporte depende de DA3.
- [ ] ⏭️ Pasa a H5 por indicación del coordinador (no hay consumidor de `health.check` todavía). **"Probar conexión"** del voicebot por `health.check` (contrato §6), por RPC del broker,
  mismo patrón que `context-source.test-connection`. Si el voicebot de H5 no está, que la UI lo
  diga en lugar de colgarse.
- [x] **Tests** (`test/integrations.e2e-spec.ts` BE-INT-01..18, `settings.spec.ts` FE-SET-19, FE-RSP-04 ampliado, plan de pruebas §1.25):
  - e2e del catálogo y de los endpoints de servicio (token válido, inválido o ausente).
  - Actualizar `apps/web/e2e/settings.spec.ts:66` y `responsive.spec.ts:84` con la jerarquía nueva.
- [x] **Aviso de salientes en uso** (contrato 1.1 §6.0, 2026-10-24): *SIP saliente* y *Llamadas
  salientes* muestran "En uso por las llamadas salientes (Anura / n8n): un cambio acá afecta llamadas
  reales" (`notice` en `GROUP_HIERARCHY`, FE-SET-20).
- [x] **Importación de los `.env` actuales** (pedido del usuario vía coordinador, 2026-10-24;
  `src/scripts/import-integration-env.ts`, `modules/integrations/env-import*.ts`, BE-INT-19..22):
  script de una sola vez que corre el usuario. Mapea cada variable con `envNames`, reporta los
  conflictos entre los dos `.env` sin elegir, ignora las del host y las ajenas al catálogo, guarda
  por `SettingsService` y publica un solo `config.changed`. Dry-run por default, solo nombres.
  - Casos nuevos en `docs/plan-de-pruebas.md`.

## H2 — Internos ✅

Desplegado el 2026-10-24: migración aplicada en la base de desarrollo, API reconstruida y
levantada; los internos 201 y 202 llegan al voicebot en la config v7.

- [x] **Modelo Prisma** de internos (`Extension`, contrato §3.5; migración
  `20261024120000_voicebot_extensions`, aplicada en la base de desarrollo).
  - `number` único.
  - ⏭️ `flowId` queda nullable y la API no lo acepta todavía: la validación "flujo `voice` asignado
    a ese tenant" llega con `Flow.channel` (H4) y depende de DA8/DA15, abiertas. En la UI, deshabilitado.
- [x] **ABM** (`modules/extensions/`, `/voicebot/extensions`) con `SystemTenantGuard` + `settings:*`
  (infra global, D3) y UI en la subpestaña *Voicebot → Internos* (`settings/voicebot-extensions.tsx`),
  gateada por `VOICEBOT_ENABLED`.
- [x] Los internos van en `extensions` de `GET /integrations/voicebot/config` (los de una empresa
  dada de baja, con `enabled: false`). Todo cambio sube la versión y publica `config.changed` con
  `sections: ["internos"]`.
- [x] Relación con `User.internalPhone` [C5]: siguen siendo cosas distintas (interno de una
  persona vs. interno que atiende el bot), pero no pueden coincidir. Se valida en los dos sentidos:
  `ExtensionsService` contra personas activas, y `UsersService` (alta, edición, verificación en vivo,
  carga masiva) contra los internos.
- [x] **Tests:** `test/extensions.e2e-spec.ts` (BE-EXT-01..09), FE-SET-21, plan de pruebas §1.26.
- Contrato 1.5 (C45, reemplaza a C44): solo se atienden llamadas a internos cargados y habilitados;
  el resto lo rechaza LiveKit (los números del trunk son los internos habilitados). DA17 cerrada sin
  objeto. No cambia el modelo; sí el texto de la pantalla de internos.
- [x] Contrato 1.6 (C46): grupo *Voicebot → Capacidad* en el catálogo, consumidor voicebot, en
  caliente (`sections: ["capacidad"]`): `VOICEBOT_MAX_CALLS` (entero ≥ 1, default 3, ≤
  `STT_WORKER_MAX_JOBS` del stt) y `VOICEBOT_BUSY_TEXT`. Sin migración ni valores cargados: con
  los defaults alcanza. Tests BE-INT-23..25 y FE-SET-22.

## H3 — Canal de voz en el motor ✅

Contrato 1.7 (C47): DA5+DA14, DA8+DA15 y DA11 decididas. Plan aprobado por el coordinador el
2026-10-24 y **implementado**: migración `20261024180000_voice_channel` (aplicada por el usuario),
`modules/voice/`, canal `voice` en el motor y 17 e2e (BE-VOZ-01..17, p95 ≈ 100 ms). Falta la prueba
integrada con el voicebot real, que coordina el coordinador (hay que compilar las dos APIs).

Del contrato 1.8 (C48) para pci: `call.started` llegaba ≈2 s después del `start` (desde 1.11, C51,
los dos llegan al atender; `SIP_INBOUND_GREET_DELAY_MS` pasa a ser el mínimo entre atender y el
primer audio), con la entrada real
(`startedAt` se toma de ahí); con `guided`/`delegate` en `start`/`continue` el voicebot agrega un
turno de usuario de marca ("(Atendiste la llamada.)", "(Seguí.)"), a tener en cuenta al escribir la
`instruction` del nodo de inicio en H4; relleno: `VOICEBOT_FILLER_AFTER_MS=0` = sin relleno (un
texto vacío vuelve al default), corregido en el catálogo, y desde 1.9 (C49) cuenta solo la
espera de la respuesta de pci al `voice.turn`; `transfer` llega como `Refer-To
tel:<extension>`.

Módulo nuevo `modules/voice/`. `ConversationsService` ya tiene 3100 líneas, así que la voz no se
suma ahí:
- `VoiceTurnsService` maneja el broker de voz, el lock por llamada, la idempotencia, los snapshots y
  el armado de `actions`.
- El motor (`executeFlow`/`executeNode`) se reusa con un parámetro de **canal**. No se duplica.

### Modelo (una migración)

- [x] `Conversation.userId` nullable [DA5+DA14]. La regla "sin usuario solo en `voice`" vive en el
  código, porque Prisma no tiene CHECK. Hay que auditar las lecturas de `conversation.user`.
- [x] `Flow.channel` (`text` | `voice`, default `text`) [D10, DA8]. De H4 se adelantan el schema y
  la resolución; el editor sigue en H4. Los flujos existentes quedan `text`.
- [x] `VoiceCall` (una fila por llamada, id = `callId`):
  - `conversationId`, `extensionId`, `tenantId`;
  - `callerNumber`, la pista de DA14, sin identificar a nadie;
  - `calledNumber`, `direction`, `startedAt`, `endedAt`, `endReason`, `lastSpoken`;
  - el lease del turno: `turnLockToken`, `turnLockUntil`.
- [x] `VoiceTurn` (una fila por `turnId`, único):
  - `callId`, `kind`, `text`;
  - la respuesta enviada (Json), `committed`, `superseded`;
  - el snapshot previo: `currentFlowId`, `currentNodeId`, `flowState`;
  - los ids de los `Message` del usuario y del bot.
  - De esta tabla salen la idempotencia, `supersedes` y `previous`.

### Resolución del flujo [DA8+DA15]

- [x] Orden:
  1. `Extension.flowId`, si el flujo está activo, es `voice` y está asignado al tenant del interno.
  2. Si no, el flujo de voz de inicio del tenant (`TenantFlow.isStart` y `channel = voice`). Sin
     filtro de rol, porque todavía no hay usuario.
  3. Si no hay ninguno, charla libre (`delegate`).
- [x] **Nunca** el `isDefault` global ni un flujo de otro tenant. Texto sigue como hoy: `isDefault`
  queda solo para texto.
- [x] Feriado y guardia, como en texto: `resolveStatus(tenantId, null, ahora)` más `FlowAlternative`.
- [x] La invariante "un flujo de inicio por tenant" pasa a ser **por canal**
  (`applyTenantAssignment`).

### `voice.events` [§5.2]

- [x] `call.started` abre `VoiceCall` y `Conversation` (`channel: voice`, `externalId: callId`,
  `userId: null`). Es idempotente por `callId` y no depende del orden con `kind: start`.
- [x] `call.ended`:
  - cierra la conversación;
  - guarda `endedAt`, `reason` y `lastSpoken`;
  - reemplaza el mensaje del bot de ese turno por `heardText`.
- [x] Una conversación de voz no se retoma: cada llamada abre una nueva.

### RPC `voice.turn` [§5.3]

- [x] Responde por `replyTo` (`assert: false`) con `pattern: "voice.turn.reply"` y el mismo
  `correlationId`.
- [x] **Siempre responde.** Ante una falla devuelve
  `{error: "<código>", actions: [], awaitInput: true, committed: false}` [C7, C28].
- [x] **Serialización por `callId`** [C4]:
  - dentro del proceso, una cola en memoria por llamada;
  - entre instancias, un lease en `VoiceCall`: `UPDATE … WHERE turnLockUntil < now()` atómico, con
    reintento corto y vencimiento por si el proceso se cae;
  - no alcanza con `prisma.$transaction`, porque el motor escribe la misma fila por fuera.
- [x] **Idempotencia** [C27]: un `turnId` ya procesado devuelve la respuesta guardada sin volver a
  correr el flujo.
- [x] `previous` reemplaza el texto del mensaje del bot de ese turno por lo que se oyó.
- [x] `supersedes` [DA1]:
  - si el turno abortado no fue `committed`: restaura su snapshot, borra sus mensajes, lo marca
    `superseded` y responde con `superseded: true`;
  - si fue `committed`: ignora el `supersedes` (`superseded: false`).
- [x] `kind`:
  - `start`: corre desde `start` hasta el primer `waitForInput`;
  - `user`: guarda el texto y sigue;
  - `continue`: sigue sin texto.
- [x] Armado de `actions`:
  - el texto de cada nodo, `say literal`;
  - el nodo `end`, `hangup`;
  - `llm_query` en modo charla, o la falta de flujo: `say delegate` con
    `systemPrompt = buildBasePrompt(skill del flujo)`.
  - `guided` llega en H4, con el modo de habla por nodo.
- [x] `committed` es `true` si el tramo ejecutó `ticket_create`, `sms`, `transfer_agent`, `webhook`
  o `end`/`hangup`.

### Capacidades del canal en el motor

- [x] Por `voice` nunca se arma `WhatsAppInteractive`. El `menu` se verbaliza: las opciones van en
  el texto, como en `formatInteractiveAsText`.
- [x] El nodo `start` corre sin usuario: `isKnownUser = false`, sale por `unknown` y deja
  `callerNumber` en `flowState`.
- [x] Por `voice`, `llm_query` en modo charla **no llama a `LlmService`**: devuelve `delegate`.
- [x] Por voz no corre el clasificador por LLM de "¿quiere cerrar la charla?": para eso está colgar.
- [x] Nodos no disponibles por voz: `notification`, `ticket_query`, `device_validation` y `delay`.
  Si un flujo llega a uno, se loguea y se sigue por su arista. En H4 el editor no los ofrece.

### Catálogo [C47]

- [x] Grupo nuevo *Voicebot → pci no disponible* (`sections: ["pci-no-disponible"]`), consumidor
  voicebot, en caliente:
  - `VOICEBOT_PCI_DOWN_TEXT`, con el default del contrato;
  - `VOICEBOT_MAX_TURN_FAILURES`, entero ≥ 1, default 2.
- [x] Alinear el default de `VOICEBOT_FALLBACK_TEXT` a "Perdón, no te entendí bien. ¿Me lo
  repetís?".

### Presupuesto y tests [§5.5]

- [x] Medir y loguear la duración de cada turno. Un e2e corre N turnos de un flujo literal y
  verifica **p95 < 300 ms**.
- [x] e2e por broker real:
  - `start` y `call.started` en los dos órdenes;
  - idempotencia por `turnId`;
  - `previous` y `call.ended` con `heardText`;
  - `supersedes` con y sin `committed`;
  - los tres casos de DA8, incluido que nunca use el `isDefault` global ni un flujo de otro tenant;
  - error con un interno inexistente o deshabilitado;
  - serialización de dos turnos concurrentes de la misma llamada.

### Fuera de H3 (anotado)

- **Identificación por voz (D13):** H4 o después. Hasta entonces, `ticket_create` sin usuario no
  puede resolver el cliente de InvGate: responde con un error de flujo legible y no rompe la
  llamada.
- **Fuera del presupuesto de 300 ms**, porque usan el LLM de pci: `llm_query` en modo extracción, el
  desempate por LLM de `menu` y la detección de cancelación de `input`. Se miden; por voz pasan a
  `guided`/`delegate` en H4.
- **Fuente de verdad del flujo en `delegate` (`context`):** H4, cuando se fije el tope de tamaño.
- **Prompt de la charla por voz (C50, 2026-10-24, aprobado por el usuario):** en la prueba en vivo
  el `delegate` sin flujo usaba `LLM_SYSTEM_PROMPT`, que es del chat ("volvé al menú", "cerrar la
  conversación"), y el LLM prometía gestiones que no pasaban ("el reclamo quedó registrado"). Ahora
  por voz la base es `VOICEBOT_FREE_CHAT_PROMPT` (global, *Voicebot → LLM de voz*, sin `envNames`:
  viaja solo dentro del `delegate`), con `{{empresa}}` = tenant del interno: solo conversación, sin
  trámites, y ante un pedido "por ahora no se puede por teléfono". Aplica a la charla libre y a los
  `llm_query` de los flujos de voz (Skill y prompt del nodo se suman). El chat no cambia. Tests
  BE-VOZ-13, 18 y 19.
- **Prompts por defecto a la vista (2026-10-24, aprobado por el usuario):** con `VOICEBOT_SYSTEM_PROMPT`
  vacío, *LLM de voz* muestra el prompt por defecto del voicebot (copia literal de
  `DEFAULT_SYSTEM_PROMPT`, repo voicebot `apps/api/src/voicebot/minimax-llm.service.ts`; si cambia
  allá, hay que copiarlo de nuevo) y la ayuda aclara que un valor propio lo REEMPLAZA completo.
  Mismo criterio para `VOICEBOT_FREE_CHAT_PROMPT`. Es `fallbackText` en el catálogo: solo de
  presentación, no cambia la cascada. Tests BE-INT-27 y FE-SET-23.
- **Para H4:** el usuario definió un nodo de identificación por voz (nombre, apellido, legajo/DNI)
  con salidas "reconocido" / "no reconocido", como el `start` de hoy. El motor ya corre sin usuario
  y `start` sale por `unknown`: ese nodo completa `Conversation.userId` y la `identity` del turno.

## H4 — Flujos de voz

Contrato 1.12 (C52). Decisiones del usuario:
- **DA6:** permiso propio `voice_flows`.
- **DA10:** el LLM de voz puede ser cualquiera de los `LLM_PROVIDERS` que tenga streaming, elegido
  aparte del chat y con las credenciales de cada proveedor.
- **DA12:** solo texto, sin audio.
- **Nodo de identificación por voz:** legajo o DNI, más nombre y apellido aproximados, con 2
  intentos.

Plan del 2026-10-24, **antes de codear**. Se hace en cuatro tramos, con un commit y un aviso al
coordinador por tramo. Las migraciones las pide el coordinador.

Ya hecho en H3: `Flow.channel`, la resolución por canal, el inicio por canal, el canal `voice` del
motor (menú verbalizado, `delegate`) y el prompt de voz (C50).

### H4a — Canal en la administración: permiso, menú, listado y editor ✅

Hecho el 2026-10-24: `/voice-flows` (`VoiceFlowController`, `voice_flows:*`, `VoicebotEnabledGuard`),
`GET /features`, canal exigido en cada operación de `FlowService`, nodos y subflujos validados por canal,
menú *Flujos de voz* y las pantallas compartidas en `components/flows/`. Tests BE-VFLW-01..06,
FE-VFLW-01..02. FE-FLW-08 y FE-FLW-29 ya fallaban antes de este cambio (verificado sin él).

- [x] **Permiso `voice_flows`** [DA6] en `permissions.catalog.ts` ("Flujos de voz", las 4 acciones).
  No hace falta migración: los permisos son filas libres validadas contra el catálogo, y el
  SuperAdmin lo recibe solo.
- [x] **API `voice-flows`**: el controlador hermano de `flows`, con `@RequirePermission('voice_flows', …)`.
  - Rutas: listado, `mine`, `all`, detalle, alta, edición, baja, `assign-tenants` y variantes.
  - `FlowService` recibe el canal y lo exige en cada operación por `:id`.
  - `/flows` deja de ver y de tocar flujos de voz, y `/voice-flows` no toca los de texto. Así un
    `flows:update` no edita un flujo de voz, y al revés.
  - Las variantes de feriado y guardia heredan el canal del flujo base.
  - Un subflujo tiene que ser del mismo canal; se valida al guardar.
- [x] **Gate "voicebot habilitado"**:
  - `GET /features` → `{ voicebot: boolean }`, legible por cualquier usuario autenticado de
    tenant, porque `/settings` es solo de sistema;
  - `/voice-flows` responde 404 si `VOICEBOT_ENABLED` no es `true`. El sidebar es solo cosmético.
- [x] **Menú y pantallas**:
  - *Flujos de voz* va debajo de *Flujos IVR* (`voice_flows:read`), visible si `features.voicebot`.
  - `/dashboard/voice-flows/` y `/dashboard/voice-flows/edit/` reusan los mismos componentes del
    listado y del editor, con `channel="voice"` y la API `/voice-flows`.
  - En la asignación a empresas de un flujo de voz no hay roles, porque la llamada entra sin
    usuario. Queda la marca "de inicio": uno por empresa.
- [x] **Paleta y propiedades por canal**:
  - nodos de voz: `start, message, input, menu, condition, variable, llm_query, ticket_create,
    transfer_agent, sms, webhook, subflow, end`, más los nuevos *Transferir a interno* e
    *Identificar por voz*;
  - no aparecen `notification, ticket_query, device_validation, delay`, y el backend los rechaza al
    guardar un flujo de voz;
  - todo campo nuevo de `data` se declara en `FlowNodeDataDto`.
- [x] **Tests:** e2e del permiso, del aislamiento por canal, del gate y de la validación de nodos;
  Playwright del menú, el listado y el editor de voz.

### H4b — Cómo habla cada nodo, transferencia y menú sin LLM

- [ ] **Modo de habla por nodo** (contrato §5.4):
  - cada nodo que habla (`start`, `message`, `menu`, `input`, `end` y el texto de `ticket_create`)
    elige `literal` (default, el texto exacto) o `guided`;
  - en `guided`, el texto del nodo es la `instruction` y `facts` lleva las variables `{{x}}` que
    usa, ya resueltas;
  - el editor muestra el selector solo en los flujos de voz, y recuerda que con `guided` en el
    `start` el voicebot agrega "(Atendiste la llamada.)" [C48].
- [ ] **Menú por voz sin LLM de pci:**
  - match determinístico por número ("1", "uno", "la primera"), por etiqueta y por similitud;
  - si no matchea, un `guided` que repite las opciones; a la segunda falla, `delegate` (como el
    fallback de hoy);
  - por voz no se llama a `interpretMenuChoice`, y la detección de cancelación de `input` (LLM)
    no corre por voz.
- [ ] **`llm_query` en modo extracción por voz:**
  - la pregunta por un dato faltante sale como `guided` ("Pedile el dato X"), sin
    `generateLlmQueryQuestion`;
  - la extracción sigue usando el LLM de pci (no hay otra forma). Se mide y se loguea, y queda
    fuera del presupuesto de 300 ms.
- [ ] **`context` del `delegate`** (§5.4):
  - la fuente de verdad del flujo se consulta con el texto del usuario y va recortada a
    `VOICEBOT_DELEGATE_CONTEXT_MAX_CHARS` (default 16000, máximo 32000: medido por el voicebot con
    M3, hasta 32k suma ~0,1 s [C54]), con un tope de tiempo `VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS`
    (default 1500);
  - si se vence el tiempo, va sin `context` y se loguea;
  - las dos claves son de pci, en *Voicebot → LLM de voz*;
  - se mide tamaño y latencia, y con eso se fijan los defaults.
- [ ] **Nodo *Transferir a interno*** (`transfer_extension`):
  - toma un número fijo o una persona (su `User.internalPhone`, resuelto por pci [C5]);
  - responde `{type: "transfer", extension}`, `committed: true` y `awaitInput: false`;
  - llega al voicebot como `Refer-To tel:<extension>` [C48];
  - `end` sigue siendo "colgar" (`hangup`).
- [ ] **Tests:** e2e por `voice.turn` de cada modo y nodo, sin LLM real (FakeLlm).

### H4c — Identificación por voz (replanteado, 2026-10-24) — EN ESPERA de un dato

El usuario decidió que el DNI y el legajo **no se cargan en pci**: salen de InvGate, que ya trae
el dato en el usuario, o de la fuente de verdad de la empresa (MCP/n8n). Por eso H4c no lleva
migración ni toca el ABM de usuarios.

**Qué hay hoy en el código.** `InvgateService` busca usuarios con `users.by` por `phones`,
`username` o `email`, y con `user?id=`. `InvgateUser` solo tipa `id`, `username` y `email`; el
resto llega como `[key: string]: unknown`. En ningún lugar del repo figura el nombre del campo del
DNI o del legajo, ni si `users.by` puede filtrar por él. Hace falta **una consulta de solo lectura
a la instancia**, que autoriza el usuario y que se describe abajo.

**Diseño del nodo `voice_identify`.** Es determinístico: no usa el LLM de pci.

- [ ] **Configuración del nodo:**
  - `origen`: `invgate` | `fuente de verdad`;
  - `campo`: el campo de InvGate que tiene el documento (con InvGate);
  - `pregunta`: texto en modo literal o guided;
  - `intentos`: 2 por defecto.
- [ ] **Paso 1, documento:** se normaliza lo que dijo la persona, dejando solo los dígitos (o el
  alfanumérico en mayúsculas si es legajo), y se busca.
  - **InvGate:** si `users.by` filtra por ese campo, una sola llamada por intento.
  - **Si no filtra:** índice en memoria `documento → usuario de InvGate`, armado con el listado
    paginado de usuarios y refrescado cada N minutos (clave nueva, 15 por defecto). Así la llamada
    no paga la latencia del listado. Se mide el costo del refresco.
  - **Fuente de verdad:** un RPC por broker hacia la fuente de la empresa. El contrato propuesto
    es `context-source.identify`: `{documento}` → `{nombre, apellido, email}` o `null`. Para MCP es
    una tool configurada en la fuente; para n8n, un webhook. Se hace después del caso InvGate.
- [ ] **Paso 2, nombre y apellido:**
  - se comparan con los del usuario encontrado, sin tildes ni mayúsculas y por similitud, con un
    umbral, porque el STT se equivoca en letras;
  - un error de documento o de nombre gasta un intento, y la segunda falla sale por
    `no reconocido`.
- [ ] **Cruce con pci:**
  - por **email**: el `User` activo de pci con ese email y membresía en el tenant del interno;
  - si existe, sale por `reconocido`: completa `Conversation.userId` y la identidad del turno (rol
    de la membresía) y carga las variables de usuario, como `start` con un conocido.
- [ ] **Está en InvGate pero no en pci** (para decidir):
  - **(a) Recomendada:** sale por `no reconocido` con
    `flowState.identifiedExternal = {nombre, apellido, email, invgateId}`. Respeta "no hablamos
    con desconocidos" y no crea un `User` fantasma. Si hace falta, en otra etapa `ticket_create`
    puede usar ese `invgateId` como cliente de InvGate sin un usuario de pci.
  - **(b)** Una tercera salida, `solo en InvGate`, para que el flujo decida qué hacer.
  - **(c)** Crear el `User` en pci. No se recomienda: es exactamente lo que se eliminó con "no
    hablamos con desconocidos".
- [ ] **Tests:** InvGate falso (mock del `fetch` del servicio, como `invgate.e2e-spec.ts`) con
  reconocido, documento mal, nombre aproximado, segundo intento, existe solo en InvGate y persona de
  otro tenant.

**Consulta de solo lectura que hace falta, a autorizar:** traer **un** usuario conocido y
mirar **solo los nombres de los campos**, no los valores. Por ejemplo, el usuario técnico
(`INVGATE_API_USER`), que ya se consulta en cada ticket:
`GET {INVGATE_URL}/users.by?username=<INVGATE_API_USER>&exact_match=true`, con la misma auth del
servicio. Sirve para saber cómo se llama el campo del DNI o del legajo. Para saber si `users.by`
filtra por él, una segunda consulta con ese campo y un valor conocido que dé el usuario.

### H4d — LLM de voz por proveedor [DA10, C53] ✅

Hecho el 2026-10-24. Decisiones del coordinador: minimax usa `VOICEBOT_MINIMAX_API_KEY` (DA13); una
`VOICEBOT_LLM_BASE_URL` vacía manda la base URL que pci tiene de ese proveedor (minimax: la de voz).
Cambiar una credencial de origen publica `config.changed` con `sections: ["llm"]`. El modelo usa la
lista del proveedor guardado. Tests BE-INT-28..31 y FE-SET-24.

- [x] Claves nuevas en *Voicebot → LLM de voz*. Viajan con su mismo nombre en
  `/integrations/voicebot/config` y aplican en caliente:

  | Clave | Valores | Default |
  |---|---|---|
  | `VOICEBOT_LLM_PROVIDER` | `openai`, `gemini`, `claude`, `openrouter`, `minimax` | `minimax` |
  | `VOICEBOT_LLM_MODEL` | lista de modelos de `LlmModelsService` para ese proveedor | — |
  | `VOICEBOT_LLM_BASE_URL` | URL | vacío = API oficial |
  | `VOICEBOT_LLM_API` | `anthropic` o `openai`; solo aplica a minimax | — |
  | `VOICEBOT_LLM_MAX_TOKENS` | número | 150 |

  - `opencodego` no aparece en la lista de proveedores: trabaja por sesiones y no tiene streaming.
- [x] `VOICEBOT_LLM_API_KEY` 🔒 **no se carga en ninguna pantalla**. pci la arma al servir la config
  con la key que ya tiene del proveedor elegido (`OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, y para minimax ver la pregunta abierta). Es el mismo
  criterio que `STT_SINK` [C39]: un solo valor por dato.
- [x] Mientras `VOICEBOT_LLM_PROVIDER` no esté guardado, el voicebot sigue con `MINIMAX_LLM_*`. Las
  claves `VOICEBOT_MINIMAX_LLM_*` quedan por compatibilidad.
- [x] **Tests:** e2e de la key derivada para cada proveedor, de que viaja enmascarada en
  `/settings`, de que `opencodego` se rechaza y de la versión con `config.changed`.

### Fuera de H4 (anotado)

- **Grabación (DA12):** solo texto, sin audio.
- **Salientes y "Probar conexión":** H5.

## H5 — Salientes

- [ ] Disparar llamadas salientes desde pci con `call.outbound` (contrato §6) y consumir
  `call.outbound.result`. Definir con el usuario desde dónde se disparan (¿un nodo? ¿una pantalla?)
  antes de implementar.

## Necesito de otros

| De | Qué | Para | Estado |
|---|---|---|---|
| voicebot | Defaults y validaciones vigentes de cada clave | H1 | disponible en `voicebot/apps/api/src/config/env.validation.ts` y `.env.example` |
| stt | Lista de variables del stt con defaults y rangos | H1 | ✅ `stt/docs/INTEGRATION.md` §8.1 |
| voicebot | Consumidor de `health.check` | H1 (probar conexión) | ⏳ (H5 del voicebot) |
| voicebot | Publicación de `voice.events` y `voice.turn` | H3 | ⏳ |
| usuario | DA5, DA6, DA8 (DA1, DA2, DA3, DA13 y DA16 ya decididas) | H3–H4 | ⏳ |

## Entrego a otros

| A | Qué | Hito |
|---|---|---|
| voicebot | `GET /integrations/voicebot/config`, token, `config.changed` | H1 ✅ |
| stt | `GET /integrations/stt/config`, token, `config.changed` | H1 ✅ |
| voicebot | Internos en la config | H2 |
| voicebot | Consumidor de `voice.events` y RPC `voice.turn` | H3 |
