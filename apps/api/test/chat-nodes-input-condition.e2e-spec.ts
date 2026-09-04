/**
 * 2.3 Nodos del motor — `input` y `condition` (CHAT-N-INP-*, CHAT-N-CND-*)
 *
 * Vía: POST /conversations/simulate, mismo patrón que chat-start.e2e-spec.ts (EXEMPLAR): el
 * mensaje viaja de punta a punta por RabbitMQ. Frontera mockeada: solo `LlmService` →
 * `FakeLlmService`. El motor de flujos NO se mockea.
 *
 * Cada escenario usa su propio (tenant, rol) con `TenantFlow.isStart` y un usuario CONOCIDO
 * (membership real) — así el flujo de inicio se resuelve por rol (`findActiveFlowForTenant`,
 * ver flow.service.ts:181) sin tocar el hazard global de `Flow.isDefault` (ver flow-builder.ts).
 *
 * --- Nodo `input` (executeNode, case 'input') ---
 * Primera llegada (`flowState.__awaiting !== node.id`): pregunta `data.text` y espera
 * (`waitForInput`). Segunda llegada: si `looksLikeCancelAttempt(body)` dispara, se llama
 * `confirmCancelIntent` (LLM) — si confirma cancelación, `cancelInteraction()` corta la gestión
 * (`cancelFlow`, cierra la conversación). Si no cancela, guarda `flowState[data.variableName] =
 * body` (solo si `variableName` está seteado) y avanza SIN emitir texto propio (el nodo `input`
 * no tiene `responseText` en el camino de "guardar y avanzar" — ver conversations.service.ts
 * líneas 1438-1442). Se verifica interpolando `{{variableName}}` en un `message` posterior.
 *
 * OJO con `handleMessage` paso 3.5: CUALQUIER mensaje que dispare `looksLikeCancelAttempt`
 * primero pasa por `confirmEndChatIntent` (clasificador de CIERRE de charla, distinto del de
 * `input`) ANTES de llegar a `executeFlow`. Por eso los mensajes "cancelación" de estos tests
 * generan DOS llamadas al FakeLlmService (confirmEndChatIntent + confirmCancelIntent), no una.
 * `confirmEndChatIntent` busca el prefijo "CERRAR"; `confirmCancelIntent` busca el prefijo
 * "CANCEL" (ver conversations.service.ts:677 y :712) — con `llm.setReply('CANCELAR')` el primero
 * da `false` (no empieza con CERRAR) y el segundo da `true`, que es justo el comportamiento que
 * necesita CHAT-N-INP-04.
 *
 * --- Nodo `condition` (executeNode, case 'condition') ---
 * Recorre `data.conditions` en orden; el primer match gana. `keyword`:
 * `body.toLowerCase().includes(cond.value.toLowerCase())`. `regex`: `new RegExp(cond.value,
 * 'i').test(body)`. `variable`: `flowState[cond.value]` truthy. Sin match, usa
 * `data.defaultTargetNodeId`; sin default, `resolveNextNode` cae a la primera arista saliente del
 * nodo `condition`. Un `type` desconocido no entra en ningún `if`: se ignora sin romper
 * (confirmado leyendo el código, no hay `else`/`default` que lance).
 *
 * CHAT-N-CND-06/08 (SEC-09) CRASHEAN el motor hoy: regex inválida (`new RegExp('[')`) tira
 * `SyntaxError`; `cond.value` ausente hace que `cond.value.toLowerCase()` corra sobre
 * `undefined` y tire `TypeError`. Ninguna está en un try/catch, así que la excepción sube por
 * `executeFlow` → `handleMessage` hasta el consumer de `BrokerService` (`setupConsumer`), que
 * hace `safeNack` y jamás llega al `broker.publish()` de la respuesta (conversations.service.ts
 * líneas 349-359, después de todo el bloque try implícito). Por `/simulate` (que usa
 * `broker.request()` con `replyTo`) eso cuelga 300s (`SIMULATE_TIMEOUT_MS`) antes de fallar.
 *
 * Estrategia anti-cuelgue (evita los 300s): para estos dos casos NO se usa `/simulate`. Se
 * publica directo en `whatsapp.simulate.incoming` (mismo mecanismo que usa `simulateIncomingMessage`
 * internamente, ver conversations.service.ts:25 `SIMULATE_QUEUE` — la constante es privada, no
 * exportada, así que se repite el literal acá) SIN `replyTo`, y se observa la respuesta con un
 * `jest.spyOn(broker, 'publish')` PASSTHROUGH (no se reemplaza la implementación: RabbitMQ recibe
 * el mensaje real, se sigue ejercitando el motor de punta a punta). Sin `replyTo`, `handleMessage`
 * publica la respuesta en `${channel}.outgoing` = `whatsapp.outgoing` (channel default). Se
 * prefiere el spy a un SEGUNDO `broker.subscribe('whatsapp.outgoing', ...)` porque, con
 * `WHATSAPP_PROVIDER` en su default ('meta'), `WhatsAppService` YA es un consumer real de esa
 * cola en esta misma app (ver whatsapp-outgoing.e2e-spec.ts) — un segundo `subscribe` competiría
 * round-robin contra él y el test quedaría flaky (mismo gotcha documentado en
 * webhook-whatsapp.e2e-spec.ts para `whatsapp.incoming`).
 *
 * Comportamiento SEGURO (el que hoy NO existe) = llega una respuesta en `whatsapp.outgoing`
 * dentro de ~5s. Hoy el nodo revienta ANTES de publicar nada, así que el poll de 5s se agota, el
 * `expect` de "llegó respuesta" falla rápido, y `it.failing` lo da verde. El timeout de Jest de
 * cada uno de estos dos `it.failing` se acota a 15s (bien por debajo de cualquier cuelgue real).
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  FakeLlmService,
  startNode,
  messageNode,
  endNode,
  inputNode,
  conditionNode,
  variableNode,
  node,
  edge,
} from './support';

/** Espejo del literal privado `SIMULATE_QUEUE` de conversations.service.ts (no se exporta). */
const SIMULATE_QUEUE = 'whatsapp.simulate.incoming';

describe('2.3 Nodos del motor — input y condition (CHAT-N-INP-*, CHAT-N-CND-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let broker: BrokerService;
  let tenant: { id: string };

  function simulate(from: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId: tenant.id });
  }

  /** Crea (rol + usuario conocido + flujo de inicio) para un escenario aislado del resto. */
  async function setupScenario(opts: {
    label: string;
    nodes: unknown[];
    edges: unknown[];
  }): Promise<{ phone: string }> {
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: `Rol ${opts.label}` });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail(opts.label),
      phone,
      firstName: 'Uno',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: `F-${opts.label}`,
      nodes: opts.nodes,
      edges: opts.edges,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    return { phone };
  }

  /**
   * Poll corto (sin timers largos) de `publishSpy` buscando un `publish('whatsapp.outgoing', ...)`
   * dirigido a `to`. Devuelve el mensaje si aparece, o `null` si se agota `timeoutMs`.
   */
  async function waitForOutgoing(
    publishSpy: jest.SpyInstance,
    to: string,
    timeoutMs: number,
  ): Promise<unknown | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = publishSpy.mock.calls.find(
        (call) => call[0] === 'whatsapp.outgoing' && (call[1] as any)?.data?.to === to,
      );
      if (hit) return hit[1];
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
    broker = t.moduleRef.get(BrokerService);
    tenant = await createTenant(t.prisma, { slug: uniqueSlug('nodes') });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  // ======================================================================
  // input (CHAT-N-INP-01..05)
  // ======================================================================

  describe('input', () => {
    // Flujo compartido: start -> input(variableName:'email') -> message(interpola) -> end.
    // Una sola arista sin sourceHandle entre start->input: resolveNextNode cae a la primera
    // arista saliente sin importar si el usuario es 'known'/'unknown' (ver flow-builder.ts).
    async function setupInputFlow(label: string) {
      return setupScenario({
        label,
        nodes: [
          startNode('s'),
          inputNode('inp', { text: '¿Cuál es tu email?', variableName: 'email' }),
          messageNode('msg', 'Guardado: {{email}}'),
          endNode('e'),
        ],
        edges: [edge('s', 'inp'), edge('inp', 'msg'), edge('msg', 'e')],
      });
    }

    it('CHAT-N-INP-01: primera llegada muestra la pregunta (data.text) y espera', async () => {
      const { phone } = await setupInputFlow('inp01');

      const res = await simulate(phone, 'hola');

      expect(res.status).toBe(201);
      // Saludo de conocido del nodo start + la pregunta del input, encadenados en un solo turno
      // (start no espera, input sí).
      expect(res.body.reply).toContain('Bienvenido de nuevo');
      expect(res.body.reply).toContain('¿Cuál es tu email?');
      expect(llm.calls.length).toBe(0); // "hola" no dispara ningún clasificador
    });

    it('CHAT-N-INP-02: respuesta con variableName seteado guarda el valor y avanza', async () => {
      const { phone } = await setupInputFlow('inp02');
      await simulate(phone, 'hola'); // llega al input, queda esperando

      // Sin palabras-pista de cancelación: no debe invocar al LLM.
      const res = await simulate(phone, 'ana.lopez@example.com');

      expect(res.status).toBe(201);
      expect(llm.calls.length).toBe(0);
      // El nodo `input`, al guardar y avanzar, no emite responseText propio (ver
      // conversations.service.ts:1438-1442) — la única respuesta del turno es el `message`
      // siguiente, ya interpolado con el valor guardado.
      expect(res.body.reply).toBe('Guardado: ana.lopez@example.com');
    });

    it('CHAT-N-INP-03: respuesta sin variableName avanza sin guardar', async () => {
      const { phone } = await setupScenario({
        label: 'inp03',
        nodes: [
          startNode('s'),
          inputNode('inp', { text: 'Contame algo' }), // sin variableName
          messageNode('msg', 'Eco: {{dato}}'),
          endNode('e'),
        ],
        edges: [edge('s', 'inp'), edge('inp', 'msg'), edge('msg', 'e')],
      });
      await simulate(phone, 'hola');

      const res = await simulate(phone, 'cualquier respuesta sin pistas');

      expect(res.status).toBe(201);
      expect(llm.calls.length).toBe(0);
      // `flowState.dato` nunca se seteó (no hay `variableName`): `interpolate` deja el
      // placeholder tal cual cuando la variable no existe (conversations.service.ts:808-813).
      expect(res.body.reply).toBe('Eco: {{dato}}');
    });

    it('CHAT-N-INP-04: respuesta que parece cancelación, confirmada por el LLM, cancela la gestión', async () => {
      const { phone } = await setupInputFlow('inp04');
      await simulate(phone, 'hola'); // llega al input, queda esperando

      llm.setReply('CANCELAR'); // confirmCancelIntent: startsWith('CANCEL') -> true
      const res = await simulate(phone, 'mejor dejalo');

      expect(res.status).toBe(201);
      // Dos llamadas: confirmEndChatIntent (paso 3.5 de handleMessage, busca 'CERRAR' — no
      // matchea 'CANCELAR', sigue) + confirmCancelIntent (dentro del nodo input, sí cancela).
      expect(llm.calls.length).toBe(2);
      expect(res.body.reply).toBe('Listo, cancelé la gestión. Decime si necesitás otra cosa.');

      // La cancelación cierra la conversación (cancelFlow -> closeConversation), no solo el
      // dato puntual: un mensaje normal después arranca una charla nueva desde el `start`.
      const conv = await t.prisma.conversation.findFirst({
        where: { userId: (await t.prisma.user.findFirst({ where: { phone } }))!.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(conv?.status).toBe('closed');
    });

    it('CHAT-N-INP-05: respuesta que parece cancelación pero el LLM dice continuar guarda el texto y avanza', async () => {
      const { phone } = await setupInputFlow('inp05');
      await simulate(phone, 'hola'); // llega al input, queda esperando

      llm.setReply('CONTINUAR'); // ni 'CERRAR' ni 'CANCEL': ambos clasificadores dan false
      const res = await simulate(phone, 'dejalo total, mejor sigo');

      expect(res.status).toBe(201);
      expect(llm.calls.length).toBe(2); // mismo par de clasificadores que INP-04, esta vez ambos "no"
      // No canceló: el body COMPLETO (con la palabra-pista incluida) queda guardado tal cual.
      expect(res.body.reply).toBe('Guardado: dejalo total, mejor sigo');
    });
  });

  // ======================================================================
  // condition (CHAT-N-CND-01..09)
  // ======================================================================

  describe('condition', () => {
    it('CHAT-N-CND-01: keyword que matchea enruta al targetNodeId de esa condición', async () => {
      const { phone } = await setupScenario({
        label: 'cnd01',
        nodes: [
          startNode('s'),
          conditionNode('c', {
            conditions: [{ type: 'keyword', value: 'factura', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-KEYWORD'),
          messageNode('td', 'RUTA-DEFAULT'),
          endNode('e'),
        ],
        edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      const res = await simulate(phone, 'necesito ayuda con mi factura');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-KEYWORD');
    });

    it('CHAT-N-CND-02: regex válida que matchea enruta a su target', async () => {
      const { phone } = await setupScenario({
        label: 'cnd02',
        nodes: [
          startNode('s'),
          conditionNode('c', {
            conditions: [{ type: 'regex', value: '^ticket-\\d+$', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-REGEX'),
          messageNode('td', 'RUTA-DEFAULT'),
          endNode('e'),
        ],
        edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      const res = await simulate(phone, 'ticket-482');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-REGEX');
    });

    it('CHAT-N-CND-03: variable "truthy" en el estado enruta a su target', async () => {
      const { phone } = await setupScenario({
        label: 'cnd03',
        nodes: [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'urgente', value: 'si' }),
          conditionNode('c', {
            conditions: [{ type: 'variable', value: 'urgente', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-VARIABLE'),
          messageNode('td', 'RUTA-DEFAULT'),
          endNode('e'),
        ],
        edges: [edge('s', 'v'), edge('v', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      // El body no importa: lo que decide es flowState.urgente, seteado por el nodo `variable`
      // antes de llegar a la condición, en el mismo turno.
      const res = await simulate(phone, 'hola');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-VARIABLE');
    });

    it('CHAT-N-CND-04: ninguna condición matchea, con defaultTargetNodeId, enruta al default', async () => {
      const { phone } = await setupScenario({
        label: 'cnd04',
        nodes: [
          startNode('s'),
          conditionNode('c', {
            conditions: [{ type: 'keyword', value: 'facturaXYZ-no-matchea', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-KEYWORD'),
          messageNode('td', 'RUTA-DEFAULT'),
          endNode('e'),
        ],
        edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      const res = await simulate(phone, 'hola, tengo una consulta');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-DEFAULT');
    });

    it('CHAT-N-CND-05: ninguna matchea, sin default, cae a la primera arista saliente', async () => {
      const { phone } = await setupScenario({
        label: 'cnd05',
        nodes: [
          startNode('s'),
          conditionNode('c', {
            conditions: [{ type: 'keyword', value: 'no-matchea-nunca', targetNodeId: 'ta' }],
            // sin defaultTargetNodeId
          }),
          messageNode('tfallback', 'RUTA-FALLBACK-EDGE'),
          endNode('e'),
        ],
        // Única arista saliente de 'c': hacia 'tfallback'. Sin match y sin default, la condición
        // devuelve {} y resolveNextNode cae a outgoing[0] (conversations.service.ts:551-566).
        edges: [edge('s', 'c'), edge('c', 'tfallback'), edge('tfallback', 'e')],
      });

      const res = await simulate(phone, 'hola');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-FALLBACK-EDGE');
    });

    it('CHAT-N-CND-07: keyword con value vacío matchea siempre (includes("") es true) — borde documentado', async () => {
      const { phone } = await setupScenario({
        label: 'cnd07',
        nodes: [
          startNode('s'),
          conditionNode('c', {
            conditions: [{ type: 'keyword', value: '', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-SIEMPRE'),
          messageNode('td', 'RUTA-DEFAULT'),
          endNode('e'),
        ],
        edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      // Cualquier body matchea: ''.length === 0, "x".includes("") === true en JS.
      const res = await simulate(phone, 'cualquier cosa sin relación con nada configurado');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('RUTA-SIEMPRE');
    });

    it('CHAT-N-CND-09: type desconocido se ignora (no matchea, no rompe) y cae al default', async () => {
      const { phone } = await setupScenario({
        label: 'cnd09',
        nodes: [
          startNode('s'),
          // `conditionNode()` tipa `type` a 'keyword'|'regex'|'variable': se arma el nodo a mano
          // con `node()` para poder pasar un type inválido, tal como haría un editor corrupto o
          // una versión vieja del schema.
          node('c', 'condition', {
            conditions: [{ type: 'tipo_inventado', value: 'x', targetNodeId: 'ta' }],
            defaultTargetNodeId: 'td',
          }),
          messageNode('ta', 'RUTA-KEYWORD'),
          messageNode('td', 'RUTA-DEFAULT-TIPO-DESCONOCIDO'),
          endNode('e'),
        ],
        edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
      });

      const res = await simulate(phone, 'hola');

      expect(res.status).toBe(201);
      // No matcheó 'ta' (el type desconocido no entra en ningún `if` de executeNode) y no
      // rompió: cayó al default.
      expect(res.body.reply).toContain('RUTA-DEFAULT-TIPO-DESCONOCIDO');
      expect(res.body.reply).not.toContain('RUTA-KEYWORD');
    });

    // --- Invertidos (SEC-09): hoy CRASHEAN el motor. Ver estrategia anti-cuelgue en el
    // comentario de cabecera del archivo. NO se usa /simulate acá (colgaría 300s). ---

    it.failing(
      'CHAT-N-CND-06: regex inválida no debe romper el flujo — compilación protegida (SEC-09) @invertido',
      async () => {
        const { phone } = await setupScenario({
          label: 'cnd06',
          nodes: [
            startNode('s'),
            conditionNode('c', {
              // Patrón inválido: `new RegExp('[', 'i')` tira SyntaxError sin try/catch alrededor
              // (conversations.service.ts:1456-1463).
              conditions: [{ type: 'regex', value: '[', targetNodeId: 'ta' }],
              defaultTargetNodeId: 'td',
            }),
            messageNode('ta', 'RUTA-KEYWORD'),
            messageNode('td', 'RUTA-DEFAULT'),
            endNode('e'),
          ],
          edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
        });

        const publishSpy = jest.spyOn(broker, 'publish'); // passthrough: no reemplaza nada
        try {
          await broker.publish(SIMULATE_QUEUE, {
            pattern: 'message.received',
            data: { from: phone, body: 'hola' },
            tenantId: tenant.id,
            timestamp: new Date().toISOString(),
          });

          // Comportamiento SEGURO: el flujo sigue (cae a default o a la primera arista) y el
          // bot responde igual. Hoy la excepción no capturada corta el consumer (safeNack) antes
          // de publicar nada: este poll de 5s se agota y el expect de abajo falla rápido.
          const reply = await waitForOutgoing(publishSpy, phone, 5000);
          expect(reply).not.toBeNull();
        } finally {
          publishSpy.mockRestore();
        }
      },
      15000,
    );

    it.failing(
      'CHAT-N-CND-08: value ausente en una condición keyword no debe romper el flujo (SEC-09) @invertido',
      async () => {
        const { phone } = await setupScenario({
          label: 'cnd08',
          nodes: [
            startNode('s'),
            // `value` deliberadamente OMITIDO (no cargado en el editor): `cond.value.toLowerCase()`
            // corre sobre `undefined` y tira TypeError sin try/catch (conversations.service.ts:1451).
            node('c', 'condition', {
              conditions: [{ type: 'keyword', targetNodeId: 'ta' }],
              defaultTargetNodeId: 'td',
            }),
            messageNode('ta', 'RUTA-KEYWORD'),
            messageNode('td', 'RUTA-DEFAULT'),
            endNode('e'),
          ],
          edges: [edge('s', 'c'), edge('c', 'ta'), edge('c', 'td'), edge('ta', 'e'), edge('td', 'e')],
        });

        const publishSpy = jest.spyOn(broker, 'publish');
        try {
          await broker.publish(SIMULATE_QUEUE, {
            pattern: 'message.received',
            data: { from: phone, body: 'hola' },
            tenantId: tenant.id,
            timestamp: new Date().toISOString(),
          });

          const reply = await waitForOutgoing(publishSpy, phone, 5000);
          expect(reply).not.toBeNull();
        } finally {
          publishSpy.mockRestore();
        }
      },
      15000,
    );

    it('CHAT-N-CND-10: con solo la rama afirmativa cableada, un resultado FALSO no se va por la arista del true', async () => {
      // Forma más común del nodo: "si es X → algo especial; si no, seguí de largo", donde en el
      // editor se dibuja únicamente la arista `true`. Antes, un resultado falso no encontraba
      // arista `false` y `resolveNextNode` caía a `outgoing[0]` — que es justo la del `true`:
      // el flujo hacía exactamente lo contrario de lo que declaraba.
      const { phone } = await setupScenario({
        label: 'cnd10',
        nodes: [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'plan', value: 'basico' }),
          node('c', 'condition', { compareVariable: 'plan', compareOperator: 'equals', compareValue: 'premium' }),
          messageNode('si', 'RAMA-PREMIUM'),
          endNode('e'),
        ],
        // Solo la arista `true`. La rama falsa queda sin dibujar a propósito.
        edges: [edge('s', 'v', 'known'), edge('v', 'c'), edge('c', 'si', 'true'), edge('si', 'e')],
      });

      const res = await simulate(phone, 'hola');
      expect(res.status).toBe(201);
      // `plan` es "basico", así que el resultado es falso: no tiene que ver el mensaje premium.
      expect(res.body.reply ?? '').not.toContain('RAMA-PREMIUM');
    });

    it('CHAT-N-CND-11: una arista SIN handle sirve de salida por defecto cuando la rama no está cableada', async () => {
      // Distinto del caso anterior: una arista sin handle no pertenece a ninguna rama, así que
      // seguirla es inequívoco — quien la dibujó quiso "seguí por acá pase lo que pase".
      const { phone } = await setupScenario({
        label: 'cnd11',
        nodes: [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'plan', value: 'basico' }),
          node('c', 'condition', { compareVariable: 'plan', compareOperator: 'equals', compareValue: 'premium' }),
          messageNode('si', 'RAMA-PREMIUM'),
          messageNode('sigue', 'SIGUE-DE-LARGO'),
          endNode('e'),
        ],
        edges: [
          edge('s', 'v', 'known'),
          edge('v', 'c'),
          edge('c', 'si', 'true'),
          edge('c', 'sigue'), // sin handle
          edge('si', 'e'),
          edge('sigue', 'e'),
        ],
      });

      const res = await simulate(phone, 'hola');
      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('SIGUE-DE-LARGO');
      expect(res.body.reply).not.toContain('RAMA-PREMIUM');
    });
  });
});
