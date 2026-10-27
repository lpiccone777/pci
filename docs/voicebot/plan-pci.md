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

Estado (2026-10-26): ✅ H0 · ✅ H1 · ✅ H2 · ✅ H3 · ✅ H4 · ✅ H5 (cerrado 2026-10-26) · 🔄 C65 (código de pci listo, falta la prueba en vivo). Contrato vigente: **1.26**. Rama: `feat/integracion-voicebot`.

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
- [x] Hecho en H5 (4ebd77d). Pasó a H5 por indicación del coordinador (no había consumidor de `health.check` todavía). **"Probar conexión"** del voicebot por `health.check` (contrato §6), por RPC del broker,
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

## H4 — Flujos de voz ✅ (cerrado por el usuario, 2026-10-25)

Aprobado en la prueba en vivo (repo voicebot a440c96, `estado.md`). Único pendiente, que no
bloquea: el `transfer` (nodo *Transferir a interno*) no se probó en vivo con MicroSIP.

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

### H4b — Cómo habla cada nodo, transferencia y menú sin LLM ✅

Hecho el 2026-10-24. Modo de habla por nodo (`data.speechMode`), menú por voz sin LLM
(`voice-menu.util.ts`: número, palabra u ordinal, o etiqueta aproximada; la etiqueta gana sobre el
número, porque "hablar con una persona" no es la opción 1), pregunta de extracción `guided`,
`context` del `delegate` con tope (16000, máximo 32000 [C54]) y espera (1500 ms), y nodo
*Transferir a interno*. Tests BE-VOZ-24..28 y FE-VFLW-04.

- [x] **Modo de habla por nodo** (contrato §5.4):
  - cada nodo que habla (`start`, `message`, `menu`, `input`, `end` y el texto de `ticket_create`)
    elige `literal` (default, el texto exacto) o `guided`;
  - en `guided`, el texto del nodo es la `instruction` y `facts` lleva las variables `{{x}}` que
    usa, ya resueltas;
  - el editor muestra el selector solo en los flujos de voz, y recuerda que con `guided` en el
    `start` el voicebot agrega "(Atendiste la llamada.)" [C48].
- [x] **Menú por voz sin LLM de pci:**
  - match determinístico por número ("1", "uno", "la primera"), por etiqueta y por similitud;
  - si no matchea, un `guided` que repite las opciones; a la segunda falla, `delegate` (como el
    fallback de hoy);
  - por voz no se llama a `interpretMenuChoice`, y la detección de cancelación de `input` (LLM)
    no corre por voz.
- [x] **`llm_query` en modo extracción por voz:**
  - la pregunta por un dato faltante sale como `guided` ("Pedile el dato X"), sin
    `generateLlmQueryQuestion`;
  - la extracción sigue usando el LLM de pci (no hay otra forma). Se mide y se loguea, y queda
    fuera del presupuesto de 300 ms.
- [x] **`context` del `delegate`** (§5.4):
  - la fuente de verdad del flujo se consulta con el texto del usuario y va recortada a
    `VOICEBOT_DELEGATE_CONTEXT_MAX_CHARS` (default 16000, máximo 32000: medido por el voicebot con
    M3, hasta 32k suma ~0,1 s [C54]), con un tope de tiempo `VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS`
    (default 1500);
  - si se vence el tiempo, va sin `context` y se loguea;
  - las dos claves son de pci, en *Voicebot → LLM de voz*;
  - se mide tamaño y latencia, y con eso se fijan los defaults.
- [x] **Nodo *Transferir a interno*** (`transfer_extension`):
  - toma un número fijo o una persona (su `User.internalPhone`, resuelto por pci [C5]);
  - responde `{type: "transfer", extension}`, `committed: true` y `awaitInput: false`;
  - llega al voicebot como `Refer-To tel:<extension>` [C48];
  - `end` sigue siendo "colgar" (`hangup`).
- [x] **Tests:** e2e por `voice.turn` de cada modo y nodo, sin LLM real (FakeLlm).

### H4c — Identificación por voz ✅

Hecho el 2026-10-24, sin migración y sin tocar el ABM de usuarios. El usuario decidió que DNI y
legajo no se cargan en pci: salen de InvGate.

**Lo verificado contra la instancia real.** Consultas de solo lectura autorizadas por el usuario,
imprimiendo solo campos y tipos:
- El usuario de InvGate trae `employee_number`: 8 dígitos, cargado en ~75 % de los usuarios. En la
  empresa actual el DNI se usa como legajo.
- El campo `doc` existe pero está vacío.
- `users.by?employee_number=…&exact_match=true` filtra por ese campo: un resultado, ~0,5 s. Es una
  llamada por intento.

**Decisiones.**
- Qué se pide es configurable por nodo (`idLabel`: documento | legajo). El campo es
  `employee_number` por defecto, con `doc` como alternativa.
- Con InvGate sin configurar, el nodo sale por "no reconocido" con un log, y el editor lo avisa.
  `INVGATE_API_URL` vacío en la BD es intencional y no se toca.
- Si la persona está en InvGate pero no en pci, sale por "no reconocido" con
  `flowState.identifiedExternal` (opción a).

**Implementado.**
- [x] Nodo `voice_identify`, solo en flujos de voz; el backend lo rechaza en los de texto.
- [x] Funcionamiento:
  1. pide el documento o el legajo y lo normaliza (solo dígitos si hay 6 o más; si no,
     alfanumérico);
  2. busca en InvGate (`InvgateService.findActiveUsersBy`, que excluye `is_disabled` e
     `is_deleted`); más de una coincidencia no identifica a nadie;
  3. pide nombre y apellido y los compara de forma aproximada (`voice-identify.util.ts`: Levenshtein
     por palabra, umbral 0,75; el apellido completo y al menos un nombre);
  4. cruza con el `User` de pci por email, con membresía en la empresa del interno.
- [x] Al reconocer:
  - completa `Conversation.userId`, la identidad del turno (rol de la membresía) y las variables de
    usuario de `flowState`;
  - los turnos siguientes cargan ese usuario (`voiceCaller`), así que `ticket_create` y
    `transfer_agent` funcionan.
- [x] `GET /features` suma `invgate`, para el aviso del editor.
- [x] Tests: BE-VOZ-20..23 (InvGate falso), BE-VFLW-04, FE-VFLW-03 y los unitarios de
  `voice-identify.util`.
- [ ] Fuente de verdad (MCP/n8n) como origen alternativo: el contrato `context-source.identify`
  queda para cuando haga falta.
- [ ] Prueba en vivo contra InvGate: la coordina el coordinador.
- [x] **C55 (contrato 1.15, usuario):** con InvGate sin configurar (desarrollo) el nodo no pide
  documento ni legajo: valida nombre y apellido, con la misma tolerancia, contra los usuarios de pci
  de la empresa de la llamada. Una coincidencia → reconocido con su rol; ninguna o más de una → un
  intento más y después no reconocido. Con InvGate configurado sigue como arriba. Tests BE-VOZ-23 y
  BE-VOZ-29.

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

### Después de la prueba en vivo de H4 (2026-10-24)

- La primera prueba cayó en charla libre: el único flujo de voz estaba asignado como inicio a otra
  empresa que la de los internos 201 y 202 (DA8 nunca toma un flujo de otra empresa). Se arregla
  asignándolo a la empresa del interno. Desde 82edcac cada llamada loguea por qué paso resolvió su
  flujo (el del interno, el de inicio de la empresa o charla libre) y si se ignoró el del interno.
- [x] **Flujo propio por interno** (DA8, paso 1; aprobado por el coordinador): el selector de
  *Voicebot → Internos* quedó habilitado y la API acepta `flowId`, solo flujos de voz activos
  asignados a la empresa del interno (`GET /voicebot/extensions/flow-options?tenantId=`). Si
  después se desasigna, el motor lo ignora y cae al de inicio (lo marca el log y la tabla dice
  "no disponible"). Tests BE-EXT-10 y FE-SET-21.

- [x] **Menú: opción sin salida conectada** (decisión del usuario en la prueba en vivo, 2026-10-24;
  comportamiento del motor de pci, no va al contrato): en texto y en voz, si la opción elegida no
  tiene salida, se queda en el menú, avisa que no está disponible y lo repite. Antes caía en la
  primera arista del nodo, que era la de otra opción ("Opción 2" decía lo de la opción 1). Tests
  CHAT-N-MENU-14 y BE-VOZ-30.

- [x] **DTMF (C57, contrato 1.17):** `voice.turn` acepta `dtmf` (una tecla: 0–9, `*`, `#`), sola o
  con texto. El menú la usa primero para elegir la opción por número; en los demás nodos se suma
  al texto como si se hubiera dicho el dígito. El mensaje del usuario queda "[tecla N]". Test
  BE-VOZ-31.

- [x] **Start repetido (C59, contrato 1.19):** un voicebot reiniciado a mitad de llamada reatendió
  el mismo room y mandó un segundo `start` con el mismo callId; pci lo tomó como respuesta al menú.
  Ahora un `start` de una llamada que ya tuvo start se ignora, se responde lo mismo que al primero
  y se loguea. (El voicebot, por su lado, ya no reatiende llamadas en curso tras un reinicio.)
  Test BE-VOZ-32.

- [x] **voiceLiterals (C60, contrato 1.20):** `GET /integrations/voicebot/config` trae
  `voiceLiterals`: los `say literal` fijos de los flujos de voz activos, para que el voicebot los
  sintetice de antemano. Incluye textos de nodos en literal, el menú con y sin "Volver", el aviso de
  opción no disponible y las preguntas y reintentos de identificación. No incluye los guided ni los
  que tienen `{{variables}}`, y no repite. El motor arma esos textos con las mismas funciones
  (`voice/voice-literals.ts`), así la lista no se desfasa. Guardar, borrar o reasignar un flujo de
  voz sube la versión y publica `["flujos-voz"]`. Con el flujo de hoy son 18 textos (~1 KB). Tests
  BE-INT-34 y unitarios.

- [x] **Menú por voz, ajustes de la prueba en vivo (2026-10-25, usuario):** una palabra numérica
  ("una", "dos") solo elige en una frase de hasta 3 palabras o justo después de "opción", "número",
  "la" o "el"; los dígitos valen siempre. "Tenés una fuente de verdad…" ya no elige la opción 1.
  Una tecla sin opción dice en literal "La opción N no existe." y repite el menú; ese aviso entra en
  `voiceLiterals`. Tests unitarios del menú y BE-VOZ-33.

- [x] **El LLM del flujo opera la fuente MCP con sus tools (C61, contrato 1.21, usuario
  2026-10-25, opción A con voz):** con una fuente MCP, el LLM del flujo (`llm_query` en modo charla
  y el de respaldo) recibe como tools las configuradas en la fuente, elige tool y argumentos y
  encadena hasta 3 vueltas (p. ej. `geocoding` de la ciudad → `weather_forecast` con esas
  coordenadas). Sin cambios en los nodos. Detalle:
  - **Tools:** solo las configuradas; descripción y esquema del `tools/list` del servidor, con caché
    de 5 min por fuente (se invalida al editarla).
  - **Fijos:** un argumento de la configuración con valor real (no vacío, sin `{{pregunta}}`,
    distinto de 0) es fijo: sale del esquema y pci lo inyecta encima de lo que mande el LLM. Lo
    demás lo completa el LLM.
  - **Proveedores:** tool calling en OpenAI, OpenRouter, MiniMax (los tres por la API compatible),
    Claude y Gemini. OpenCode Go no tiene: sigue la pre-consulta de siempre.
  - **Voz:** se resuelve antes de responder `voice.turn`. El LLM de pci mira la charla, solo trae
    datos (no contesta) y los resultados van como `context` del `delegate`; la forma de la acción no
    cambia. Todo dentro de `VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS` (default 7000): lo que respondió a
    esa hora es el `context`. Tope: `VOICEBOT_DELEGATE_CONTEXT_MAX_CHARS` (C54).
    `VOICEBOT_TURN_TIMEOUT_MS` pasa a default 8000. En la BD no hay valores guardados que los pisen
    (verificado 2026-10-25).
  - **Log por turno:** vueltas, cada tool con su duración y si respondió bien, tamaño del `context`
    y tiempo total. Nunca argumentos ni contenido.
  - **I/O:** cola RPC nueva `context-source.mcp.call-tool` (connector), además de
    `context-source.mcp.list-tools`.
  - **Para que la fuente "clima" encadene:** `geocoding` tiene que estar entre sus tools
    configuradas (hoy solo está `weather_forecast`, con `temperature_unit: "{{pregunta}}"`). Eso se
    configura en la fuente; pci no la toca.
  - Tests: SRC-TOOLS-01..03, BE-VOZ-34 (MCP falso con `geocoding` y `weather_forecast`) y
    unitarios del loop y de la traducción por proveedor.

- [x] **Menú por voz: el reintento ofrece hacer una consulta (usuario, 2026-10-25, sin cambio de
  contrato):** se mantiene la regla de dos intentos. En el primer no-match, el `guided` que repite
  las opciones pregunta también si prefiere hacer una consulta; el segundo no-match sigue yendo a
  `delegate` con la fuente (C61). Motivo: en la prueba en vivo de las 11:06 la pregunta del clima
  cayó en ese primer reintento y la persona cortó antes de llegar a la fuente. Solo voz: por
  WhatsApp el menú de texto no tiene reintento (el clasificador con LLM manda directo a la charla
  libre en el primer no-match). Test BE-VOZ-25.

- [x] **Primer audio con la llamada atendida (C62, contrato 1.22):** clave nueva
  `VOICEBOT_ANSWER_MARGIN_MS` (SIP entrante, default 500): margen desde que la llamada pasa a
  `active`. `VOICEBOT_SIP_INBOUND_GREET_DELAY_MS` cambia de sentido: es el tope desde que entra el
  participante, por si `active` nunca llega (default 8000; antes era el mínimo, 2000). Solo
  catálogo: lo aplica el voicebot.

- [x] **Log de las tools por voz (2026-10-25, prueba en vivo de las 11:26):** cuando vence el tiempo
  el log decía "0 vueltas"; ahora cuenta las vueltas igual y suma la duración de cada paso del LLM
  y el mensaje de error de una tool que falla. En esa llamada todos los delegate llegaron al tope
  de 7 s: con MiniMax-M3.1-Flash razonando, cada paso del LLM tarda ~2,5–3 s y la cadena geocoding
  → forecast no entra.

- [x] **Por voz, las tools las elige el LLM de voz (nota de C61, usuario 2026-10-25):** el
  `delegate` por voz usa la config `VOICEBOT_LLM_*` (C53) y no el LLM del chat. Mismas credenciales
  que pci le sirve al voicebot, sin clave nueva (`LlmProviderFactory.createVoiceToolProvider`).
  MiniMax por la interfaz anthropic va a `<host>/anthropic` con `thinking: disabled`, temperature 0,
  400 tokens por paso y sin reintentos. El chat sigue con su LLM.
  - **Prueba real (2026-10-25, 9 llamadas, de a una cada 3 s, sin 429):** la interfaz anthropic de
    MiniMax-M3 acepta tools con `thinking: disabled`: devuelve `tool_use` sin bloques de
    razonamiento, y la cadena eligió `geocoding("Merlo, Buenos Aires, Argentina")` →
    `weather_forecast(-34.66536, -58.72744, forecast_days 2, daily […], timezone)` → pronóstico
    real. Las tools del MCP tardaron ~1 s (geocoding) y ~0,7–1 s (forecast).
  - **Latencia de MiniMax ese día, muy variable:** 2,9 a 5,4 s por paso con tools, y 10,4 s una
    respuesta de 32 tokens sin tools. Con esos tiempos la cadena no entra en los 7 s: el límite lo
    pone el servidor de MiniMax, no las tools. El log por turno muestra la duración de cada paso.

- [x] **Flujo de voz sin paso siguiente (C64, contrato 1.25, usuario 2026-10-25):** en la prueba
  en vivo (int-_201_JSWNCFL7eGP7) la rama "Consulta" terminaba en un `input` sin salida. pci
  respondió sin acciones y el voicebot se quedó 28 s callado. Ahora, con `awaitInput`, siempre hay
  un `say`:
  - **Fallback:** un tramo sin `say` agrega VOICEBOT_END_FALLBACK_TEXT ("¿Algo más en lo que te
    pueda ayudar?") con `noInputMs` = VOICEBOT_END_FALLBACK_NO_INPUT_MS (8000, se lleva a
    3000–30000) y un warn con el nodo. La conversación queda marcada (`flowState.__endFallback`,
    con el último menú del `__menuStack` y el estado del flujo).
  - **`no_input`** (turno nuevo) o una negativa corta (`isShortNegative`): VOICEBOT_END_FALLBACK_
    GOODBYE_TEXT + `hangup`, `committed: true`.
  - **Otra respuesta:** se toma contra el último menú mostrado (elige la opción o lo repite). Sin
    menú, el flujo rearranca desde `start` sin el saludo (`flowState.__skipGreeting`).
  - Los dos textos van en `voiceLiterals`; cambiarlos avisa como un flujo de voz (`flujos-voz`).
  - **Editor:** POST/PATCH de `/voice-flows` devuelven `warnings` de nodos sin salida (`input`,
    `message`, opción de menú), sin bloquear. El editor los muestra al guardar.
  - Tests: BE-VOZ-35..37, BE-VFLW-07 y unitarios de `isShortNegative`.

### Tool calling en el LLM de voz — DESCARTADO por el usuario (2026-10-25)

Queda como registro de lo que se propuso; no se implementa.

#### Posición de pci (propuesta descartada)

Pedido del usuario (2026-10-25, opción B): el LLM de voz recibe como tools las fuentes de verdad
del flujo y las pide cuando le hacen falta. La forma la propone el voicebot en su
`plan-voicebot.md`, "Tool calling en el LLM de voz", punto 3. pci está de acuerdo con esa forma,
con estos ajustes:

**Cómo arma pci las `tools` de cada `say delegate` (y `guided`).**
- **Fuentes:** la MCP del flujo (`Flow.contextSourceId`, hoy una por flujo). Sumar las demás de la
  empresa lo decide el usuario.
- **Tools:**
  - solo las que están configuradas en la fuente;
  - `description` y `parameters` salen de `listMcpTools`, con caché de 5 min por fuente para no
    pagarla en cada turno.
- **`name`:**
  - lo arma pci como `<fuente>__<tool>`, normalizado a `^[a-zA-Z0-9_-]{1,64}$`;
  - si no entra, se recorta y se agrega un hash corto;
  - es único dentro de la llamada.
- **Argumentos fijos de la configuración** (lat/long, `celsius`, `daily`):
  - pci los saca de `parameters` y los inyecta al ejecutar, así el LLM no los ve ni los pisa;
  - lo que tiene `{{pregunta}}` o está vacío queda en el esquema para que lo complete el LLM.
- **Pre-consulta:** con tools expuestas, pci deja de pre-consultar esa fuente para `context`. Hoy
  esa pre-consulta es justamente el 1,1–1,6 s de cada delegate; ver "Latencia" abajo. `context`
  sigue para lo que sí se arma antes.
- **Skills:** siguen en `systemPrompt`, como texto fijo. No son tools.

**RPC `voice.tool`.** Va con la forma propuesta y estos ajustes:
- **Validación:** pci no confía en `sourceId` ni en `name`. Solo acepta un par (`name`, `sourceId`)
  que ofreció en un `delegate` de esa misma llamada (lo guarda en `VoiceTurn`) y que pertenece a la
  empresa del interno. Si no, `unknown_tool`.
- **Errores:** a los cuatro propuestos (`unknown_tool`, `invalid_arguments`, `source_unavailable`,
  `timeout`) pci suma dos:
  - `unknown_call`, si la llamada no existe en pci;
  - `internal`.
  - En `invalid_arguments` va el mensaje de validación del MCP (p. ej. "expected one of
    celsius|fahrenheit at temperature_unit"), para que el LLM corrija en la vuelta siguiente.
- **Timeout:** pci corta en `VOICEBOT_TOOL_TIMEOUT_MS` − 500 ms (3500 si el voicebot usa 4000) y
  responde `timeout`, así la respuesta llega antes de que el voicebot se rinda.
- **`result`:** texto recortado a `VOICEBOT_TOOL_RESULT_MAX_CHARS`, una clave de pci con default
  8000. Si se recorta, se loguea.
- **Identidad:**
  - pci ejecuta con el tenant de la llamada;
  - las fuentes MCP de hoy no reciben usuario: usan las credenciales de la fuente, que son por
    empresa;
  - si hace falta el usuario identificado, eso es otra decisión.
- **Lease por llamada:** el RPC de tools no lo toma, porque no toca la conversación ni el flujo.
  Así no se traba contra un `voice.turn` de la misma llamada.
- **Log:** nombre de la tool, duración, tamaño del resultado y error. Nunca el contenido.

**Alcance.**
- MCP: sí.
- Fuente tipo `broker` (`{text}` → `{answer}`): sí, como una tool `consultar_<fuente>` con un solo
  parámetro `pregunta`.
- RAG y n8n: cuando tengan contrato de consulta, del mismo modo.

**Latencia, medida el 2026-10-25 contra la fuente "clima" en solo lectura.**
- **Hoy:** el delegate tarda 1,1–1,6 s. Es la pre-consulta: 9 tools en paralelo, 8 fallan por
  argumentos mal configurados y `geocoding` tarda ~1 s sin encontrar nada.
- **Una tool bien configurada:** `weather_forecast` con lat/long, `daily` y `forecast_days` tarda
  ~0,26 s y trae el pronóstico real. Con sesión MCP nueva por RPC (~50 ms), el RPC típico queda en
  0,3–1 s.

**Esfuerzo de pci:** mediano, ~1,5–2 días.
- armado de tools con caché y fusión de argumentos fijos;
- `tools` en `say`;
- consumidor `voice.tool` con validación;
- dos claves (timeout y tope del resultado);
- e2e con el MCP falso (`test/support/fake-mcp-server.ts`).

### Fuera de H4 (anotado)

- **Grabación (DA12):** solo texto, sin audio.
- **Salientes y "Probar conexión":** H5.

## H5 — Salientes ✅ (contrato 1.24, C63; cerrado 2026-10-26)

**Cierre (2026-10-26):** el coordinador cerró H5 (`estado.md` del voicebot, 2e81bbb) después de la
prueba en vivo de la saliente con flujo, del sink HTTP con dos llamadas a la vez y de C64
(contrato 1.25). Commits de pci: cea3425, 633c7b8, ab99029, 9d91334, 4ebd77d, 30a62b8, 0467525,
af30383 (C64) y a897206 (placeholder de `STT_HTTP_URL` al 3002).

**Estado (2026-10-25):** plan aprobado por el usuario e implementado en pci, en seis partes
(cea3425, 633c7b8 + ab99029, 9d91334, 4ebd77d, 30a62b8 y la de descripciones y docs). La migración
`20261025180000_voice_outbound` está aplicada en la BD real (autorizado por el usuario). Falta el
build, el reinicio coordinado y la prueba en vivo contra un número real por el trunk de siempre: el
usuario no aprobó la línea a MicroSIP, así que la protección es la lista de prefijos.

Decisiones del usuario (2026-10-25), que ajustan el plan de abajo:
- Disparo: pantalla `/dashboard/voice-calls` y API `POST /voice/outbound-calls`. El nodo "Llamar" y
  las campañas, más adelante.
- **Sin tope propio de salientes:** cuentan para `VOICEBOT_MAX_CALLS` del voicebot; si se pasa,
  llega `busy` y pci reintenta sin contar ronda. No existe `VOICE_OUTBOUND_MAX_CONCURRENT`.
- Lista de prefijos permitidos: `VOICEBOT_OUTBOUND_ALLOWED_PREFIXES` (vacía = cerrado). La espera
  entre intentos es `VOICEBOT_OUTBOUND_RETRY_DELAY_MS` (default 60000). Llevan el prefijo
  `VOICEBOT_` por la convención del catálogo (BE-INT-12).
- Audio + dígito solo por la API; la saliente arranca sin usuario (DA5).

### Plan aprobado (texto original)

Alcance (usuario, 2026-10-25): salientes desde pci (§6) + sink HTTP multi-llamada (§4). DA9 (sacar
las páginas de prueba) es del voicebot. Lo marcado **[decide el usuario]** son opciones, no
decisiones. Preguntas de forma abiertas con voicebot-73 (ver "Necesito de otros").

### 1. Cómo dispara pci una saliente

- **Desde dónde:** **[decide el usuario]**. Mi recomendación para H5 es (a) + (b). (c) y (d)
  quedan para después.
  - (a) **Pantalla** `/dashboard/voice-calls`, en el menú de voz:
    - formulario: números (uno o varios, para la rotación), flujo de voz de la empresa activa y
      reintentos;
    - debajo, la lista de salientes con su estado.
  - (b) **API** `POST /voice/outbound-calls` (JWT + `TenantGuard` + permiso). Es lo que usa la
    pantalla, y sirve para n8n y otras integraciones.
  - (c) **Nodo de flujo** "Llamar": p. ej. un flujo de chat que dispara una llamada al cerrar un
    ticket.
  - (d) **Campañas:** lista de números, horario permitido, concurrencia y reporte. Es un hito propio.
- **Permiso:** `voice_outbound` (RBAC por datos en el seed, como `voice_flows` DA6). Se le asigna
  a SuperAdmin; los demás roles, desde la administración.
- **Modo:**
  - **con `flowId`:** la llamada entra al circuito de turnos de §5. Es el modo de la UI.
  - **audio + dígito:** sin `flowId`; `audioUrl`, `digits` y `maxRounds`, como hoy n8n. Solo por
    la API, para paridad. **[decide el usuario]** si también va en la pantalla.
  - El flujo tiene que ser de voz y estar asignado a la empresa activa (`TenantFlow`). Nunca uno de
    otra empresa.
- **Modelo nuevo** (una migración):
  - `VoiceOutbound`, la saliente lógica: `tenantId`, `createdById`, `flowId?`, `to[]`, `mode`,
    `audioUrl?`, `digits?`, `maxRounds`, `retryDelayMs`, `status`
    (`pending|calling|done|failed|cancelled`), `outcome?`, `nextAttemptAt?`.
  - `VoiceOutboundAttempt`, cada `call.outbound`: `callId`, `to`, `round`, `outcome`, `answered`,
    `digit`, `lastAttempt`, `startedAt`, `endedAt`.
- **Publicar:** `call.outbound` en `voicebot.commands` con
  `{v, callId, to, flowId?, audioUrl?, digits?, maxRounds?, rotationKey: <VoiceOutbound.id>, resetRotation}`.
  - `callId` (`out-<uuid>`) lo genera pci y crea el intento antes de publicar. voicebot-73 lo acepta
    y valida `/^out-[A-Za-z0-9-]{1,64}$/`; si ya está en curso, responde error y no disca.
  - `resetRotation` va en `true` solo en el primer intento.
  - Por el broker, nunca HTTP directo (regla de desacople).
  - Un intento a la vez por saliente: el siguiente `call.outbound` sale recién después del
    `call.outbound.result` del anterior. El voicebot no frena dos en paralelo con el mismo
    `rotationKey`.
- **Resultado:** consumidor de `call.outbound.result` en `voice.events`:
  - actualiza el intento;
  - decide si sigue.
- **Rotación y reintentos [C34], del lado de pci** (outcomes según voicebot-73):
  - **Modo flujo:**
    - `answered` (valor nuevo) sale apenas atienden y corta los reintentos. El cierre llega por
      `call.ended`, como en una entrante.
    - Con `no-answer` se reintenta.
    - Con `busy` (valor nuevo: no se discó por el tope C46) se reintenta sin contar ronda.
    - Con `exhausted` se termina.
  - **Modo audio + dígito:** igual que hoy en `CallSessionService`.
    - `digit` corta.
    - `no-answer`, `no-digit` y `hangup` reintentan. `hangup` con `answered: true` significa que
      atendió y cortó sin marcar.
    - Siempre hasta `lastAttempt` o `exhausted`.
  - El voicebot no impone una espera mínima entre intentos: la pone pci.
  - La espera entre intentos es una clave nueva de pci, `VOICEBOT_OUTBOUND_RETRY_DELAY_MS` (default
    60000), y se persiste en `nextAttemptAt`. Un barrido cada 10 s publica los vencidos, así un
    reinicio de pci no pierde reintentos.
  - Cancelar desde la UI: `call.hangup` con `resetRotation` y `status: cancelled`. Con una llamada
    en curso, termina con `call.ended`, `endReason: "bot_hangup"` (propuesta de voicebot-73) y
    `lastSpoken`. Responde `{v, ok}`, con `ok: false` si el `callId` no existe.
- **Tope de simultáneas:** C46 ya limita en el voicebot. pci no publica más de N intentos
  `calling` a la vez (clave `VOICE_OUTBOUND_MAX_CONCURRENT`, default 2), así no choca con las
  entrantes. **[decide el usuario]** el valor.

### 2. `sip.provision` y `health.check` en la UI

- **Dónde:** subpestaña Voicebot de `/settings` (doble candado: `SystemTenantGuard` + permiso
  `settings`).
  - **"Probar conexión"** → `health.check` por RPC (timeout ~5 s). Muestra `ok`, LiveKit, RabbitMQ,
    MiniMax, `configVersion` contra la versión de pci (avisa si el voicebot está desfasado) y
    llamadas activas.
  - **"Re-provisionar SIP"** (grupo SIP) → `sip.provision` por RPC (timeout ~20 s). Muestra trunks
    y rules. Es para reparar a mano: los cambios de SIP ya se aplican en caliente con
    `config.changed`.
- Los dos pasan por `BrokerService.request` a `voicebot.commands`, con `replyTo` y `correlationId`
  como `voice.turn`, igual que el resto del I/O externo. Timeouts confirmados por voicebot-73:
  health 5 s (debería tardar menos de 1 s) y provision 20 s.

### 3. Conversación de una saliente con flujo

- Pci crea el intento antes de publicar.
- En el `start` (`callId` `out-*`, `call` = `{direction: "outbound", extension: null,
  calledNumber: <el número marcado, el remoto>, callerNumber: <SIP_TRUNK_NUMBER, puede ir vacío>}`),
  `VoiceTurnsService` no busca interno: busca el `VoiceOutboundAttempt` por `callId`. Ojo: en una
  saliente el remoto es `calledNumber`; en una entrante, `callerNumber`.
  - **Con intento:** abre `VoiceCall` + `Conversation` (`channel voice`, `userId null`) con:
    - la empresa de la saliente, que es la empresa activa de quien la lanzó;
    - `direction outbound`, `extensionId null`;
    - `calledNumber` = el número marcado.
  - **Sin intento:** error `unknown_call`, y el voicebot corta.
- **Flujo:** el de la saliente, que va primero en `resolveCallFlow`. Si se borró o se desasignó,
  la llamada sigue con la charla libre de esa empresa, igual que DA8 (3).
- **Identidad:** como en las entrantes (DA5), arranca sin usuario y el flujo puede identificar con
  `voice_identify`. **[decide el usuario]** si, cuando la saliente se lanza a un usuario de pci
  elegido de la lista, la conversación arranca ya con ese usuario.
- **Migración:** `VoiceCall.extensionNumber` pasa a nullable y se suma `VoiceCall.outboundAttemptId`.
- Cada intento atendido es una conversación propia. Los no atendidos no abren conversación.

### 4. Sink HTTP multi-llamada

- Lo implementan stt y voicebot (`?room=<callKey>` en cada job, §4). En pci no hace falta clave
  nueva: `VOICEBOT_SOURCE=http` ya deriva `STT_SINK=http` [C39], y `STT_HTTP_URL` sigue siendo la
  base.
- **De mi lado:**
  - actualizar la descripción de `STT_HTTP_URL` y `VOICEBOT_SOURCE` (http deja de ser de una sola
    llamada);
  - test de que la config del stt sigue igual.
  - Si voicebot o stt piden una clave nueva, va por contrato.

### 5. Riesgos y esfuerzo

- **Cambios de contrato que necesita este plan** (propuestos con voicebot-73; los aprueba el
  coordinador):
  - `callId?` en `call.outbound`;
  - outcomes nuevos `answered` y `busy` en modo flujo; `answered` sale al atender, no al terminar;
  - `call.hangup` de pci → `call.ended` con `endReason: "bot_hangup"`.
- **Riesgos:**
  - la carrera `start` contra la respuesta RPC queda resuelta con el `callId` que genera pci;
  - reintentos duplicados con dos instancias de pci: el barrido toma cada saliente con un UPDATE
    condicionado, como el lease de turnos;
  - discar a números reales en pruebas: en desarrollo solo a MicroSIP o a internos de prueba, con
    una lista permitida opcional (`VOICEBOT_OUTBOUND_ALLOWED_PREFIXES`) **[decide el usuario]**;
  - costo y abuso: permiso propio, tope de simultáneas y log de quién lanzó cada una.
- **Esfuerzo de pci:** ~2–3 días.
  - modelo y migración, API y barrido de reintentos: 1 día;
  - pantalla: 0,5 día;
  - salientes en `VoiceTurnsService`: 0,5 día;
  - health y provision en `/settings`: 0,5 día;
  - tests e2e con broker real (el test hace de voicebot, como BE-VOZ): 0,5 día.

## C65 — Avisos durante esperas largas 🔄 (contrato 1.26, pedido 2026-10-26)

Decisión del usuario (2026-10-26): mientras se espera algo largo, el bot va diciendo avisos
variados ("sigo acá, estoy buscando"). Propuesta conjunta con voicebot-3e, aprobada con (c) avisos
también en la espera del LLM de voz (lado voicebot), (d) los textos los propone el LLM de pci y el
admin los revisa, y (e) `VOICEBOT_DELEGATE_CONTEXT_TIMEOUT_MS` 12000, limitado a 7000 sin
`progress: true`.

Hecho en pci:
- [x] **Aviso de progreso** (§5.3): con `progress: true` en el `voice.turn`, pci manda al `replyTo`
  (mismo `correlationId`, pattern `voice.turn.reply`, `data.kind: "progress"`) un aviso al entrar a
  cada paso lento: `source` (con `label` = `voiceName` y `expectedMs` = la espera de la fuente),
  `webhook` (10000), `identify` y `ticket` (15000, InvGate), `delay` (lo del nodo). El emisor
  (`VoiceProgressFn`) se enhebra por parámetro desde `VoiceTurnsService` hasta `executeNode`. Un
  replay de un `turnId` ya procesado no los reemite.
  - Hoy por voz no salen `delay` ni el `ticket` de `ticket_query`: esos nodos están en
    `VOICE_UNSUPPORTED_NODES`. `ticket` sale de `ticket_create` (con la persona identificada).
- [x] **`ContextSource.voiceName`** (migración `20261026120000_context_source_voice_name`, aplicada
  por el usuario el 2026-10-26): campo "Nombre para voz" en `/dashboard/context-sources`. Cambiarlo
  sube la versión y manda `config.changed` `["flujos-voz"]`.
- [x] **Claves** (grupo Conversación, del voicebot): `VOICEBOT_WAIT_TEXTS`, `_SOURCE`, `_TICKET`,
  `_IDENTIFY`, `_WEBHOOK`, `_DELAY` (un texto por línea, hasta 10 de 200 caracteres; `{label}` solo
  en `_SOURCE`, validado en `settingLines`/`lines` del catálogo), `VOICEBOT_WAIT_INTERVAL_MS` (4500),
  `VOICEBOT_WAIT_MAX` (3), `VOICEBOT_TURN_TIMEOUT_MAX_MS` (20000).
- [x] **Expansión de `{label}`**: `voiceLiterals` suma cada texto de las listas y los de `{label}`
  una vez por `voiceName` de fuente activa (`expandWaitTexts`).
- [x] **"Proponer variantes"** en `/settings`: `POST /settings/:key/propose-variants` (el LLM de pci
  vía `LlmService`, `settings:update`) devuelve textos **sin guardar**; la UI los suma al borrador
  con un aviso de "sin guardar" y el admin los revisa y guarda.
- [x] Tests: `test/wait-texts.e2e-spec.ts` BE-WAIT-01..05; `test/voice.e2e-spec.ts` BE-VOZ-38..40.
- [x] **Ajuste tras la prueba en vivo** (usuario, 2026-10-26; un "gracias" sonó "Sigo acá, estoy
  buscando" y pagó 3,5 s del LLM de tools): con una fuente MCP con tools, el `progress` `source` sale
  recién cuando el LLM pide la primera tool, con el `expectedMs` que queda; sin tools pedidas no hay
  aviso. Un turno que es solo cortesía o cierre va al `delegate` sin consultar la fuente
  (`isVoiceCourtesy`, regla de vocabulario aprobada el 2026-10-27 tras "Perfecto, muchas gracias."
  en vivo: los cierres de C64, o hasta 6 palabras todas de cortesía con al menos un ancla —gracias,
  chau, adiós, nada o "eso es todo"—; un afirmativo suelto no entra).
- [ ] Prueba en vivo con el voicebot (la coordina el coordinador).
- [ ] Playwright del campo "Nombre para voz" y del botón "Proponer variantes".

## Necesito de otros

- **voicebot-73 (H5):** respondió el 2026-10-25 (su plan, "Plan de H5", 586c0e4). Lo que cambia
  el contrato está en "Cambios de contrato que necesita este plan", arriba.

| De | Qué | Para | Estado |
|---|---|---|---|
| voicebot | Defaults y validaciones vigentes de cada clave | H1 | disponible en `voicebot/apps/api/src/config/env.validation.ts` y `.env.example` |
| stt | Lista de variables del stt con defaults y rangos | H1 | ✅ `stt/docs/INTEGRATION.md` §8.1 |
| voicebot | Consumidor de `health.check` | H1 (probar conexión) | ✅ (H5 del voicebot, cerrado 2026-10-26) |
| voicebot | Publicación de `voice.events` y `voice.turn` | H3 | ⏳ |
| usuario | DA5, DA6, DA8 (DA1, DA2, DA3, DA13 y DA16 ya decididas) | H3–H4 | ⏳ |

## Entrego a otros

| A | Qué | Hito |
|---|---|---|
| voicebot | `GET /integrations/voicebot/config`, token, `config.changed` | H1 ✅ |
| stt | `GET /integrations/stt/config`, token, `config.changed` | H1 ✅ |
| voicebot | Internos en la config | H2 |
| voicebot | Consumidor de `voice.events` y RPC `voice.turn` | H3 |
