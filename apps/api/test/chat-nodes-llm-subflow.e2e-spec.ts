/**
 * 2.3 Nodos del motor — `llm_query` y `subflow` (CHAT-N-LLM-*, CHAT-N-SUB-*)
 *
 * Vía: `POST /conversations/simulate` para los casos "sanos" (responden por el RPC de simulate,
 * ver `chat-start.e2e-spec.ts`). Cada test arma un tenant/rol/usuario CONOCIDO propio y le asigna
 * un flujo de inicio (`TenantFlow.isStart`) hecho a medida — no depende de `Flow.isDefault`
 * (global), así que no hay hazard de aislamiento entre tests de este archivo.
 *
 * Frontera mockeada: `LlmService` → `FakeLlmService`. El motor de flujos NO se mockea.
 *
 * ## Anti-cuelgue (CHAT-N-LLM-04, CHAT-N-SUB-03)
 *
 * Ambos son casos INVERTIDOS: leyendo `conversations.service.ts`, tanto `case 'llm_query'`
 * (llama `this.llmService.chat(...)` sin try/catch) como `case 'subflow'` (llama
 * `this.flowService.findById(subFlowId)`, que tira `NotFoundException` si no existe — el
 * `if (!subFlow)` de al lado es código muerto) dejan que la excepción se propague sin capturar
 * por `executeNode` → `executeFlow` → `handleMessage`, hasta el consumer de RabbitMQ. La
 * respuesta nunca se publica, así que por `/simulate` el llamador quedaría esperando los 300s
 * completos de `SIMULATE_TIMEOUT_MS` (504 recién ahí). Por eso estos dos casos NO usan
 * `/simulate`: publican directo en `whatsapp.incoming` con el `BrokerService` real, SIN
 * `replyTo` (mismo patrón que `CHAT-PIPE-02/07/08` en `chat-pipeline.e2e-spec.ts`), y esperan
 * hasta ~5s una respuesta en la cola de salida — con un timeout de jest acotado (15s) para no
 * colgar la corrida completa si el bug se mantiene.
 *
 * La cola de salida que escuchan es `<channel>.outgoing` con un `channel` DEDICADO por test
 * (no el `whatsapp` real): en esta misma app, `WhatsAppService` ya está suscripto de verdad a
 * `whatsapp.outgoing` (activo por defecto, `WHATSAPP_PROVIDER` sin configurar cae a 'meta' — ver
 * `whatsapp-outgoing.e2e-spec.ts`). Dos consumidores en la misma cola de RabbitMQ se reparten los
 * mensajes por round-robin, así que escuchar `whatsapp.outgoing` acá sería flaky (a veces el
 * mensaje cae en el consumidor real, no en el del test). Un `channel` propio evita esa
 * competencia sin tocar el mecanismo bajo prueba — mismo truco que ya usa el código real para
 * separar WhatsApp de SMS (`${channel}.outgoing`, ver `handleMessage`).
 *
 * SEGURO = llega una respuesta en esa cola (el motor degradó/manejó el error controladamente).
 * HOY no llega nunca dentro del plazo → el `await` de espera tira por timeout → el test falla →
 * `it.failing` lo da por verde. El día que se blinden estos dos casos, el assert va a empezar a
 * pasar de verdad y `it.failing` va a gritar "sacá el marcador".
 *
 * ## CHAT-N-LLM-07 (ContextSource)
 *
 * Se levanta un consumidor propio sobre la cola `queueName` de un `ContextSource` tipo `broker`
 * — exactamente el "proceso externo ya suscripto a esa cola" que describe el catálogo
 * (`context-source-types.catalog.ts`, tipo `broker`: "no instalamos nada, `config` son los
 * parámetros de conexión a un servicio que ya corre en otro lado"). No se mockea
 * `ContextSourcesService` ni `ContextSourceConnectorService` (ambos corren de verdad, con el
 * `BrokerService` real) — solo se hace de cuenta de ser el RAG/servicio externo del otro lado.
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { BrokerService, BrokerMessage } from '../src/modules/broker/broker.service';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  createSkill,
  createContextSource,
  setSetting,
  deleteSetting,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  FakeLlmService,
  startNode,
  messageNode,
  endNode,
  inputNode,
  llmQueryNode,
  subflowNode,
  edge,
} from './support';

describe('2.3 Nodos del motor — llm_query y subflow (CHAT-N-LLM-*, CHAT-N-SUB-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let broker: BrokerService;

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').send({ from, body, tenantId });
  }

  /** Empresa + rol + usuario CONOCIDO (con membresía) propios, para no compartir estado con
   * otros tests del archivo. */
  async function newKnownUser(label: string) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol' });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail(label),
      phone,
      firstName: 'Uso',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { tenant, role, phone };
  }

  /** Crea un flujo y lo asigna como flujo de inicio de (tenant, rol) — no depende de
   * `Flow.isDefault` (global, ver hazard en flow-builder.ts). */
  function startFlow(
    tenant: { id: string },
    role: { id: string },
    nodes: unknown[],
    edges: unknown[],
    opts: { skillId?: string; contextSourceId?: string } = {},
  ) {
    return createFlow(t.prisma, {
      name: `F-${uniqueSlug('flow')}`,
      nodes,
      edges,
      ...opts,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
  }

  async function conversationFor(tenantId: string, phone: string) {
    const user = await t.prisma.user.findFirstOrThrow({ where: { phone } });
    return t.prisma.conversation.findFirstOrThrow({ where: { userId: user.id, tenantId } });
  }

  /** Espera hasta `timeoutMs` a que `bucket` reciba al menos un elemento. Ver el comentario de
   * cabecera del archivo ("Anti-cuelgue"): si el nodo revienta con una excepción no capturada,
   * nunca llega nada acá y este poll corta rápido en vez de bloquear como haría /simulate. */
  async function waitForBucket<T>(bucket: T[], timeoutMs = 5000): Promise<T> {
    const start = Date.now();
    while (bucket.length === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `No llegó ninguna respuesta en ${timeoutMs}ms: la charla quedó colgada (excepción no capturada, ver comentario de cabecera).`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return bucket[0];
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
    broker = t.moduleRef.get(BrokerService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  // ===========================================================================================
  // llm_query
  // ===========================================================================================

  it('CHAT-N-LLM-01: con arista saliente responde una vez con el modelo y avanza al siguiente nodo', async () => {
    const { tenant, role, phone } = await newKnownUser('llm01');
    llm.setReply('respuesta del modelo');
    await startFlow(
      tenant,
      role,
      [startNode('s'), llmQueryNode('q'), messageNode('m', 'Después del LLM'), endNode('e')],
      [edge('s', 'q', 'known'), edge('q', 'm'), edge('m', 'e')],
    );

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(llm.calls).toHaveLength(1); // una sola llamada al modelo
    expect(res.body.reply).toContain('respuesta del modelo');
    expect(res.body.reply).toContain('Después del LLM'); // avanzó al siguiente nodo, no quedó parado

    const conv = await conversationFor(tenant.id, phone);
    expect(conv.status).toBe('closed'); // encadenó hasta el 'end': terminó de correr el flujo entero
  });

  it('CHAT-N-LLM-02: terminal (sin arista de salida) queda como punto final — los siguientes mensajes van directo al modelo sin repetir el saludo', async () => {
    const { tenant, role, phone } = await newKnownUser('llm02');
    llm.setReply('respuesta del modelo');
    const flow = await startFlow(tenant, role, [startNode('s'), llmQueryNode('q')], [edge('s', 'q', 'known')]);

    const first = await simulate(phone, tenant.id, 'primer mensaje');
    expect(first.status).toBe(201);
    expect(first.body.reply).toContain('Bienvenido de nuevo'); // saludo del 'start', primer turno
    expect(first.body.reply).toContain('respuesta del modelo');
    expect(llm.calls).toHaveLength(1);

    const conv1 = await conversationFor(tenant.id, phone);
    expect(conv1.status).toBe('active'); // terminal, no cierra la charla
    expect(conv1.currentFlowId).toBe(flow.id);
    expect(conv1.currentNodeId).toBe('q'); // quedó parado en el propio nodo llm_query

    const second = await simulate(phone, tenant.id, 'segundo mensaje');
    expect(second.status).toBe(201);
    expect(second.body.reply).toBe('respuesta del modelo'); // SIN el saludo: no volvió a pasar por 'start'
    expect(llm.calls).toHaveLength(2);

    const conv2 = await conversationFor(tenant.id, phone);
    expect(conv2.currentNodeId).toBe('q'); // sigue parado en el mismo nodo
  });

  it('CHAT-N-LLM-03: systemPrompt y contextMessages propios se usan tal cual (⚠️ ver discrepancia con el plan en el comentario)', async () => {
    const { tenant, role, phone } = await newKnownUser('llm03');
    llm.setReply('respuesta del modelo');
    await startFlow(
      tenant,
      role,
      [startNode('s'), llmQueryNode('q', { systemPrompt: 'PROMPT-PROPIO-DEL-NODO', contextMessages: 2 })],
      [edge('s', 'q', 'known')],
    );

    const first = await simulate(phone, tenant.id, 'mensaje uno');
    expect(first.status).toBe(201);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].options?.systemPrompt).toBe('PROMPT-PROPIO-DEL-NODO');
    // Único Message que existe en ese momento: el propio mensaje del usuario, guardado en el
    // paso "3. Guardar mensaje del usuario" de handleMessage, ANTES de correr executeFlow.
    expect(llm.calls[0].messages).toEqual([{ role: 'user', content: 'mensaje uno' }]);

    const second = await simulate(phone, tenant.id, 'mensaje dos');
    expect(second.status).toBe(201);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1].options?.systemPrompt).toBe('PROMPT-PROPIO-DEL-NODO');
    // ⚠️ Discrepancia real con la redacción del plan ("toma los últimos N Message"): el código
    // (`case 'llm_query'`) hace `prisma.message.findMany({ orderBy: {createdAt:'asc'}, take:
    // contextMessages })` SIN `skip`. Eso trae los N mensajes MÁS VIEJOS de toda la
    // conversación — siempre los mismos, no una ventana deslizante de "los últimos N". Con
    // contextMessages:2, en este segundo turno la ventana sigue siendo [mensaje uno (user),
    // respuesta del modelo del primer turno (assistant)]: el mensaje ACTUAL ("mensaje dos"),
    // que ya está guardado en BD para cuando este nodo consulta, NI SIQUIERA queda incluido en
    // lo que recibe el modelo. `orchestratorLlm` comparte el mismo patrón (asc + take sin skip)
    // pero al menos acota por `sessionStartedAt`; `llm_query` ni eso — el código es la fuente
    // de verdad, así que el assert documenta el comportamiento real, no el enunciado del plan.
    // El segundo elemento no es solo la respuesta del LLM: `handleMessage` guarda como Message
    // del asistente el turno COMPLETO acumulado (`responses.join('\n\n')`) — acá, el saludo del
    // 'start' + la respuesta del nodo llm_query del primer turno, en un solo Message.
    expect(llm.calls[1].messages).toEqual([
      { role: 'user', content: 'mensaje uno' },
      { role: 'assistant', content: '¡Hola Uso! Bienvenido de nuevo.\n\nrespuesta del modelo' },
    ]);
  });

  it.failing(
    'CHAT-N-LLM-04 (robustez): si el proveedor LLM falla, el nodo debe degradar sin colgar la charla — HOY revienta sin try/catch y no responde',
    async () => {
      const { tenant, role, phone } = await newKnownUser('llm04');
      llm.setFailure(new Error('LLM caído (simulado)'));
      await startFlow(tenant, role, [startNode('s'), llmQueryNode('q')], [edge('s', 'q', 'known')]);

      const channel = `llm04-${uniqueSlug('chn')}`; // cola de salida dedicada, ver comentario de cabecera
      const outgoing: BrokerMessage[] = [];
      await broker.subscribe(`${channel}.outgoing`, (msg) => {
        outgoing.push(msg);
      });

      const sent = await broker.publish('whatsapp.incoming', {
        pattern: 'message.received',
        data: { from: phone, body: 'hola', channel },
        tenantId: tenant.id,
        timestamp: new Date().toISOString(),
      });
      expect(sent).toBe(true);

      // Comportamiento SEGURO esperado: llega una respuesta degradada igual (como sí hace
      // `orchestratorLlm`, que atrapa el error del proveedor — ver ese método, tiene un
      // try/catch alrededor de `llmService.chat` con un mensaje de disculpa de fallback). El
      // `case 'llm_query'` de `executeNode` NO tiene ese try/catch: hoy nunca llega nada acá.
      const reply = await waitForBucket(outgoing, 5000);
      expect(typeof (reply.data as { body?: string }).body).toBe('string');
    },
    15000,
  );

  it('CHAT-N-LLM-05: con una Skill vinculada al flujo, su promptText se concatena al system prompt base (buildBasePrompt)', async () => {
    await setSetting(t.prisma, 'LLM_SYSTEM_PROMPT', 'BASE-DE-PRUEBA');
    try {
      const { tenant, role, phone } = await newKnownUser('llm05');
      llm.setReply('respuesta del modelo');
      const skill = await createSkill(t.prisma, {
        tenantId: tenant.id,
        name: 'Skill-05',
        promptText: 'SKILL: sé breve y formal.',
      });
      await startFlow(
        tenant,
        role,
        [startNode('s'), llmQueryNode('q')], // sin systemPrompt propio: usa el base + Skill tal cual
        [edge('s', 'q', 'known')],
        { skillId: skill.id },
      );

      const res = await simulate(phone, tenant.id);
      expect(res.status).toBe(201);
      expect(llm.calls).toHaveLength(1);
      expect(llm.calls[0].options?.systemPrompt).toBe('BASE-DE-PRUEBA\n\nSKILL: sé breve y formal.');
    } finally {
      await deleteSetting(t.prisma, 'LLM_SYSTEM_PROMPT');
    }
  });

  it('CHAT-N-LLM-06a: systemPromptMode "append" agrega el prompt propio A CONTINUACIÓN del base (+ Skill)', async () => {
    await setSetting(t.prisma, 'LLM_SYSTEM_PROMPT', 'BASE-DE-PRUEBA');
    try {
      const { tenant, role, phone } = await newKnownUser('llm06a');
      llm.setReply('respuesta del modelo');
      const skill = await createSkill(t.prisma, {
        tenantId: tenant.id,
        name: 'Skill-06a',
        promptText: 'SKILL: sé breve y formal.',
      });
      await startFlow(
        tenant,
        role,
        [startNode('s'), llmQueryNode('q', { systemPrompt: 'INSTRUCCION-NODO', systemPromptMode: 'append' })],
        [edge('s', 'q', 'known')],
        { skillId: skill.id },
      );

      const res = await simulate(phone, tenant.id);
      expect(res.status).toBe(201);
      expect(llm.calls[0].options?.systemPrompt).toBe(
        'BASE-DE-PRUEBA\n\nSKILL: sé breve y formal.\n\nINSTRUCCION-NODO',
      );
    } finally {
      await deleteSetting(t.prisma, 'LLM_SYSTEM_PROMPT');
    }
  });

  it('CHAT-N-LLM-06b: systemPromptMode "replace" (default) reemplaza el base entero — se pierde también la Skill vinculada (nuance de CHAT-N-LLM-05)', async () => {
    await setSetting(t.prisma, 'LLM_SYSTEM_PROMPT', 'BASE-DE-PRUEBA');
    try {
      const { tenant, role, phone } = await newKnownUser('llm06b');
      llm.setReply('respuesta del modelo');
      const skill = await createSkill(t.prisma, {
        tenantId: tenant.id,
        name: 'Skill-06b',
        promptText: 'SKILL: sé breve y formal.',
      });
      await startFlow(
        tenant,
        role,
        [startNode('s'), llmQueryNode('q', { systemPrompt: 'INSTRUCCION-NODO' })], // sin systemPromptMode: default 'replace'
        [edge('s', 'q', 'known')],
        { skillId: skill.id },
      );

      const res = await simulate(phone, tenant.id);
      expect(res.status).toBe(201);
      // Ni el base de /settings ni la Skill quedan: el prompt del nodo reemplaza TODO.
      expect(llm.calls[0].options?.systemPrompt).toBe('INSTRUCCION-NODO');
    } finally {
      await deleteSetting(t.prisma, 'LLM_SYSTEM_PROMPT');
    }
  });

  it('CHAT-N-LLM-06c: systemPromptMode con un valor inválido (ni "append" ni "replace") cae a replace — el DTO solo valida @IsString', async () => {
    const { tenant, role, phone } = await newKnownUser('llm06c');
    llm.setReply('respuesta del modelo');
    await startFlow(
      tenant,
      role,
      [startNode('s'), llmQueryNode('q', { systemPrompt: 'INSTRUCCION-NODO', systemPromptMode: 'valor-invalido-xyz' })],
      [edge('s', 'q', 'known')],
    );

    const res = await simulate(phone, tenant.id);
    expect(res.status).toBe(201);
    // Código real: `data.systemPrompt && data.systemPromptMode === 'append' ? append : (data.systemPrompt || basePrompt)`
    // — cualquier valor que no sea exactamente 'append' (incluido uno inválido) cae al mismo
    // resultado que 'replace'.
    expect(llm.calls[0].options?.systemPrompt).toBe('INSTRUCCION-NODO');
  });

  it('CHAT-N-LLM-07: con una ContextSource vinculada, consulta la fuente SIEMPRE (aun con un mensaje trivial) e inyecta la respuesta como mensaje system autoritativo', async () => {
    const { tenant, role, phone } = await newKnownUser('llm07');
    llm.setReply('respuesta del modelo');

    // "Proceso externo" simulado: un consumidor propio sobre la cola que configura el
    // ContextSource tipo 'broker' — ver comentario de cabecera.
    const queueName = `test-rag-${uniqueSlug('q')}`;
    const questionsReceived: string[] = [];
    await broker.subscribe(queueName, async (msg) => {
      const data = msg.data as { text?: string };
      questionsReceived.push(data.text ?? '');
      if (msg.replyTo) {
        await broker.publish(
          msg.replyTo,
          {
            pattern: 'context-source.query.result',
            data: { answer: 'RESPUESTA-DE-LA-FUENTE-DE-VERDAD' },
            correlationId: msg.correlationId,
          },
          { assert: false },
        );
      }
    });

    const cs = await createContextSource(t.prisma, {
      tenantId: tenant.id,
      name: 'Fuente-07',
      type: 'broker',
      config: { queueName }, // responseMode por defecto: 'rpc'
    });
    await startFlow(tenant, role, [startNode('s'), llmQueryNode('q')], [edge('s', 'q', 'known')], {
      contextSourceId: cs.id,
    });

    const body = 'gracias'; // mensaje trivial adrede: la consulta es incondicional (ya no hay sentinel, ver CHAT-LLMF-06)
    const res = await simulate(phone, tenant.id, body);

    expect(res.status).toBe(201);
    expect(questionsReceived).toEqual([body]); // se consultó la fuente aunque el mensaje no la necesitara

    const call = llm.calls[llm.calls.length - 1];
    const systemMessages = call.messages.filter((m) => m.role === 'system');
    expect(systemMessages.some((m) => m.content.includes('RESPUESTA-DE-LA-FUENTE-DE-VERDAD'))).toBe(true);
  });

  // ===========================================================================================
  // subflow
  // ===========================================================================================

  it('CHAT-N-SUB-01a: con flowId válido y sin entryNodeId entra por el nodo start del sub-flujo', async () => {
    const { tenant, role, phone } = await newKnownUser('sub01a');
    const subFlow = await createFlow(t.prisma, {
      name: `SUB-${uniqueSlug('f')}`,
      nodes: [startNode('subS'), inputNode('subI', { text: 'Pregunta del sub-flujo', variableName: 'respSub' })],
      edges: [edge('subS', 'subI', 'known')],
    });
    await startFlow(tenant, role, [startNode('s'), subflowNode('sf', { flowId: subFlow.id })], [edge('s', 'sf', 'known')]);

    const res = await simulate(phone, tenant.id);
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Entrando a sub-flujo'); // texto default del nodo subflow (sin data.text)
    expect(res.body.reply).toContain('Pregunta del sub-flujo'); // llegó hasta el input DEL sub-flujo

    const conv = await conversationFor(tenant.id, phone);
    expect(conv.currentFlowId).toBe(subFlow.id); // cambió de flujo entero, no solo de nodo
    expect(conv.currentNodeId).toBe('subI'); // entró por el propio start del sub-flujo y avanzó hasta el input
  });

  it('CHAT-N-SUB-01b: con entryNodeId explícito entra directo por ese nodo, saltando el start del sub-flujo', async () => {
    const { tenant, role, phone } = await newKnownUser('sub01b');
    const subFlow = await createFlow(t.prisma, {
      name: `SUB-${uniqueSlug('f')}`,
      nodes: [
        startNode('subS'),
        inputNode('subI', { text: 'Pregunta del sub-flujo', variableName: 'respSub' }),
        messageNode('subM', 'Nodo de entrada directa'),
        endNode('subE'),
      ],
      edges: [edge('subS', 'subI', 'known'), edge('subI', 'subM'), edge('subM', 'subE')],
    });
    await startFlow(
      tenant,
      role,
      [startNode('s'), subflowNode('sf', { flowId: subFlow.id, entryNodeId: 'subM' })],
      [edge('s', 'sf', 'known')],
    );

    const res = await simulate(phone, tenant.id);
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Nodo de entrada directa');
    expect(res.body.reply).not.toContain('Pregunta del sub-flujo'); // no pasó por el start/input del sub-flujo
    // Un solo saludo "Bienvenido de nuevo": el del flujo padre. Si hubiera entrado por el start
    // del sub-flujo (como en SUB-01a), habría un segundo saludo — acá no, porque entryNodeId lo salteó.
    expect((res.body.reply.match(/Bienvenido de nuevo/g) || []).length).toBe(1);

    // subM -> subE (end) cerró la charla en el mismo turno: `closeConversation` resetea
    // currentFlowId/currentNodeId a null (mismo código que cualquier nodo 'end'), así que no
    // queda registro post-hoc de haber pasado por subFlow — la prueba de que sí cambió de
    // flujo es el contenido de la respuesta (arriba): 'Nodo de entrada directa' no existe en
    // ningún nodo del flujo padre.
    const conv = await conversationFor(tenant.id, phone);
    expect(conv.status).toBe('closed');
    expect(conv.currentFlowId).toBeNull();
  });

  it('CHAT-N-SUB-02: sin flowId responde "Error: sub-flujo no configurado." y no cambia de flujo', async () => {
    const { tenant, role, phone } = await newKnownUser('sub02');
    const flow = await startFlow(tenant, role, [startNode('s'), subflowNode('sf', {})], [edge('s', 'sf', 'known')]);

    const res = await simulate(phone, tenant.id);
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Error: sub-flujo no configurado.');

    // No hubo __subflow: el flujo activo sigue siendo el mismo (fin del flujo por agotar nodos,
    // sin ninguna arista de salida desde 'sf' en este fixture).
    const conv = await conversationFor(tenant.id, phone);
    expect(conv.currentFlowId === flow.id || conv.currentFlowId === null).toBe(true);
  });

  it.failing(
    'CHAT-N-SUB-03 (SEC-15): flowId inexistente debe dar un error controlado sin cortar la charla — HOY flowService.findById lanza NotFoundException sin capturar',
    async () => {
      const { tenant, role, phone } = await newKnownUser('sub03');
      await startFlow(
        tenant,
        role,
        [startNode('s'), subflowNode('sf', { flowId: `flow-inexistente-${uniqueSlug('x')}` })],
        [edge('s', 'sf', 'known')],
      );

      const channel = `sub03-${uniqueSlug('chn')}`; // cola de salida dedicada, ver comentario de cabecera
      const outgoing: BrokerMessage[] = [];
      await broker.subscribe(`${channel}.outgoing`, (msg) => {
        outgoing.push(msg);
      });

      const sent = await broker.publish('whatsapp.incoming', {
        pattern: 'message.received',
        data: { from: phone, body: 'hola', channel },
        tenantId: tenant.id,
        timestamp: new Date().toISOString(),
      });
      expect(sent).toBe(true);

      // Comportamiento SEGURO esperado: un aviso controlado (p. ej. "Error: sub-flujo no
      // encontrado.", el mismo texto que YA existe en el código pero que el `if (!subFlow)`
      // muerto nunca alcanza a devolver), no un cuelgue. Hoy `flowService.findById(subFlowId)`
      // tira `NotFoundException` sin que nada la capture en `case 'subflow'`, así que nunca
      // llega nada a esta cola dentro del plazo.
      const reply = await waitForBucket(outgoing, 5000);
      expect(typeof (reply.data as { body?: string }).body).toBe('string');
    },
    15000,
  );
});
