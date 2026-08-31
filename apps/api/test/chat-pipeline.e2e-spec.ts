/**
 * 2.1 Pipeline de un mensaje (`handleMessage`) (CHAT-PIPE-*)
 *
 * Vía: `POST /conversations/simulate` con { from, body, tenantId } para los casos que tienen
 * `replyTo` (siempre por simulate); `BrokerService.publish()` directo a `whatsapp.incoming`
 * para los casos que necesitan el canal REAL (sin `replyTo`, no observable por simulate — ver
 * CHAT-PIPE-02/08 más abajo).
 *
 * Frontera mockeada: `LlmService` → `FakeLlmService`. El motor de flujos y el broker NO se
 * mockean: se ejercitan de verdad (RabbitMQ de punta a punta, igual que chat-start.e2e-spec.ts).
 *
 * SMS es 100% saliente (pedido de DEVELOPMENT, ver `SmsModule`/`ConversationsService.
 * onModuleInit`): no hay webhook de entrada ni suscripción a `sms.incoming` para ningún
 * proveedor — no hay conversación bidireccional por ese canal, así que no hay un CHAT-PIPE-07
 * "mismo teléfono por whatsapp y por sms" que probar acá.
 *
 * "No hablamos con desconocidos" (pedido 2026-08-27, ver `ConversationsService.handleMessage`):
 * un teléfono sin membresía en el tenant se rechaza ANTES de crear nada — ya no hay `User`
 * placeholder. Como acá se manda `tenantId` explícito (vía `/simulate`, no ruteo por
 * membresía), ese rechazo cae en el mismo lugar que antes resolvía "conocido": cada test que
 * ejercita el pipeline entero (CHAT-PIPE-01/04/05/06/08) necesita un teléfono REGISTRADO
 * (`knownUser`). CHAT-PIPE-02/03 (tenant dado de baja) no lo necesitan: ese corte ("0. Baja
 * lógica de la empresa") corre ANTES del chequeo de membresía, así que un teléfono sin
 * membresía sigue siendo válido para probarlo.
 *
 * Flujo fixture: un flujo `isDefault` propio, con las dos ramas de `start` (`known`/`unknown`)
 * convergiendo al mismo `message` + `end`, así toda conversación de este archivo se cierra en
 * un solo turno (deliberado: simplifica reanudación/cierre en CHAT-PIPE-04/05 y deja la
 * respuesta 100% determinística sin invocar al LLM). Hazard de `Flow.isDefault` GLOBAL: ver
 * flow-builder.ts. La rama `unknown` queda inalcanzable por este camino (ver chat-known.e2e-
 * spec.ts, que cubre el rechazo en sí) — se conserva en el flujo solo porque `start` la exige.
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
  uniqueEmail,
  uniqueSlug,
  uniquePhone,
  FakeLlmService,
  startNode,
  endNode,
  edge,
} from './support';

/** Responder por defecto de los clasificadores del engine (cierre/cancelación/menú), inofensivo
 * si algún body llegara a disparar uno por error — ninguno de los bodies usados acá lo hace. */
function defaultLlmResponder(messages: { content: string }[]): string {
  const sys = messages[0]?.content ?? '';
  if (sys.includes('CERRAR')) return 'SEGUIR';
  if (sys.includes('clasificador de intención para un menú')) return 'NINGUNA';
  if (sys.includes('CANCELAR')) return 'CONTINUAR';
  return 'respuesta del modelo';
}

/** Poll simple para los casos que publican directo al broker sin `replyTo` (sin respuesta
 * síncrona que esperar): reintenta hasta que la condición asíncrona (creada por el consumer
 * real de `whatsapp.incoming`/`sms.incoming`) se refleje en la base. */
async function waitUntil<T>(
  check: () => Promise<T | null | undefined>,
  { timeoutMs = 5000, intervalMs = 150 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: se agotó el tiempo esperando la condición');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('2.1 Pipeline de un mensaje (CHAT-PIPE-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let broker: BrokerService;

  let tenant: { id: string };
  let tenantBaja: { id: string };
  let role: { id: string };

  const FLOW_TEXT_END = 'Fin.';

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  /** El nodo `start` ignora `data.text` para un usuario conocido: siempre arma este saludo
   *  interpolando `firstName` (ver ConversationsService.executeNode, case 'start') —
   *  `data.text` solo se usa como fallback para la rama `unknown`, inalcanzable acá. */
  function fullReplyFor(firstName: string) {
    return `¡Hola ${firstName}! Bienvenido de nuevo.\n\n${FLOW_TEXT_END}`;
  }

  /** Teléfono registrado en `tenant` (con membership): "no hablamos con desconocidos" exige
   *  esto para que el pipeline llegue a crear Conversation/Message — ver el comentario grande
   *  de arriba del archivo. */
  async function knownUser(label: string) {
    const phone = uniquePhone();
    const user = await createUser(t.prisma, {
      email: uniqueEmail(label),
      phone,
      firstName: label,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    return { phone, user };
  }

  async function unsetAllDefaults() {
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  beforeAll(async () => {
    llm = new FakeLlmService().setResponder(defaultLlmResponder);
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
    broker = t.moduleRef.get(BrokerService);

    tenant = await createTenant(t.prisma, { slug: uniqueSlug('pipe') });
    tenantBaja = await createTenant(t.prisma, { slug: uniqueSlug('pipe-baja'), deletedAt: new Date() });
    role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol pipeline' });

    await unsetAllDefaults();
    // Flujo de un solo turno: start (known/unknown convergen) -> message -> end. Se cierra solo
    // (nodo `end`), lo que deja cada conversación de este archivo en status 'closed' apenas
    // termina el turno — justo lo que necesitan CHAT-PIPE-04/05 para probar la reapertura.
    await t.prisma.flow.create({
      data: {
        name: 'F-PIPE',
        nodes: [startNode('s'), endNode('e', FLOW_TEXT_END)] as never,
        edges: [edge('s', 'e', 'known'), edge('s', 'e', 'unknown')] as never,
        isDefault: true,
        isActive: true,
        context: 'none',
      },
    });
  });

  afterAll(async () => {
    await unsetAllDefaults();
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
    llm.setResponder(defaultLlmResponder);
  });

  it('CHAT-PIPE-01: primer mensaje de un usuario registrado crea la conversación y ejecuta el flujo', async () => {
    const { phone, user } = await knownUser('pipe01');

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe(fullReplyFor('pipe01'));

    const conversation = await t.prisma.conversation.findFirst({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
    });
    expect(conversation).toBeTruthy();
  });

  it('CHAT-PIPE-02: mensaje a un tenant dado de baja por el canal REAL se ignora en silencio, sin crear usuario ni gastar LLM', async () => {
    // No observable por /simulate (siempre manda `replyTo`, ver CHAT-PIPE-03): se publica
    // directo en `whatsapp.incoming`, la cola real, sin `replyTo`. `handleMessage` corta en el
    // guard de tenant dado de baja (código real, apps/api/.../conversations.service.ts,
    // sección "0. Baja lógica de la empresa") ANTES de resolver/crear usuario o conversación.
    const phone = uniquePhone();
    const callsBefore = llm.calls.length;

    const sent = await broker.publish('whatsapp.incoming', {
      pattern: 'message.received',
      data: { from: phone, body: 'hola', channel: 'whatsapp' },
      tenantId: tenantBaja.id,
      timestamp: new Date().toISOString(),
    });
    expect(sent).toBe(true);

    // Da tiempo al consumer real a procesarlo (no hay respuesta síncrona que esperar: es
    // exactamente el "silencio" que describe el caso).
    await new Promise((r) => setTimeout(r, 800));

    const user = await t.prisma.user.findFirst({ where: { phone } });
    expect(user).toBeNull();

    const conversations = await t.prisma.conversation.findMany({ where: { tenantId: tenantBaja.id } });
    expect(conversations).toHaveLength(0);

    expect(llm.calls.length).toBe(callsBefore); // no gastó LLM
  });

  it('CHAT-PIPE-03: mismo caso por simulate (con replyTo) responde un aviso, no cuelga al llamador', async () => {
    const phone = uniquePhone();

    const res = await simulate(phone, tenantBaja.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('La empresa está dada de baja: el bot no atiende sus mensajes.');

    // El mismo guard corta antes de crear usuario/conversación, con o sin replyTo (ver el
    // código: el chequeo de tenant es previo al paso "1. Identificar al usuario").
    const user = await t.prisma.user.findFirst({ where: { phone } });
    expect(user).toBeNull();
  });

  it('CHAT-PIPE-04: segundo mensaje dentro de la ventana de reanudación (12h) reabre la conversación cerrada (mismo id)', async () => {
    const { phone, user } = await knownUser('pipe04');

    const first = await simulate(phone, tenant.id);
    expect(first.status).toBe(201);

    const conv1 = await t.prisma.conversation.findFirstOrThrow({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
    });
    expect(conv1.status).toBe('closed'); // el flujo la cierra solo (nodo `end`)

    // La cerramos "hace 6h" (dentro de RESUME_WINDOW_MS = 12h) manipulando closedAt con prisma,
    // como indica la consigna para este caso.
    await t.prisma.conversation.update({
      where: { id: conv1.id },
      data: { closedAt: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    });

    const second = await simulate(phone, tenant.id);
    expect(second.status).toBe(201);
    expect(second.body.reply).toBe(fullReplyFor('pipe04')); // vuelve a correr el flujo desde el start

    const conversations = await t.prisma.conversation.findMany({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
    });
    // Mismo id: se reabrió la existente, no se creó una nueva.
    expect(conversations).toHaveLength(1);
    expect(conversations[0].id).toBe(conv1.id);

    // Historial mantenido: los Message de ambos turnos siguen en la misma fila.
    const messages = await t.prisma.message.findMany({ where: { conversationId: conv1.id } });
    expect(messages).toHaveLength(4); // 2 turnos x (user + assistant)
  });

  it('CHAT-PIPE-05: mensaje tras vencer la ventana de reanudación crea una conversación nueva', async () => {
    const { phone, user } = await knownUser('pipe05');

    const first = await simulate(phone, tenant.id);
    expect(first.status).toBe(201);

    const conv1 = await t.prisma.conversation.findFirstOrThrow({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
    });

    // "Hace 13h": fuera de la ventana de 12h.
    await t.prisma.conversation.update({
      where: { id: conv1.id },
      data: { closedAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
    });

    const second = await simulate(phone, tenant.id);
    expect(second.status).toBe(201);
    expect(second.body.reply).toBe(fullReplyFor('pipe05'));

    const conversations = await t.prisma.conversation.findMany({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
      orderBy: { createdAt: 'asc' },
    });
    expect(conversations).toHaveLength(2); // una nueva, no la reabrió
    expect(conversations[0].id).toBe(conv1.id);
    expect(conversations[1].id).not.toBe(conv1.id);
  });

  it('CHAT-PIPE-06: se persiste el mensaje del usuario y luego el del asistente, ambos con senderType correcto', async () => {
    const { phone, user } = await knownUser('pipe06');
    const body = 'hola, este es mi mensaje';

    const res = await simulate(phone, tenant.id, body);
    expect(res.status).toBe(201);

    const conversation = await t.prisma.conversation.findFirstOrThrow({
      where: { userId: user.id, tenantId: tenant.id, channel: 'whatsapp' },
    });

    const messages = await t.prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].senderType).toBe('user');
    expect(messages[0].content).toBe(body);
    expect(messages[1].senderType).toBe('assistant');
    expect(messages[1].content).toBe(res.body.reply);
  });

  it('CHAT-PIPE-08: mensaje entrante sin channel explícito resuelve/crea la conversación de whatsapp (default retrocompatible)', async () => {
    // No observable por /simulate: `simulateIncomingMessage` nunca manda `channel` en el data,
    // así que TODO simulate ya ejercita este default implícitamente (ver CHAT-PIPE-01..07). Para
    // un caso explícito y aislado, se publica directo en `whatsapp.incoming` (la cola real) sin
    // el campo `channel`, imitando a un publisher viejo (o el propio webhook de Meta antes de
    // que se agregara el campo).
    const { phone, user } = await knownUser('pipe08');

    const sent = await broker.publish('whatsapp.incoming', {
      pattern: 'message.received',
      data: { from: phone, body: 'hola' }, // sin channel
      tenantId: tenant.id,
      timestamp: new Date().toISOString(),
    });
    expect(sent).toBe(true);

    const conversation = await waitUntil(() =>
      t.prisma.conversation.findFirst({ where: { userId: user.id, tenantId: tenant.id } }),
    );

    expect(conversation.channel).toBe('whatsapp');
  });
});
