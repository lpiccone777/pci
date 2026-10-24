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

Estado (2026-10-23): ✅ H0 · 🔄 H1 · ⏳ H2–H5. Contrato vigente: **1.0**. Rama: `feat/integracion-voicebot`.

## H0 — Contrato ✅

- [x] Revisar `contrato.md` desde el lado de pci. En especial:
  - §5 (turnos) contra `ConversationsService`;
  - DA1, DA2 y DA3, que tocan reglas de `AGENTS.md`.
  - Anotar objeciones en *Cambios propuestos*. Hecho: C1–C8 y C27–C30, aprobadas y aplicadas en 1.0.

## H1 — Subpestaña Voicebot y endpoints de configuración 🔄

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
- [x] **Importación de los `.env` actuales** (pedido del usuario vía coordinador, 2026-10-24;
  `src/scripts/import-integration-env.ts`, `modules/integrations/env-import*.ts`, BE-INT-19..22):
  script de una sola vez que corre el usuario. Mapea cada variable con `envNames`, reporta los
  conflictos entre los dos `.env` sin elegir, ignora las del host y las ajenas al catálogo, guarda
  por `SettingsService` y publica un solo `config.changed`. Dry-run por default, solo nombres.
  - Casos nuevos en `docs/plan-de-pruebas.md`.

## H2 — Internos

- [ ] **Modelo Prisma** de internos (contrato §3.5) con migración.
  - `number` único.
  - Validar que `flowId`, si viene, sea un flujo de canal `voice` asignado a ese `tenantId`; si no,
    hay fuga entre empresas, como ya pasó con los roles.
- [ ] **ABM** con `SystemTenantGuard` (infra global, D3) y UI en la subpestaña *Voicebot → Internos*.
- [ ] Incluir los internos en `GET /integrations/voicebot/config`. Todo cambio sube la versión y publica `config.changed`.
- [ ] Relación con `User.internalPhone`: hoy es el interno **de una persona**, otra cosa que el
  interno que atiende el bot. No mezclarlos. Si hacen falta los dos (p. ej. transferir a la persona
  X), documentarlo y preguntar.

## H3 — Canal de voz en el motor

- [ ] **Consumir `voice.events`** (contrato §5.1):
  - `call.started` abre una `Conversation` con `channel: "voice"` y `externalId: callId`, y resuelve
    tenant y flujo por el interno.
  - `call.ended` la cierra.
  - `turn.spoken` guarda como mensaje del bot **lo que se oyó**, no lo generado.
- [ ] **RPC `voice.turn`** (contrato §5.2):
  - Mismo patrón que `whatsapp.simulate.incoming`: responder por `replyTo` con `correlationId`.
  - `kind: "start"` corre desde el nodo `start`.
- [ ] **Identidad** (DA5, D13 sin profundizar):
  - Hoy `handleMessage` rechaza a quien no tiene membresía por teléfono.
  - Para voz hace falta un camino que no dependa del teléfono: la llamada pertenece al tenant del
    interno y el usuario se identifica después.
  - **No implementar hasta resolver DA5**; dejar el punto de extensión.
- [ ] **Capacidades del canal**: introducir la noción de canal en el motor para que `voice` nunca
  arme `WhatsAppInteractive`. `formatInteractiveAsText` es el precedente.
- [ ] **Snapshot por turno** para `supersedes`, según DA1.
- [ ] Sin flujo de voz asignado, responder con `delegate` (charla libre con la fuente de verdad),
  sin llamar a `LlmService` en el camino del turno.

## H4 — Flujos de voz

- [ ] **`Flow.channel`** (`text` | `voice`, default `text`, D10) con migración; los flujos
  existentes quedan `text`.
  - `findActiveFlowForTenant` y `TenantFlow.isStart` filtran por canal: un tenant tiene un flujo de
    inicio por canal. Revisar la invariante en `FlowService.applyTenantAssignment`.
  - Las variantes feriado/guardia heredan el canal del flujo base.
- [ ] **Menú**:
  - Ítem *Flujos de voz* debajo de *Flujos IVR* en `components/sidebar.tsx`.
  - Visible solo con el voicebot habilitado. Hace falta un endpoint de features legible por
    usuarios de tenant (p. ej. `GET /features` → `{voicebot: true}`), porque `/settings` es solo de sistema.
  - Aplicar el mismo gate en la página y en el backend: el sidebar es solo cosmético.
  - Permiso según DA6.
- [ ] **Editor** (`dashboard/flows/edit/page.tsx`): la paleta y `NodeProperties` filtran por canal.
  - Nodos de voz: `start, message, input, menu (verbalizado), condition, variable, llm_query,
    ticket_create, transfer_agent, sms, webhook, subflow, end`.
  - No disponibles por voz: `notification, ticket_query, device_validation, delay`.
  - Nodos nuevos: *transferir a interno* y *colgar*. *Identificación verbal* (D13) queda para después.
  - Todo campo nuevo de `data` se declara en `FlowNodeDataDto`: la whitelist rechaza lo no declarado.
- [ ] **Modo de habla por nodo** (contrato §5.3): cada nodo que habla elige `literal` o `guided`
  (texto exacto vs. instrucción al LLM de voz). `llm_query` sin extracción → `delegate`.
- [ ] **Motor**: `executeFlow` arma `actions` en lugar de `body`/`interactive` cuando el canal es
  `voice`.
  - `menu`: opciones verbalizadas; el match por `interpretMenuChoice` ya acepta lenguaje natural.
  - `end`: `hangup`.
  - Medir cuántas llamadas a `LlmService` sin streaming quedan en el camino del turno: cada una suma latencia.
- [ ] **Subflujos**: un flujo `voice` solo puede llamar a subflujos `voice`. Validarlo al guardar.
- [ ] e2e de motor por voz: publicar en `voice.turn` y verificar `actions`, como los `chat-nodes-*.e2e-spec.ts`.

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
| voicebot | `GET /integrations/voicebot/config`, token, `config.changed` | H1 |
| stt | `GET /integrations/stt/config`, token, `config.changed` | H1 |
| voicebot | Internos en la config | H2 |
| voicebot | Consumidor de `voice.events` y RPC `voice.turn` | H3 |
