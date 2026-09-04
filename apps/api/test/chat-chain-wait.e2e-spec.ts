/**
 * 2.4 Encadenamiento y tope de pasos (CHAT-CHAIN-*)
 * 2.5 Espera en dos fases — `waitForInput` (CHAT-WAIT-*)
 *
 * Vía: POST /conversations/simulate (mismo patrón que chat-start.e2e-spec.ts, el EXEMPLAR).
 * Frontera mockeada: solo `LlmService` → `FakeLlmService`. El motor de flujos
 * (`ConversationsService.executeFlow`/`executeNode`) se ejercita de verdad, incluida la
 * mecánica de RabbitMQ de punta a punta que atraviesa `/simulate`.
 *
 * Todo lo que sigue está verificado leyendo `executeFlow`/`executeNode` en
 * `src/modules/conversations/conversations.service.ts` (no se infiere del plan):
 *
 * - `executeFlow` es un `while (nodeId && steps < MAX_FLOW_STEPS)` (MAX_FLOW_STEPS=25) que
 *   ejecuta nodo tras nodo EN LA MISMA REQUEST hasta: (a) un nodo con `waitForInput`, (b) un
 *   nodo que resuelve a sí mismo (`nextNodeId === node.id`, tratado como espera aunque no
 *   pida `waitForInput`), (c) un `llm_query` sin arista saliente (punto conversacional
 *   terminal, mismo trato que una espera), (d) `endConversation`/`cancelFlow`, o (e) que se
 *   acaben los nodos.
 * - Al tope de 25 pasos: loguea error, `resetFlow` (pone `currentFlowId/currentNodeId/
 *   flowState` en `null`, deja `status` intacto) y agrega el texto fijo "Se interrumpió el
 *   flujo por un problema de configuración." a lo ya acumulado. Pasa por `/simulate` normal
 *   (201), no crashea.
 * - Nodo actual no encontrado en `nodes` (flujo editado en caliente): el chequeo está AL
 *   PRINCIPIO de cada vuelta del loop, antes de ejecutar nada. Si el nodo que falta es
 *   exactamente donde estaba parada la conversación, `responses` está vacío en esa llamada y
 *   `toFlowResult([])` devuelve `null` → `executeFlow` devuelve `null` → `handleMessage` cae
 *   al orquestador LLM (NO es "lo acumulado", discrepancia con el plan documentada abajo en
 *   CHAT-CHAIN-04). Si en cambio el nodo faltante es uno río abajo (se llegó a él encadenando
 *   nodos no interactivos dentro del mismo turno), sí hay texto acumulado y ESE es el que
 *   vuelve.
 * - `menu`: primera llegada muestra opciones (`flowState.__awaiting = node.id`) y devuelve
 *   `waitForInput`. Si la respuesta no matchea ninguna opción ni es cancelación, se interpreta
 *   con el LLM (`interpretMenuChoice`); si tampoco ahí matchea nada, el nodo NO vuelve a
 *   ofrecer las opciones: pasa a `flowState.__llmFallback = node.id` (reemplaza `__awaiting`)
 *   y responde con el orquestador LLM libre — el nodo actual se re-persiste (mismo
 *   `currentNodeId`), pero el MODO cambió. Por eso, para CHAT-WAIT-03 ("vuelve a persistir el
 *   mismo nodo y sigue esperando") se usa acá el caso de `device_validation` con código
 *   incorrecto, que sí re-persiste el mismo nodo SIN cambiar de modo (sigue en
 *   `flowState.__awaiting`, mismo código, mismo mensaje de reintento) — ver el comentario en
 *   ese bloque.
 */
import { LlmService } from '../src/modules/llm/llm.service';
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
  menuNode,
  inputNode,
  llmQueryNode,
  deviceValidationNode,
  edge,
} from './support';

describe('2.4 Encadenamiento y tope de pasos (CHAT-CHAIN-*) / 2.5 Espera en dos fases (CHAT-WAIT-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let tenant: { id: string };

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  /** Rol + usuario CONOCIDO (membresía real) propios de un caso, para no chocar con otros. */
  async function makeKnownUser(roleName: string, firstName: string) {
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: roleName });
    const phone = uniquePhone();
    const user = await createUser(t.prisma, {
      email: uniqueEmail(roleName.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
      phone,
      firstName,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { role, phone, user };
  }

  async function findConversation(userId: string) {
    return t.prisma.conversation.findFirstOrThrow({
      where: { userId, tenantId: tenant.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
    // Tenant propio: los flujos de acá se asignan como inicio por (tenant, rol) — no
    // dependen de `Flow.isDefault` (global) porque cada usuario es CONOCIDO y su rol
    // siempre tiene un flujo de inicio propio, así que `findActiveFlowForTenant` resuelve
    // por `TenantFlow.isStart` sin llegar a mirar el default global. No hace falta
    // desmarcar/marcar `isDefault` como en chat-start.e2e-spec.ts.
    tenant = await createTenant(t.prisma, { slug: uniqueSlug('chainwait') });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  describe('2.4 Encadenamiento y tope de pasos (CHAT-CHAIN-*)', () => {
    it('CHAT-CHAIN-01: start → message → llm_query se recorre entero en un solo turno', async () => {
      const { role, phone } = await makeKnownUser('Rol Chain01', 'Ana');
      await createFlow(t.prisma, {
        name: 'F-CHAIN-01',
        nodes: [
          startNode('s1'),
          messageNode('m1', 'Mensaje intermedio.'),
          llmQueryNode('lq1', {}),
        ],
        edges: [edge('s1', 'm1', 'known'), edge('m1', 'lq1')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });
      llm.setReply('Respuesta del LLM en cadena.');

      const res = await simulate(phone, tenant.id, 'hola');

      expect(res.status).toBe(201);
      // Los tres nodos no interactivos (start, message, llm_query) contestaron en el
      // mismo turno: no hicieron falta tres mensajes del usuario.
      expect(res.body.reply).toContain('Bienvenido de nuevo');
      expect(res.body.reply).toContain('Mensaje intermedio.');
      expect(res.body.reply).toContain('Respuesta del LLM en cadena.');
      // Una sola llamada al LLM (la del nodo llm_query): confirma que se encadenó todo
      // en esta request y no se repitió nada.
      expect(llm.calls.length).toBe(1);

      // `llm_query` sin arista saliente es un punto terminal conversacional (no un fin de
      // flujo): la conversación queda parada ahí, no se cierra.
      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      expect(conv.status).toBe('active');
      expect(conv.currentNodeId).toBe('lq1');
    });

    it('CHAT-CHAIN-02: ciclo entre nodos no interactivos corta a los 25 pasos (MAX_FLOW_STEPS) y resetea', async () => {
      const { role, phone } = await makeKnownUser('Rol Chain02', 'Beto');
      await createFlow(t.prisma, {
        name: 'F-CHAIN-02',
        nodes: [startNode('s2'), messageNode('c1', 'Ciclo A.'), messageNode('c2', 'Ciclo B.')],
        // Ciclo real de 2 nodos (c1 <-> c2), distinto de un nodo que se apunta a sí mismo
        // (eso es CHAT-CHAIN-03, tratado como espera y NO entra acá).
        edges: [edge('s2', 'c1', 'known'), edge('c1', 'c2'), edge('c2', 'c1')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      const res = await simulate(phone, tenant.id, 'hola');

      expect(res.status).toBe(201); // manejado: no crashea, no hay 5xx ni timeout
      expect(res.body.reply).toContain('Se interrumpió el flujo por un problema de configuración.');

      // Steps 1..25: paso 1 = start, pasos 2..25 alternan c1/c2 (12 vueltas cada uno) hasta
      // que `steps < MAX_FLOW_STEPS` corta. Verificado contra la constante real del código
      // (MAX_FLOW_STEPS = 25), no contra un número supuesto.
      const countA = (res.body.reply.match(/Ciclo A\./g) || []).length;
      const countB = (res.body.reply.match(/Ciclo B\./g) || []).length;
      expect(countA).toBe(12);
      expect(countB).toBe(12);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      // `resetFlow` (no `closeConversation`): limpia la posición pero NO cierra la charla.
      expect(conv.currentFlowId).toBeNull();
      expect(conv.currentNodeId).toBeNull();
      expect(conv.flowState).toBeNull();
      expect(conv.status).toBe('active');
    });

    it('CHAT-CHAIN-03: un nodo que se apunta a sí mismo queda esperando, no da 25 vueltas', async () => {
      const { role, phone } = await makeKnownUser('Rol Chain03', 'Caro');
      await createFlow(t.prisma, {
        name: 'F-CHAIN-03',
        nodes: [startNode('s3'), messageNode('self3', 'Quedate acá.')],
        edges: [edge('s3', 'self3', 'known'), edge('self3', 'self3')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      const res1 = await simulate(phone, tenant.id, 'hola');
      expect(res1.status).toBe(201);
      // Exactamente 2 textos (saludo + el del nodo), no una cadena repetida: si hubiera
      // dado 25 vueltas, "Quedate acá." aparecería muchas veces.
      expect(res1.body.reply).toBe('¡Hola Caro! Bienvenido de nuevo.\n\nQuedate acá.');

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      let conv = await findConversation(user.id);
      expect(conv.currentNodeId).toBe('self3');

      // Un segundo mensaje cualquiera: retoma en 'self3' (no en 's3'), no repite el saludo,
      // y vuelve a persistirse a sí mismo (una sola ejecución, no 25).
      const res2 = await simulate(phone, tenant.id, 'otra vez');
      expect(res2.status).toBe(201);
      expect(res2.body.reply).toBe('Quedate acá.');

      conv = await findConversation(user.id);
      expect(conv.currentNodeId).toBe('self3');
    });

    it('CHAT-CHAIN-04: nodo río abajo eliminado en caliente — resetea y devuelve lo acumulado', async () => {
      const { role, phone } = await makeKnownUser('Rol Chain04a', 'Dani');
      const flow = await createFlow(t.prisma, {
        name: 'F-CHAIN-04A',
        nodes: [
          startNode('s4a'),
          menuNode('mm4a', { text: 'Elegí:', options: [{ value: '1', label: 'Seguir' }] }),
          messageNode('mb4a', 'Camino intermedio.'),
          messageNode('mg4a', 'Nunca se llega acá.'),
        ],
        edges: [edge('s4a', 'mm4a', 'known'), edge('mm4a', 'mb4a', '1'), edge('mb4a', 'mg4a')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      // Turno 1: llega al menú y queda esperando.
      await simulate(phone, tenant.id, 'hola');

      // Edición en caliente: se borra 'mg4a' (el nodo AL QUE APUNTA 'mb4a', no el nodo
      // donde está parada la conversación). El nodo parado ('mm4a') y el siguiente
      // ('mb4a') siguen existiendo, así que sí se llega a ejecutar 'mb4a' (que acumula
      // texto) antes de toparse con el hueco.
      const freshFlow = await t.prisma.flow.findUniqueOrThrow({ where: { id: flow.id } });
      const editedNodes = (freshFlow.nodes as any[]).filter((n) => n.id !== 'mg4a');
      await t.prisma.flow.update({ where: { id: flow.id }, data: { nodes: editedNodes as any } });

      llm.reset();
      const res2 = await simulate(phone, tenant.id, '1');

      expect(res2.status).toBe(201);
      // "Lo acumulado" = el texto de 'mb4a', el único nodo que llegó a ejecutarse en este
      // turno antes de toparse con el nodo faltante.
      expect(res2.body.reply).toBe('Camino intermedio.');
      // No cayó al orquestador LLM (había flowResult no-nulo): 0 llamadas al LLM.
      expect(llm.calls.length).toBe(0);

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      expect(conv.currentFlowId).toBeNull();
      expect(conv.currentNodeId).toBeNull();
      expect(conv.flowState).toBeNull();
    });

    it('CHAT-CHAIN-04: el propio nodo donde está parada la charla se elimina — no hay nada acumulado, turno silencioso (discrepancia con el plan)', async () => {
      // El plan dice "resetea el flujo y devuelve lo acumulado" para cualquier caso de nodo
      // eliminado en caliente. Leyendo el código: el chequeo "nodo no encontrado" está al
      // PRINCIPIO de cada vuelta del loop, antes de ejecutar nada. Si el nodo que falta es
      // justo donde estaba parada la conversación (el caso más común de una edición en
      // caliente: borrar el nodo en el que alguien quedó esperando), `responses` está vacío
      // `[]` en esa llamada → `toFlowResult([])` devuelve `{ text: '' }` (ya NO `null`) →
      // `executeFlow` devuelve ese objeto truthy → `handleMessage` NO cae al orquestador LLM
      // (esa rama es solo para "ningún flujo activo"): entra al corte de "turno silencioso"
      // (`!responseText && !interactive`) y responde vacío, sin gastar LLM. El reseteo de la
      // conversación sí ocurre igual.
      const { role, phone } = await makeKnownUser('Rol Chain04b', 'Eze');
      const flow = await createFlow(t.prisma, {
        name: 'F-CHAIN-04B',
        nodes: [startNode('s4b'), menuNode('mm4b', { text: 'Elegí:', options: [{ value: '1', label: 'Seguir' }] })],
        edges: [edge('s4b', 'mm4b', 'known')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      await simulate(phone, tenant.id, 'hola'); // queda parada en 'mm4b'

      const freshFlow = await t.prisma.flow.findUniqueOrThrow({ where: { id: flow.id } });
      const editedNodes = (freshFlow.nodes as any[]).filter((n) => n.id !== 'mm4b');
      await t.prisma.flow.update({ where: { id: flow.id }, data: { nodes: editedNodes as any } });

      llm.reset();
      const res2 = await simulate(phone, tenant.id, '1');

      expect(res2.status).toBe(201);
      expect(res2.body.reply).toBe(''); // turno silencioso: nada acumulado, no hay flowResult null
      expect(llm.calls.length).toBe(0); // el orquestador NO se llama: sí hay flowResult (no es null)

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      // El reseteo ocurre igual, aunque el resultado que se le devuelve al usuario sea
      // otro (el fallback general en vez del texto acumulado).
      expect(conv.currentFlowId).toBeNull();
      expect(conv.currentNodeId).toBeNull();
      expect(conv.flowState).toBeNull();
    });

    it('CHAT-CHAIN-05: varios textos acumulados antes de un menú se fusionan en un solo body', async () => {
      const { role, phone } = await makeKnownUser('Rol Chain05', 'Léo');
      await createFlow(t.prisma, {
        name: 'F-CHAIN-05',
        nodes: [
          startNode('s5'),
          messageNode('adv5', 'Aviso importante.'),
          menuNode('mm5', {
            text: 'Elegí una opción',
            options: [
              { value: '1', label: 'Sí' },
              { value: '2', label: 'No' },
            ],
          }),
        ],
        edges: [edge('s5', 'adv5', 'known'), edge('adv5', 'mm5')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      const res = await simulate(phone, tenant.id, 'hola');

      expect(res.status).toBe(201);
      // Los tres textos (saludo, aviso, header del menú) van juntos, en orden, en el
      // mismo body — y cada uno aparece una sola vez (no se duplica por el merge con
      // `interactive.body`, que en `executeFlow` se arma con el mismo `responses.join`).
      const reply: string = res.body.reply;
      const idxGreeting = reply.indexOf('Bienvenido de nuevo');
      const idxAviso = reply.indexOf('Aviso importante.');
      const idxMenu = reply.indexOf('Elegí una opción');
      expect(idxGreeting).toBeGreaterThanOrEqual(0);
      expect(idxAviso).toBeGreaterThan(idxGreeting);
      expect(idxMenu).toBeGreaterThan(idxAviso);
      expect(reply.split('Aviso importante.').length - 1).toBe(1);
    });
  });

  describe('2.5 Espera en dos fases — waitForInput (CHAT-WAIT-*)', () => {
    it('CHAT-WAIT-01: llegar a un input persiste currentNodeId + flowState y devuelve el turno', async () => {
      const { role, phone } = await makeKnownUser('Rol Wait01', 'Fabi');
      const flow = await createFlow(t.prisma, {
        name: 'F-WAIT-INPUT-01',
        nodes: [
          startNode('sw1'),
          inputNode('inp1', { text: '¿Cuál es tu email de contacto?', variableName: 'contactEmail' }),
          menuNode('mmw1', { text: '¿Confirmás el envío?', options: [{ value: '1', label: 'Sí' }] }),
        ],
        edges: [edge('sw1', 'inp1', 'known'), edge('inp1', 'mmw1')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      const res = await simulate(phone, tenant.id, 'hola');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('¿Cuál es tu email de contacto?');

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      expect(conv.currentFlowId).toBe(flow.id);
      expect(conv.currentNodeId).toBe('inp1');
      expect((conv.flowState as any).__awaiting).toBe('inp1');
    });

    it('CHAT-WAIT-02: el siguiente mensaje reanuda desde ese nodo y se interpreta como la respuesta', async () => {
      const { role, phone } = await makeKnownUser('Rol Wait02', 'Gonza');
      await createFlow(t.prisma, {
        name: 'F-WAIT-INPUT-02',
        nodes: [
          startNode('sw2'),
          inputNode('inp2', { text: '¿Cuál es tu email de contacto?', variableName: 'contactEmail' }),
          menuNode('mmw2', { text: '¿Confirmás el envío?', options: [{ value: '1', label: 'Sí' }] }),
        ],
        edges: [edge('sw2', 'inp2', 'known'), edge('inp2', 'mmw2')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      await simulate(phone, tenant.id, 'hola'); // llega a 'inp2' y queda esperando

      const res2 = await simulate(phone, tenant.id, 'juan@example.com');

      expect(res2.status).toBe(201);
      // No repite el saludo ni vuelve a preguntar el email: retomó en 'inp2', usó
      // "juan@example.com" como la respuesta pedida (no como un mensaje nuevo) y avanzó
      // directo al próximo nodo en el MISMO turno.
      expect(res2.body.reply).not.toContain('Bienvenido de nuevo');
      expect(res2.body.reply).not.toContain('¿Cuál es tu email de contacto?');
      expect(res2.body.reply).toContain('¿Confirmás el envío?');

      const user = await t.prisma.user.findUniqueOrThrow({ where: { phone } });
      const conv = await findConversation(user.id);
      expect(conv.currentNodeId).toBe('mmw2');
      expect((conv.flowState as any).contactEmail).toBe('juan@example.com');
    });

    it('CHAT-WAIT-03: código de validación incorrecto re-persiste el mismo nodo, en el mismo modo, y sigue esperando', async () => {
      // Se usa `device_validation` (no `menu`) a propósito: una opción de menú inexistente
      // SÍ re-persiste el mismo `currentNodeId`, pero cambia el modo interno
      // (`flowState.__awaiting` → `flowState.__llmFallback`) y pasa a responder con el LLM
      // libre — no es "seguir esperando" en el mismo sentido. El código incorrecto de
      // `device_validation` es el caso que de verdad no cambia de modo: mismo
      // `flowState.__awaiting`, mismo código pendiente, mismo mensaje de reintento fijo.
      const { role, phone, user } = await makeKnownUser('Rol Wait03', 'Vicky');
      await createFlow(t.prisma, {
        name: 'F-WAIT-DEVICE-03',
        nodes: [
          startNode('sw3'),
          deviceValidationNode('dv3', { text: 'Verificación de dispositivo.' }),
          endNode('edv3', 'Validado, gracias.'),
        ],
        edges: [edge('sw3', 'dv3', 'known'), edge('dv3', 'edv3')],
        assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
      });

      t.email.reset();
      const turn1 = await simulate(phone, tenant.id, 'hola');
      expect(turn1.status).toBe(201);
      expect(turn1.body.reply).toContain('Verificación de dispositivo.');

      const realCode = t.email.codeFor(user.email);
      expect(realCode).toBeDefined();
      const wrongCode = realCode === '000000' ? '111111' : '000000';

      const turn2 = await simulate(phone, tenant.id, wrongCode);

      expect(turn2.status).toBe(201);
      expect(turn2.body.reply).toBe('Ese código no es correcto. Fijate bien y volvé a escribirlo.');

      const conv = await findConversation(user.id);
      // Mismo nodo re-persistido...
      expect(conv.currentNodeId).toBe('dv3');
      // ...en el MISMO modo (sigue siendo __awaiting, no pasó a otro estado)...
      expect((conv.flowState as any).__awaiting).toBe('dv3');
      // ...y sin regenerar el código (no venció, así que reusa el mismo).
      expect((conv.flowState as any).__deviceValidationCode).toBe(realCode);
    });
  });
});
