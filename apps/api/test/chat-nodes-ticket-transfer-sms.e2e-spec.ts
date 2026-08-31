/**
 * 2.3 Nodos del motor — ticket_create/ticket_query, transfer_agent, sms
 * (CHAT-N-TKC-*, CHAT-N-TKQ-*, CHAT-N-TRF-*, CHAT-N-SMS-*)
 *
 * Vía: `POST /conversations/simulate` (mismo patrón que `chat-start.e2e-spec.ts`), salvo
 * CHAT-N-TKC-04 que llama a `ConversationsService.handleMessage` directo (ver el comentario en
 * ese test — evita colgar 300s esperando una respuesta RPC que, ante una excepción no
 * capturada, `BrokerService` nunca llega a publicar) y CHAT-N-TKC-07a que hace lo mismo por otro
 * motivo: es la única forma de inyectar `attachments` en el mensaje entrante (los produce el
 * webhook de Twilio; `simulateIncomingMessage` no los reenvía).
 *
 * Fronteras mockeadas:
 * - `LlmService` → `FakeLlmService` (ninguno de estos flujos debería necesitarlo: los mensajes
 *   de prueba evitan a propósito las palabras de `CANCEL_HINT_WORDS`, así que no se dispara
 *   ningún clasificador).
 * - `EmailService` → grabador (`t.email`, por default de `createTestApp`).
 * - InvGate (CHAT-N-TKC-05/06/07a, CHAT-N-TKQ-04/05a) → `fetch` global mockeado con
 *   `installFetchMock` y un router propio (`makeInvgateMock`) que simula la API real de InvGate
 *   contra la que pega `InvgateService`. CHAT-N-TKC-07a envuelve ese router para contar los
 *   `attachments[]` del multipart de alta.
 * - Adjuntos (CHAT-N-TKC-07a/07b): archivos reales en un directorio temporal propio, que es lo
 *   que el webhook de Twilio ya habría descargado. No se mockea el filesystem: el motor los lee,
 *   los borra y (07b) el cron de retención de `TwilioMediaService` los limpia de verdad.
 * - `BrokerService.publish` (nodo `sms`) → spy PASSTHROUGH (`jest.spyOn`, sin
 *   `mockImplementation`): dejamos que el publish real ocurra (para no vaciar el test de
 *   sentido) y solo observamos con qué argumentos se llamó. Suscribir un consumer propio a
 *   `sms.outgoing` no sirve acá: `TwilioSmsService` ya está suscripto ahí por default
 *   (`SMS_PROVIDER` por defecto es 'twilio'), y dos consumers en la misma cola compiten por
 *   round robin de RabbitMQ (ver BE-BRK-12) — nos quedaríamos sin ver la mitad de los mensajes.
 *
 * El motor de flujos, Prisma y el broker NO se mockean (salvo el spy passthrough de arriba, que
 * no reemplaza comportamiento). Única excepción puntual: CHAT-N-TKC-04 mockea
 * `prisma.ticket.create` con `mockRejectedValueOnce` — no para simular lógica de negocio, sino
 * para forzar el único borde que el propio caso pide observar (una falla de BD real dentro del
 * nodo), documentado como límite conocido del código. Se restaura inmediatamente después.
 *
 * Invertidos (`it.failing`, comportamiento SEGURO que hoy no existe):
 * - CHAT-N-SMS-04 (SEC-18): `sms` con un recipient de otra empresa no debería mandarle nada.
 *
 * (CHAT-N-TKQ-03 / SEC-08 ya se cerró: `ticket_query` scopea por tenant → test normal, no invertido.)
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { BrokerService } from '../src/modules/broker/broker.service';
import { ConversationsService } from '../src/modules/conversations/conversations.service';
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
  setSetting,
  deleteSetting,
  installFetchMock,
  FakeLlmService,
  FetchRouter,
  startNode,
  endNode,
  messageNode,
  variableNode,
  inputNode,
  ticketCreateNode,
  ticketQueryNode,
  transferAgentNode,
  smsNode,
  edge,
  FlowNode,
  FlowEdge,
} from './support';
import { TwilioMediaService } from '../src/common/twilio-media.service';
import { stripArgentinaMobileNine } from '../src/common/phone.util';
import { mkdtemp, writeFile, stat, utimes, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Catálogo mínimo que arma `makeInvgateMock` para simular la API real de InvGate. */
interface InvgateMockCatalog {
  categories?: { id: number; name: string }[];
  priorities?: { id: number; name: string }[];
  types?: { id: number; name: string }[];
  statuses?: { id: number; name: string }[];
  /** Teléfono (tal cual llega a `resolveInvgateCustomerId`) → `customer_id` de InvGate. */
  customerIdByPhone?: Record<string, number>;
  /** `INVGATE_API_USER` → id de InvGate del usuario técnico (`creator_id`). */
  creatorIdByUsername?: Record<string, number>;
  /** `status_id` con el que nace cada incidente creado (default: el primero del catálogo). */
  initialStatusId?: number;
  /** Si `true`, el `GET incident` puntual (no el de catálogo) siempre falla — InvGate "caído". */
  failGetIncident?: boolean;
}

/**
 * Router de `installFetchMock` que responde como la API real de InvGate Service Desk
 * (`{baseUrl}/api/v1/<endpoint>`, ver `invgate.service.ts`) para los endpoints que estos tests
 * ejercitan: `users.by`, `incident.attributes.{category,priority,type,status}` e `incident`
 * (GET puntual y POST de alta). No pagina ni valida el payload — alcanza con lo que
 * `InvgateService` necesita para resolver nombres → ids y crear/consultar el incidente.
 */
function makeInvgateMock(catalog: InvgateMockCatalog) {
  const incidents = new Map<number, { id: number; status_id: number }>();
  let nextId = 9000 + Math.floor(Math.random() * 100000);

  const router: FetchRouter = (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v1\//, '');
    const method = (init?.method || 'GET').toUpperCase();

    if (method === 'GET' && path === 'users.by') {
      const phones = u.searchParams.get('phones');
      const username = u.searchParams.get('username');
      if (phones) {
        const id = catalog.customerIdByPhone?.[phones];
        return { body: { data: id ? { '1': { id } } : {} } };
      }
      if (username) {
        const id = catalog.creatorIdByUsername?.[username];
        return { body: { data: id ? { '1': { id } } : {} } };
      }
      return { body: { data: {} } };
    }
    if (method === 'GET' && path === 'incident.attributes.category') return { body: catalog.categories ?? [] };
    if (method === 'GET' && path === 'incident.attributes.priority') return { body: catalog.priorities ?? [] };
    if (method === 'GET' && path === 'incident.attributes.type') return { body: catalog.types ?? [] };
    if (method === 'GET' && path === 'incident.attributes.status') return { body: catalog.statuses ?? [] };
    if (method === 'POST' && path === 'incident') {
      const id = nextId++;
      const incident = { id, status_id: catalog.initialStatusId ?? catalog.statuses?.[0]?.id ?? 1 };
      incidents.set(id, incident);
      return { body: incident };
    }
    if (method === 'GET' && path === 'incident') {
      if (catalog.failGetIncident) throw new Error('InvGate caído (simulado para el test)');
      const id = Number(u.searchParams.get('id'));
      const incident = incidents.get(id);
      return incident ? { body: incident } : { status: 404, body: { error: 'not found' } };
    }
    return { status: 404, body: { error: `sin mock para ${method} ${path}` } };
  };

  return { router, incidents };
}

describe('2.3 Nodos del motor — ticket_create/ticket_query, transfer_agent, sms', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let broker: BrokerService;
  let service: ConversationsService;
  let media: TwilioMediaService;

  let tenantTkc: { id: string };
  let tenantTrf: { id: string };
  let tenantSms: { id: string };
  // Rol compartido para dar de alta agentes/watchers/collaborators/recipients DENTRO de la
  // empresa del flujo bajo prueba: `pickNextAssignee` y la resolución de destinatarios de
  // email/SMS ahora filtran por `tenantId` (SEC-18/19), así que un agente sin membresía en
  // esa empresa deja de ser un candidato válido — no importan sus permisos, solo pertenecer.
  let roleTrfAgent: { id: string };
  let roleSmsAgent: { id: string };

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  /** Tenant + rol + usuario conocido con un flujo de inicio propio armado con `nodes`/`edges`. */
  async function setupKnownFlow(tenantId: string, label: string, nodes: FlowNode[], edges: FlowEdge[]) {
    const role = await createRole(t.prisma, { tenantId, name: label });
    const phone = uniquePhone();
    const user = await createUser(t.prisma, {
      email: uniqueEmail(label.toLowerCase()),
      phone,
      firstName: label,
      memberships: [{ tenantId, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: label,
      nodes,
      edges,
      assign: [{ tenantId, isStart: true, roleIds: [role.id] }],
    });
    return { phone, user, role };
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
    broker = t.moduleRef.get(BrokerService);
    service = t.moduleRef.get(ConversationsService);
    media = t.moduleRef.get(TwilioMediaService);

    tenantTkc = await createTenant(t.prisma, { slug: uniqueSlug('tkc') });
    tenantTrf = await createTenant(t.prisma, { slug: uniqueSlug('trf') });
    tenantSms = await createTenant(t.prisma, { slug: uniqueSlug('sms') });
    roleTrfAgent = await createRole(t.prisma, { tenantId: tenantTrf.id, name: 'Agente TRF' });
    roleSmsAgent = await createRole(t.prisma, { tenantId: tenantSms.id, name: 'Agente SMS' });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
    t.email.reset();
  });

  afterEach(async () => {
    // Settings globales (Setting.key es único): limpiar siempre, aunque el test que las usó
    // ya haya hecho su propio cleanup — red de seguridad si un assert corta antes de tiempo.
    await deleteSetting(t.prisma, 'INVGATE_API_URL');
    await deleteSetting(t.prisma, 'INVGATE_API_USER');
    await deleteSetting(t.prisma, 'INVGATE_API_KEY');
    await deleteSetting(t.prisma, 'MEDIA_STORAGE_DIR');
  });

  // ---------------------------------------------------------------------------------------
  // ticket_create (CHAT-N-TKC-01..06)
  // ---------------------------------------------------------------------------------------
  describe('ticket_create (CHAT-N-TKC-*)', () => {
    it('CHAT-N-TKC-01: subject/description explícitos en data crean el ticket y responde "Ticket #… creado"', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-01',
        [
          startNode('s'),
          // `data.text` es el mensaje final, 100% opcional y a cargo de quien arma el flujo
          // (ya no hay un texto fijo forzado) — acá se configura uno con {{lastTicketId}}
          // para poder seguir asertando la respuesta end-to-end.
          ticketCreateNode('tc', {
            subject: 'Falla de VPN',
            description: 'No puedo conectarme a la VPN corporativa',
            text: 'Ticket #{{lastTicketId}} creado. Un agente te contactará pronto.',
          }),
          endNode('e'),
        ],
        [edge('s', 'tc', 'known'), edge('tc', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id);
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(ticket).not.toBeNull();
      expect(ticket!.subject).toBe('Falla de VPN');
      expect(ticket!.description).toBe('No puedo conectarme a la VPN corporativa');
      expect(ticket!.priority).toBe('medium'); // data.priority no seteado → default del nodo
      expect(ticket!.userId).toBe(user.id);
      expect(ticket!.tenantId).toBe(tenantTkc.id);
      expect(res.body.reply).toContain(`Ticket #${ticket!.id} creado. Un agente te contactará pronto.`);
    });

    it('CHAT-N-TKC-01b: sin data.text configurado, no manda ningún mensaje final (antes era un texto fijo forzado)', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-01B',
        [startNode('s'), ticketCreateNode('tc', { subject: 'Sin mensaje final' }), messageNode('m', 'Listo.'), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'm'), edge('m', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id);
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(ticket).not.toBeNull();
      // Sin data.text: el nodo no aporta responseText — la respuesta es solo lo que viene
      // después en el flujo (el saludo de conocido + el mensaje siguiente), sin ningún
      // "Ticket #… creado" de por medio.
      expect(res.body.reply).not.toContain('creado');
      expect(res.body.reply).toContain('Listo.');
    });

    it('CHAT-N-TKC-02: sin data.subject, usa los primeros 100 caracteres del mensaje (la description NO se trunca)', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-02',
        [startNode('s'), ticketCreateNode('tc', {}), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'e')],
      );

      const longBody =
        'Hola, tengo un problema con el sistema de facturación de la sucursal norte. El problema ' +
        'empezó esta mañana y los clientes siguen esperando en el mostrador.';
      expect(longBody.length).toBeGreaterThan(100);

      const res = await simulate(phone, tenantTkc.id, longBody);
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(ticket!.subject).toBe(longBody.substring(0, 100));
      expect(ticket!.description).toBe(longBody);
    });

    it('CHAT-N-TKC-03a: sin data.description, usa flowState.description por sobre el mensaje', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-03-desc',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'description', value: 'Descripción cargada por un nodo anterior' }),
          ticketCreateNode('tc', {}),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'tc'), edge('tc', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id, 'necesito soporte técnico');
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(ticket!.description).toBe('Descripción cargada por un nodo anterior');
    });

    it('CHAT-N-TKC-03b: data.priority explícito prevalece sobre el default "medium"', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-03-prio',
        [startNode('s'), ticketCreateNode('tc', { priority: 'high' }), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id, 'necesito soporte técnico');
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(ticket!.priority).toBe('high');
    });

    it('CHAT-N-TKC-04: si prisma.ticket.create falla (BD caída), la excepción se propaga y corta la charla', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-04',
        [startNode('s'), ticketCreateNode('tc', {}), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'e')],
      );

      // Se llama a `handleMessage` (privado) directo en vez de pasar por /conversations/simulate:
      // cuando el handler que recibe `BrokerService.subscribe()` tira una excepción no capturada,
      // `setupConsumer` la loguea y hace `nack` (ver broker.service.ts) — nunca publica la
      // respuesta RPC. `broker.request()` colgaría hasta su propio timeout de 300s
      // (SIMULATE_TIMEOUT_MS). Llamar directo al método real (nada mockeado del motor) deja ver
      // la excepción de inmediato, sin ese cuelgue artificial.
      const createSpy = jest
        .spyOn(t.prisma.ticket, 'create')
        .mockRejectedValueOnce(new Error('DB caída (simulada para el test)'));

      try {
        await expect(
          (service as unknown as { handleMessage: (msg: unknown) => Promise<string> }).handleMessage({
            pattern: 'message.received',
            data: { from: phone, body: 'necesito soporte técnico' },
            tenantId: tenantTkc.id,
            timestamp: new Date().toISOString(),
          }),
        ).rejects.toThrow('DB caída (simulada para el test)');
      } finally {
        createSpy.mockRestore();
      }

      // Filtrado por `userId` (no por `description`): otro caso de este mismo archivo
      // (TKC-03b) comparte tenant y el mismo texto de body/description ("necesito soporte
      // técnico"), así que filtrar por texto contaría también SU ticket.
      const count = await t.prisma.ticket.count({ where: { tenantId: tenantTkc.id, userId: user.id } });
      expect(count).toBe(0); // la excepción cortó antes de que el ticket quedara creado
    });

    it(
      'CHAT-N-TKC-05 / CHAT-N-TKQ-04: category/priority/type por NOMBRE sincronizan con InvGate; ticket_query trae y traduce el estado real',
      async () => {
        const { phone, user } = await setupKnownFlow(
          tenantTkc.id,
          'TKC-05-TKQ-04A',
          [
            startNode('s'),
            ticketCreateNode('tc', { subject: 'Problema de red', category: 'Redes', priority: 'Alta', ticketType: 'Incidente' }),
            ticketQueryNode('tq', {}),
            endNode('e'),
          ],
          [edge('s', 'tc', 'known'), edge('tc', 'tq'), edge('tq', 'e')],
        );

        await setSetting(t.prisma, 'INVGATE_API_URL', 'https://invgate-fake.test');
        await setSetting(t.prisma, 'INVGATE_API_USER', 'chatbot_test');
        await setSetting(t.prisma, 'INVGATE_API_KEY', 'fake-api-key');

        const mock = makeInvgateMock({
          categories: [{ id: 501, name: 'Redes' }],
          priorities: [{ id: 2, name: 'Alta' }],
          types: [{ id: 7, name: 'Incidente' }],
          statuses: [
            { id: 1, name: 'Abierto' },
            { id: 2, name: 'Resuelto' },
          ],
          creatorIdByUsername: { chatbot_test: 42 },
          // InvGate guarda el teléfono REAL (sin el 9 de móvil de WhatsApp): el código
          // consulta `users.by` con `stripArgentinaMobileNine(phone)`, así que el mock —que
          // representa la BD de InvGate— tiene que indexar por ese mismo número normalizado.
          customerIdByPhone: { [stripArgentinaMobileNine(phone)]: 777 },
          initialStatusId: 1,
        });
        const fetchMock = installFetchMock(mock.router);

        try {
          const res = await simulate(phone, tenantTkc.id, 'tengo un problema de red');
          expect(res.status).toBe(201);
          expect(res.body.reply).toContain('creado. Un agente te contactará pronto.');
          expect(res.body.reply).toContain('Estado: Abierto');

          const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
          expect(ticket!.invgateId).not.toBeNull();
          expect(mock.incidents.has(Number(ticket!.invgateId))).toBe(true);
          expect(ticket!.status).toBe('Abierto'); // refreshInvgateStatus actualiza el estado local
        } finally {
          fetchMock.restore();
        }
      },
      20000,
    );

    it('CHAT-N-TKC-06: si el teléfono no matchea ningún customer_id de InvGate, el ticket local se crea igual y el sync se saltea', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKC-06',
        [startNode('s'), ticketCreateNode('tc', { subject: 'Problema sin cliente en InvGate' }), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'e')],
      );

      await setSetting(t.prisma, 'INVGATE_API_URL', 'https://invgate-fake.test');
      await setSetting(t.prisma, 'INVGATE_API_USER', 'chatbot_test');
      await setSetting(t.prisma, 'INVGATE_API_KEY', 'fake-api-key');

      // customerIdByPhone vacío a propósito: ningún usuario de InvGate matchea este teléfono.
      const mock = makeInvgateMock({ creatorIdByUsername: { chatbot_test: 42 } });
      const fetchMock = installFetchMock(mock.router);

      try {
        const res = await simulate(phone, tenantTkc.id, 'tengo un problema');
        expect(res.status).toBe(201);

        const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
        expect(ticket).not.toBeNull();
        expect(ticket!.invgateId).toBeNull(); // sync salteado, best-effort
        expect(res.body.reply).toContain(`Ticket #${ticket!.id} creado. Un agente te contactará pronto.`); // la charla sigue normal
      } finally {
        fetchMock.restore();
      }
    });

    it(
      'CHAT-N-TKC-07a: las imágenes se acumulan en flowState.pendingAttachments al llegar (placeholder de mensaje solo-imagen) y ticket_create las consume: las lee, las borra del disco y viajan a InvGate',
      async () => {
        // Se llama a `handleMessage` (privado) directo, no vía /conversations/simulate: es la
        // única forma de inyectar `attachments` en el mensaje entrante (los produce el webhook de
        // Twilio al descargar la media — frontera externa; `simulateIncomingMessage` no los
        // reenvía). Mismo recurso que CHAT-N-TKC-04: el motor NO se mockea, solo se lo invoca
        // con la forma de mensaje que el canal real ya arma.
        const { phone, user } = await setupKnownFlow(
          tenantTkc.id,
          'TKC-07A',
          [
            startNode('s'),
            // `input` deja el flujo esperando: el primer mensaje solo-imagen NO llega todavía
            // a `ticket_create`, así se ve la acumulación antes de la consumición.
            inputNode('ip', { text: 'Mandá las imágenes y contame qué pasa', variableName: 'detalle' }),
            // category/priority/type por nombre: sin ellos resolubles, `createTicketForChat`
            // devuelve null antes de crear el incidente (y los adjuntos no viajarían).
            ticketCreateNode('tc', { subject: 'Falla con adjuntos', category: 'Redes', priority: 'Alta', ticketType: 'Incidente' }),
            endNode('e'),
          ],
          [edge('s', 'ip', 'known'), edge('ip', 'tc'), edge('tc', 'e')],
        );

        await setSetting(t.prisma, 'INVGATE_API_URL', 'https://invgate-fake.test');
        await setSetting(t.prisma, 'INVGATE_API_USER', 'chatbot_test');
        await setSetting(t.prisma, 'INVGATE_API_KEY', 'fake-api-key');

        const invg = makeInvgateMock({
          categories: [{ id: 501, name: 'Redes' }],
          priorities: [{ id: 2, name: 'Alta' }],
          types: [{ id: 7, name: 'Incidente' }],
          statuses: [{ id: 1, name: 'Abierto' }],
          creatorIdByUsername: { chatbot_test: 42 },
          // InvGate guarda el teléfono REAL (sin el 9 de móvil de WhatsApp): el código
          // consulta `users.by` con `stripArgentinaMobileNine(phone)`, así que el mock —que
          // representa la BD de InvGate— tiene que indexar por ese mismo número normalizado.
          customerIdByPhone: { [stripArgentinaMobileNine(phone)]: 777 },
          initialStatusId: 1,
        });
        // Router envolvente: sobre el POST de alta cuenta los `attachments[]` del multipart
        // (`InvgateService.postMultipart` arma un FormData real, ver invgate.service.ts) para
        // confirmar que los adjuntos efectivamente viajaron.
        let postedAttachmentCount = -1;
        const router: FetchRouter = (url, init) => {
          const u = new URL(url);
          const path = u.pathname.replace(/^\/api\/v1\//, '');
          if ((init?.method || 'GET').toUpperCase() === 'POST' && path === 'incident') {
            const body = init?.body;
            postedAttachmentCount = body instanceof FormData ? body.getAll('attachments[]').length : 0;
          }
          return invg.router(url, init);
        };
        const fetchMock = installFetchMock(router);

        // Los archivos que el webhook ya habría descargado y guardado en disco (StoredAttachment).
        const mediaDir = await mkdtemp(join(tmpdir(), 'pci-tkc07a-'));
        const att1 = { path: join(mediaDir, 'foto-1.png'), filename: 'foto-1.png', contentType: 'image/png' };
        const att2 = { path: join(mediaDir, 'foto-2.png'), filename: 'foto-2.png', contentType: 'image/png' };
        await writeFile(att1.path, Buffer.from('bytes-de-foto-1'));
        await writeFile(att2.path, Buffer.from('bytes-de-foto-2'));

        const callHandle = (attachments: unknown[]) =>
          (service as unknown as { handleMessage: (msg: unknown) => Promise<string> }).handleMessage({
            pattern: 'message.received',
            data: { from: phone, body: '', attachments }, // body vacío = mensaje solo-imagen
            tenantId: tenantTkc.id,
            timestamp: new Date().toISOString(),
          });

        try {
          // --- Turno 1: primera imagen en una charla nueva. Se acumula, el flujo queda parado
          // en el nodo `input` (todavía no toca ticket_create). ---
          await callHandle([att1]);

          const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
          const state1 = conv!.flowState as Record<string, any>;
          expect(state1.pendingAttachments).toHaveLength(1); // acumulado, NO consumido

          const msg1 = await t.prisma.message.findFirst({
            where: { conversationId: conv!.id, senderType: 'user' },
            orderBy: { createdAt: 'desc' },
          });
          expect(msg1!.content).toBe('[1 imagen(es) adjunta(s)]'); // placeholder del mensaje solo-imagen

          expect(await t.prisma.ticket.count({ where: { userId: user.id, tenantId: tenantTkc.id } })).toBe(0);
          await expect(stat(att1.path)).resolves.toBeDefined(); // sin consumir: sigue en disco

          // --- Turno 2: segunda imagen. Se acumula ([att1, att2]) y el `input` avanza a
          // ticket_create, que consume ambos adjuntos. ---
          const reply = await callHandle([att2]);
          expect(reply).toContain('creado. Un agente te contactará pronto.');

          const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
          expect(ticket).not.toBeNull();
          expect(ticket!.invgateId).not.toBeNull(); // sincronizó a InvGate
          expect(postedAttachmentCount).toBe(2); // los 2 adjuntos viajaron en el multipart

          const convAfter = await t.prisma.conversation.findUnique({ where: { id: conv!.id } });
          // El flujo llegó al nodo `end`, y `closeConversation` resetea TODO el flowState a null
          // (no solo vacía pendingAttachments) — ver conversations.service.ts. Que los adjuntos se
          // consumieron de verdad lo prueban `postedAttachmentCount === 2` (viajaron a InvGate) y el
          // borrado de disco de abajo; acá el estado limpio confirma que no quedaron reservados.
          expect(convAfter!.flowState).toBeNull();
          await expect(stat(att1.path)).rejects.toThrow(); // loadAttachments los borró del disco
          await expect(stat(att2.path)).rejects.toThrow();
        } finally {
          fetchMock.restore();
          await rm(mediaDir, { recursive: true, force: true });
        }
      },
      20000,
    );

    it('CHAT-N-TKC-07b: sin ticket que los consuma, el cron de retención (cleanupExpired) borra los adjuntos de más de 10 min y conserva los recientes', async () => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'pci-tkc07b-'));
      await setSetting(t.prisma, 'MEDIA_STORAGE_DIR', mediaDir); // el cron barre este directorio
      try {
        const stale = join(mediaDir, 'sin-usar-vieja.png');
        const fresh = join(mediaDir, 'sin-usar-nueva.png');
        await writeFile(stale, Buffer.from('vieja'));
        await writeFile(fresh, Buffer.from('nueva'));
        const old = new Date(Date.now() - 11 * 60 * 1000); // 11 min: pasó la retención de 10
        await utimes(stale, old, old);

        await media.cleanupExpired();

        await expect(stat(stale)).rejects.toThrow(); // borrada: nadie la consumió y venció
        await expect(stat(fresh)).resolves.toBeDefined(); // reciente: se conserva
      } finally {
        await deleteSetting(t.prisma, 'MEDIA_STORAGE_DIR');
        await rm(mediaDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // ticket_query (CHAT-N-TKQ-01..04)
  // ---------------------------------------------------------------------------------------
  describe('ticket_query (CHAT-N-TKQ-*)', () => {
    it('CHAT-N-TKQ-01: con lastTicketId del propio tenant devuelve asunto y estado', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTkc.id,
        'TKQ-01',
        [startNode('s'), ticketCreateNode('tc', { subject: 'Consulta simple' }), ticketQueryNode('tq', {}), endNode('e')],
        [edge('s', 'tc', 'known'), edge('tc', 'tq'), edge('tq', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id, 'necesito ayuda');
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
      expect(res.body.reply).toContain(`Ticket #${ticket!.id}: Consulta simple - Estado: open`);
    });

    it('CHAT-N-TKQ-02: sin ticket disponible responde "No encontré el ticket solicitado."', async () => {
      const { phone } = await setupKnownFlow(
        tenantTkc.id,
        'TKQ-02',
        [startNode('s'), ticketQueryNode('tq', {}), endNode('e')],
        [edge('s', 'tq', 'known'), edge('tq', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id, 'quiero ver mi ticket');
      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('No encontré el ticket solicitado.');
    });

    it('CHAT-N-TKQ-03: una variable que apunta a un ticket de OTRO tenant no lo devuelve (SEC-08 cerrado)', async () => {
      const tenantOther = await createTenant(t.prisma, { slug: uniqueSlug('tkc-other') });
      const owner = await createUser(t.prisma, { email: uniqueEmail('owner-other'), phone: uniquePhone(), firstName: 'Owner' });
      const foreignTicket = await t.prisma.ticket.create({
        data: {
          userId: owner.id,
          tenantId: tenantOther.id,
          subject: 'Ticket confidencial de otra empresa',
          description: 'No debería verse desde otro tenant',
          priority: 'medium',
        },
      });

      const { phone } = await setupKnownFlow(
        tenantTkc.id,
        'TKQ-03',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'ticketRef', value: foreignTicket.id }),
          ticketQueryNode('tq', { ticketIdVariable: 'ticketRef' }),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'tq'), edge('tq', 'e')],
      );

      const res = await simulate(phone, tenantTkc.id, 'quiero ver el ticket');

      // Comportamiento SEGURO ya implementado: `ticket_query` usa
      // `ticket.findFirst({ where: { tenantId, OR: [{ id }, { invgateId }] } })`, scopeado por
      // empresa, así que el ticket de la otra empresa no aparece y responde "no encontrado".
      // Cierra SEC-08 (antes era `ticket.findUnique({ where: { id } })` sin filtro de tenant).
      expect(res.body.reply).toContain('No encontré el ticket solicitado.');
    });

    it('CHAT-N-TKQ-04b: si InvGate no responde al consultar el ticket, cae al estado local sin romper la charla', async () => {
      const owner = await createUser(t.prisma, { email: uniqueEmail('tkq04b'), phone: uniquePhone(), firstName: 'Owner' });
      const ticket = await t.prisma.ticket.create({
        data: {
          userId: owner.id,
          tenantId: tenantTkc.id,
          subject: 'Ticket ya sincronizado con InvGate',
          description: 'Consulta previa',
          priority: 'medium',
          invgateId: '4242',
          status: 'open',
        },
      });

      const { phone } = await setupKnownFlow(
        tenantTkc.id,
        'TKQ-04B',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'ticketRef', value: ticket.id }),
          ticketQueryNode('tq', { ticketIdVariable: 'ticketRef' }),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'tq'), edge('tq', 'e')],
      );

      await setSetting(t.prisma, 'INVGATE_API_URL', 'https://invgate-fake.test');
      await setSetting(t.prisma, 'INVGATE_API_USER', 'chatbot_test');
      await setSetting(t.prisma, 'INVGATE_API_KEY', 'fake-api-key');

      const mock = makeInvgateMock({ failGetIncident: true });
      const fetchMock = installFetchMock(mock.router);

      try {
        const res = await simulate(phone, tenantTkc.id, 'quiero el estado de mi ticket');
        expect(res.status).toBe(201);
        // El display prefiere `invgateId ?? id` (coherente con CHAT-N-TKQ-05a/05b): el ticket
        // ya tiene invgateId '4242', así que se muestra #4242, no el cuid local.
        expect(res.body.reply).toContain(`Ticket #${ticket.invgateId}: Ticket ya sincronizado con InvGate - Estado: open`);

        const refreshed = await t.prisma.ticket.findUnique({ where: { id: ticket.id } });
        expect(refreshed!.status).toBe('open'); // sin cambios: InvGate no respondió, se mantuvo el local
      } finally {
        fetchMock.restore();
      }
    });

    it(
      'CHAT-N-TKQ-05a: al sincronizar, lastTicketId queda en el número real de InvGate; ticket_query lo resuelve por invgateId y muestra #invgateId (no el cuid)',
      async () => {
        const { phone, user } = await setupKnownFlow(
          tenantTkc.id,
          'TKQ-05A',
          [
            startNode('s'),
            ticketCreateNode('tc', { subject: 'Sincroniza con InvGate', category: 'Redes', priority: 'Alta', ticketType: 'Incidente' }),
            ticketQueryNode('tq', {}), // sin ticketIdVariable → usa flowState.lastTicketId (= número de InvGate)
            endNode('e'),
          ],
          [edge('s', 'tc', 'known'), edge('tc', 'tq'), edge('tq', 'e')],
        );

        await setSetting(t.prisma, 'INVGATE_API_URL', 'https://invgate-fake.test');
        await setSetting(t.prisma, 'INVGATE_API_USER', 'chatbot_test');
        await setSetting(t.prisma, 'INVGATE_API_KEY', 'fake-api-key');

        const mock = makeInvgateMock({
          categories: [{ id: 501, name: 'Redes' }],
          priorities: [{ id: 2, name: 'Alta' }],
          types: [{ id: 7, name: 'Incidente' }],
          statuses: [{ id: 1, name: 'Abierto' }],
          creatorIdByUsername: { chatbot_test: 42 },
          // InvGate guarda el teléfono REAL (sin el 9 de móvil de WhatsApp): el código
          // consulta `users.by` con `stripArgentinaMobileNine(phone)`, así que el mock —que
          // representa la BD de InvGate— tiene que indexar por ese mismo número normalizado.
          customerIdByPhone: { [stripArgentinaMobileNine(phone)]: 777 },
          initialStatusId: 1,
        });
        const fetchMock = installFetchMock(mock.router);

        try {
          const res = await simulate(phone, tenantTkc.id, 'necesito soporte');
          expect(res.status).toBe(201);

          const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTkc.id } });
          expect(ticket!.invgateId).not.toBeNull();
          expect(ticket!.invgateId).not.toBe(ticket!.id); // el número de InvGate no es el cuid local

          // ticket_create mostró el número de InvGate y dejó lastTicketId en ese número; ticket_query
          // lo tomó, resolvió el ticket por la rama `invgateId` del OR y volvió a mostrar #invgateId.
          expect(res.body.reply).toContain(`Ticket #${ticket!.invgateId} creado`);
          expect(res.body.reply).toContain(`Ticket #${ticket!.invgateId}: Sincroniza con InvGate - Estado: Abierto`);
          expect(res.body.reply).not.toContain(ticket!.id); // el cuid interno nunca se le muestra al usuario
        } finally {
          fetchMock.restore();
        }
      },
      20000,
    );

    it('CHAT-N-TKQ-05b: ticket_query también acepta el cuid local (rama OR {id}) y sigue mostrando #invgateId', async () => {
      const owner = await createUser(t.prisma, { email: uniqueEmail('tkq05b'), phone: uniquePhone(), firstName: 'Owner' });
      const ticket = await t.prisma.ticket.create({
        data: {
          userId: owner.id,
          tenantId: tenantTkc.id,
          subject: 'Buscado por cuid',
          description: 'Ya sincronizado',
          priority: 'medium',
          invgateId: '7777',
          status: 'open',
        },
      });

      const { phone } = await setupKnownFlow(
        tenantTkc.id,
        'TKQ-05B',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'ticketRef', value: ticket.id }), // el cuid, NO el invgateId
          ticketQueryNode('tq', { ticketIdVariable: 'ticketRef' }),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'tq'), edge('tq', 'e')],
      );

      // Sin InvGate configurado: refreshInvgateStatus corta al toque y devuelve el estado local.
      const res = await simulate(phone, tenantTkc.id, 'quiero ver el ticket');
      expect(res.status).toBe(201);

      // Resuelto por el cuid (rama OR {id}), pero el display prefiere `invgateId ?? id`.
      expect(res.body.reply).toContain('Ticket #7777: Buscado por cuid - Estado: open');
      expect(res.body.reply).not.toContain(ticket.id); // buscó por el cuid, pero no lo muestra
    });
  });

  // ---------------------------------------------------------------------------------------
  // transfer_agent (CHAT-N-TRF-01..07)
  // ---------------------------------------------------------------------------------------
  describe('transfer_agent (CHAT-N-TRF-*)', () => {
    it('CHAT-N-TRF-01: methods incluye "ticket" y hay assignee → crea el ticket asignado (round robin) y guarda lastTicketId', async () => {
      const agent = await createUser(t.prisma, {
        email: uniqueEmail('trf01-agent'),
        phone: uniquePhone(),
        firstName: 'Agente Uno',
        memberships: [{ tenantId: tenantTrf.id, roleId: roleTrfAgent.id }],
      });
      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-01',
        [startNode('s'), transferAgentNode('ta', { methods: ['ticket'], assignees: [agent.id] }), endNode('e')],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'necesito hablar con un humano');
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTrf.id } });
      expect(ticket).not.toBeNull();
      expect(ticket!.assignedToId).toBe(agent.id);
      expect(ticket!.subject).toBe('necesito hablar con un humano'); // sin flowState.subject, usa el body (recortado a 100)
      expect(ticket!.priority).toBe('medium');
    });

    it('CHAT-N-TRF-02: methods incluye "email" → notifica a assignee + watchers + collaborators, deduplicados', async () => {
      const membership = [{ tenantId: tenantTrf.id, roleId: roleTrfAgent.id }];
      const agent = await createUser(t.prisma, { email: uniqueEmail('trf02-agent'), phone: uniquePhone(), firstName: 'Agente', memberships: membership });
      const watcher = await createUser(t.prisma, { email: uniqueEmail('trf02-watcher'), phone: uniquePhone(), firstName: 'Watcher', memberships: membership });
      const collab = await createUser(t.prisma, { email: uniqueEmail('trf02-collab'), phone: uniquePhone(), firstName: 'Colaborador', memberships: membership });

      const { phone } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-02',
        [
          startNode('s'),
          transferAgentNode('ta', {
            methods: ['email'],
            assignees: [agent.id],
            watchers: [agent.id, watcher.id], // agent.id repetido a propósito: prueba el dedup
            collaborators: [watcher.id, collab.id], // watcher.id repetido también
          }),
          endNode('e'),
        ],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'necesito hablar con un humano');
      expect(res.status).toBe(201);

      expect(t.email.sent).toHaveLength(3); // agent + watcher + collab, sin duplicados
      const recipients = t.email.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([agent.email, collab.email, watcher.email].sort());
      expect(t.email.lastTo(agent.email)!.text).toContain('fue transferido a soporte humano');
      expect(t.email.lastTo(agent.email)!.text).not.toContain('Ticket:'); // methods no incluye 'ticket': no hay lastTicketId
    });

    it('CHAT-N-TRF-03: methods incluye "ticket" pero sin assignees → no crea ticket', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-03',
        [startNode('s'), transferAgentNode('ta', { methods: ['ticket'], assignees: [] }), endNode('e')],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const before = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, userId: user.id } });
      const res = await simulate(phone, tenantTrf.id, 'necesito hablar con un humano');
      expect(res.status).toBe(201);
      const after = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, userId: user.id } });
      expect(after).toBe(before); // sin assignees, `assignee` da null → el bloque 'ticket' no corre
    });

    it(
      'CHAT-N-TRF-04: el round robin de assignees es GLOBAL por nodo, no por conversación',
      async () => {
        const role = await createRole(t.prisma, { tenantId: tenantTrf.id, name: 'TRF-04' });
        const agentA = await createUser(t.prisma, {
          email: uniqueEmail('trf04-a'),
          phone: uniquePhone(),
          firstName: 'A',
          memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
        });
        const agentB = await createUser(t.prisma, {
          email: uniqueEmail('trf04-b'),
          phone: uniquePhone(),
          firstName: 'B',
          memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
        });

        await createFlow(t.prisma, {
          name: 'TRF-04',
          nodes: [startNode('s'), transferAgentNode('ta', { methods: ['ticket'], assignees: [agentA.id, agentB.id] }), endNode('e')],
          edges: [edge('s', 'ta', 'known'), edge('ta', 'e')],
          assign: [{ tenantId: tenantTrf.id, isStart: true, roleIds: [role.id] }],
        });

        async function knownUser(label: string) {
          const phone = uniquePhone();
          const user = await createUser(t.prisma, {
            email: uniqueEmail(label),
            phone,
            firstName: label,
            memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
          });
          return { phone, user };
        }

        const x = await knownUser('trf04-x');
        const y = await knownUser('trf04-y');
        const z = await knownUser('trf04-z');

        await simulate(x.phone, tenantTrf.id, 'transferime');
        await simulate(y.phone, tenantTrf.id, 'transferime');
        await simulate(z.phone, tenantTrf.id, 'transferime');

        const ticketX = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: x.user.id } });
        const ticketY = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: y.user.id } });
        const ticketZ = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: z.user.id } });

        expect(ticketX!.assignedToId).toBe(agentA.id); // lastIndex -1 → 0 → A
        expect(ticketY!.assignedToId).toBe(agentB.id); // lastIndex 0 → 1 → B
        expect(ticketZ!.assignedToId).toBe(agentA.id); // lastIndex 1 → 0 (%2) → A de nuevo: da la vuelta
      },
      20000,
    );

    it('CHAT-N-TRF-05: methods incluye "phone" (sin implementar) → no rompe el flujo', async () => {
      const agent = await createUser(t.prisma, {
        email: uniqueEmail('trf05-agent'),
        phone: uniquePhone(),
        firstName: 'Agente',
        memberships: [{ tenantId: tenantTrf.id, roleId: roleTrfAgent.id }],
      });
      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-05',
        [startNode('s'), transferAgentNode('ta', { methods: ['phone'], assignees: [agent.id] }), endNode('e')],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'necesito que me llamen');
      expect(res.status).toBe(201); // no explota

      const ticketCount = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, userId: user.id } });
      expect(ticketCount).toBe(0); // 'phone' no está contemplado en el nodo: no crea ticket
      expect(t.email.sent).toHaveLength(0); // tampoco manda mail
    });

    it('CHAT-N-TRF-06: data.message con {{variables}} se interpola antes de armar el mail y el ticket', async () => {
      const agent = await createUser(t.prisma, {
        email: uniqueEmail('trf06-agent'),
        phone: uniquePhone(),
        firstName: 'Agente',
        memberships: [{ tenantId: tenantTrf.id, roleId: roleTrfAgent.id }],
      });
      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-06',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'urgencia', value: 'alta' }),
          transferAgentNode('ta', { methods: ['ticket', 'email'], assignees: [agent.id], message: 'Urgencia: {{urgencia}}' }),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'ta'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'necesito ayuda urgente');
      expect(res.status).toBe(201);

      const ticket = await t.prisma.ticket.findFirst({ where: { userId: user.id, tenantId: tenantTrf.id } });
      expect(ticket!.description).toContain('Urgencia: alta');
      expect(ticket!.description).not.toContain('{{urgencia}}');

      expect(t.email.lastTo(agent.email)!.text).toContain('Nota: Urgencia: alta');
      expect(t.email.lastTo(agent.email)!.text).not.toContain('{{urgencia}}');
    });

    it('CHAT-N-TRF-07: methods incluye "email" pero sin assignee/watchers/collaborators → no manda mail, no rompe, sigue', async () => {
      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-07',
        [startNode('s'), transferAgentNode('ta', { methods: ['email'], assignees: [], watchers: [], collaborators: [] }), endNode('e')],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'hola');
      expect(res.status).toBe(201);
      expect(t.email.sent).toHaveLength(0);

      const ticketCount = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, userId: user.id } });
      expect(ticketCount).toBe(0);
    });

    it(
      'CHAT-N-TRF-08a: un assignee dado de baja sale de la rotación; pickNextAssignee rota solo sobre los activos y el dado de baja nunca recibe',
      async () => {
        const role = await createRole(t.prisma, { tenantId: tenantTrf.id, name: 'TRF-08A' });
        const agentA = await createUser(t.prisma, {
          email: uniqueEmail('trf08a-a'),
          phone: uniquePhone(),
          firstName: 'A',
          memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
        });
        // Dado de baja (soft-delete): sigue listado en `data.assignees` del nodo (la config no se
        // actualiza sola), pero `pickNextAssignee` lo filtra por `deletedAt:null`.
        const agentDown = await createUser(t.prisma, {
          email: uniqueEmail('trf08a-down'),
          phone: uniquePhone(),
          firstName: 'Baja',
          deletedAt: new Date(),
        });
        const agentB = await createUser(t.prisma, {
          email: uniqueEmail('trf08a-b'),
          phone: uniquePhone(),
          firstName: 'B',
          memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
        });
        await createFlow(t.prisma, {
          name: 'TRF-08A',
          nodes: [
            startNode('s'),
            // El dado de baja va EN EL MEDIO a propósito: si no se lo filtrara, le tocaría en la
            // segunda vuelta y correría el orden. Filtrado, la rotación es solo [A, B].
            transferAgentNode('ta', { methods: ['ticket'], assignees: [agentA.id, agentDown.id, agentB.id] }),
            endNode('e'),
          ],
          edges: [edge('s', 'ta', 'known'), edge('ta', 'e')],
          assign: [{ tenantId: tenantTrf.id, isStart: true, roleIds: [role.id] }],
        });

        async function knownUser(label: string) {
          const phone = uniquePhone();
          const user = await createUser(t.prisma, {
            email: uniqueEmail(label),
            phone,
            firstName: label,
            memberships: [{ tenantId: tenantTrf.id, roleId: role.id }],
          });
          return { phone, user };
        }

        const x = await knownUser('trf08a-x');
        const y = await knownUser('trf08a-y');
        const z = await knownUser('trf08a-z');

        await simulate(x.phone, tenantTrf.id, 'transferime');
        await simulate(y.phone, tenantTrf.id, 'transferime');
        await simulate(z.phone, tenantTrf.id, 'transferime');

        const ticketX = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: x.user.id } });
        const ticketY = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: y.user.id } });
        const ticketZ = await t.prisma.ticket.findFirst({ where: { tenantId: tenantTrf.id, userId: z.user.id } });

        // Activos = [A, B]; el dado de baja no cuenta: -1→0→A, 0→1→B, 1→0→A (da la vuelta sobre 2).
        expect(ticketX!.assignedToId).toBe(agentA.id);
        expect(ticketY!.assignedToId).toBe(agentB.id);
        expect(ticketZ!.assignedToId).toBe(agentA.id);

        const downTickets = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, assignedToId: agentDown.id } });
        expect(downTickets).toBe(0); // el dado de baja nunca recibió una asignación
      },
      20000,
    );

    it('CHAT-N-TRF-08b: si NINGÚN assignee queda activo, pickNextAssignee devuelve null: no crea ticket y el flujo sigue sin romper', async () => {
      const down1 = await createUser(t.prisma, {
        email: uniqueEmail('trf08b-1'),
        phone: uniquePhone(),
        firstName: 'Baja 1',
        deletedAt: new Date(),
      });
      const down2 = await createUser(t.prisma, {
        email: uniqueEmail('trf08b-2'),
        phone: uniquePhone(),
        firstName: 'Baja 2',
        deletedAt: new Date(),
      });

      const { phone, user } = await setupKnownFlow(
        tenantTrf.id,
        'TRF-08B',
        [
          startNode('s'),
          transferAgentNode('ta', { methods: ['ticket', 'email'], assignees: [down1.id, down2.id] }),
          endNode('e'),
        ],
        [edge('s', 'ta', 'known'), edge('ta', 'e')],
      );

      const res = await simulate(phone, tenantTrf.id, 'necesito un humano');
      expect(res.status).toBe(201); // no rompe: assignee null se maneja como en TRF-03

      const ticketCount = await t.prisma.ticket.count({ where: { tenantId: tenantTrf.id, userId: user.id } });
      expect(ticketCount).toBe(0); // sin activo → el bloque 'ticket' no corre
      expect(t.email.sent).toHaveLength(0); // assignee null y sin watchers/collaborators → nadie a notificar
    });
  });

  // ---------------------------------------------------------------------------------------
  // sms (CHAT-N-SMS-01..04)
  // ---------------------------------------------------------------------------------------
  describe('sms (CHAT-N-SMS-*)', () => {
    it('CHAT-N-SMS-01: interpola el message y publica en sms.outgoing por cada recipient con teléfono; saltea a los que no tienen', async () => {
      const smsMembership = [{ tenantId: tenantSms.id, roleId: roleSmsAgent.id }];
      const agentWithPhone = await createUser(t.prisma, { email: uniqueEmail('sms01-a'), phone: uniquePhone(), firstName: 'Con teléfono', memberships: smsMembership });
      const agentNoPhone = await createUser(t.prisma, { email: uniqueEmail('sms01-b'), phone: null, firstName: 'Sin teléfono', memberships: smsMembership });

      const { phone } = await setupKnownFlow(
        tenantSms.id,
        'SMS-01',
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'urgencia', value: 'crítica' }),
          smsNode('sm', { recipients: [agentWithPhone.id, agentNoPhone.id], message: 'Alerta: {{urgencia}}' }),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'sm'), edge('sm', 'e')],
      );

      const publishSpy = jest.spyOn(broker, 'publish');
      try {
        const res = await simulate(phone, tenantSms.id, 'hola');
        expect(res.status).toBe(201);

        const smsCalls = publishSpy.mock.calls.filter(([queue]) => queue === 'sms.outgoing');
        expect(smsCalls).toHaveLength(1); // solo el que tiene teléfono cargado
        const [, message] = smsCalls[0] as [string, { pattern: string; data: { to: string; body: string }; tenantId: string }];
        expect(message.data).toEqual({ to: agentWithPhone.phone, body: 'Alerta: crítica' });
        expect(message.pattern).toBe('message.send');
        expect(message.tenantId).toBe(tenantSms.id);
      } finally {
        publishSpy.mockRestore();
      }
    });

    it('CHAT-N-SMS-02a: sin recipients → no publica nada, el flujo sigue', async () => {
      const { phone } = await setupKnownFlow(
        tenantSms.id,
        'SMS-02A',
        [startNode('s'), smsNode('sm', { recipients: [], message: 'Alerta' }), endNode('e')],
        [edge('s', 'sm', 'known'), edge('sm', 'e')],
      );

      const publishSpy = jest.spyOn(broker, 'publish');
      try {
        const res = await simulate(phone, tenantSms.id, 'hola');
        expect(res.status).toBe(201);
        expect(publishSpy.mock.calls.filter(([q]) => q === 'sms.outgoing')).toHaveLength(0);
      } finally {
        publishSpy.mockRestore();
      }
    });

    it('CHAT-N-SMS-02b: sin message → no publica nada, el flujo sigue', async () => {
      const agent = await createUser(t.prisma, {
        email: uniqueEmail('sms02b'),
        phone: uniquePhone(),
        firstName: 'Agente',
        memberships: [{ tenantId: tenantSms.id, roleId: roleSmsAgent.id }],
      });
      const { phone } = await setupKnownFlow(
        tenantSms.id,
        'SMS-02B',
        [startNode('s'), smsNode('sm', { recipients: [agent.id] }), endNode('e')], // sin data.message
        [edge('s', 'sm', 'known'), edge('sm', 'e')],
      );

      const publishSpy = jest.spyOn(broker, 'publish');
      try {
        const res = await simulate(phone, tenantSms.id, 'hola');
        expect(res.status).toBe(201);
        expect(publishSpy.mock.calls.filter(([q]) => q === 'sms.outgoing')).toHaveLength(0);
      } finally {
        publishSpy.mockRestore();
      }
    });

    it(
      'CHAT-N-SMS-03: sin credenciales de Twilio configuradas, el nodo publica igual en sms.outgoing pero el SMS se pierde en silencio',
      async () => {
        // Discrepancia con el plan: dice "SMS_PROVIDER sin configurar → nadie consume
        // sms.outgoing", pero `twilio-sms.service.ts` muestra que el default de SMS_PROVIDER
        // ES 'twilio' — TwilioSmsService SÍ está suscripto por default. El efecto observable es
        // el mismo que describe el plan igual: sin TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/
        // TWILIO_SMS_FROM en /settings, `sendText()` resuelve con un warn y un `return` (nunca
        // llega a llamar `fetch`) — el SMS se pierde en silencio.
        const agent = await createUser(t.prisma, {
          email: uniqueEmail('sms03'),
          phone: uniquePhone(),
          firstName: 'Agente',
          memberships: [{ tenantId: tenantSms.id, roleId: roleSmsAgent.id }],
        });
        const { phone } = await setupKnownFlow(
          tenantSms.id,
          'SMS-03',
          [startNode('s'), smsNode('sm', { recipients: [agent.id], message: 'Aviso de prueba' }), endNode('e')],
          [edge('s', 'sm', 'known'), edge('sm', 'e')],
        );

        const fetchMock = installFetchMock(() => ({ status: 200, body: { sid: 'SM_no_deberia_llamarse' } }));
        const publishSpy = jest.spyOn(broker, 'publish');
        try {
          const res = await simulate(phone, tenantSms.id, 'hola');
          expect(res.status).toBe(201);

          const smsCalls = publishSpy.mock.calls.filter(([q]) => q === 'sms.outgoing');
          expect(smsCalls).toHaveLength(1); // el nodo publicó igual

          await new Promise((r) => setTimeout(r, 500)); // deja que TwilioSmsService (competidor real) procese
          expect(fetchMock.requests).toHaveLength(0); // pero nunca llegó a pegarle a la API de Twilio
        } finally {
          publishSpy.mockRestore();
          fetchMock.restore();
        }
      },
      10000,
    );

    it('CHAT-N-SMS-04: un recipient de OTRA empresa no recibe el SMS (SEC-18, corregido)', async () => {
      const tenantOther = await createTenant(t.prisma, { slug: uniqueSlug('sms-other') });
      const roleOther = await createRole(t.prisma, { tenantId: tenantOther.id, name: 'Agente externo' });
      const foreignPhone = uniquePhone();
      const foreignAgent = await createUser(t.prisma, {
        email: uniqueEmail('sms04-foreign'),
        phone: foreignPhone,
        firstName: 'Externo',
        memberships: [{ tenantId: tenantOther.id, roleId: roleOther.id }],
      });

      const { phone } = await setupKnownFlow(
        tenantSms.id,
        'SMS-04',
        [startNode('s'), smsNode('sm', { recipients: [foreignAgent.id], message: 'Aviso interno' }), endNode('e')],
        [edge('s', 'sm', 'known'), edge('sm', 'e')],
      );

      const publishSpy = jest.spyOn(broker, 'publish');
      try {
        const res = await simulate(phone, tenantSms.id, 'hola');
        expect(res.status).toBe(201);

        const toForeignPhone = publishSpy.mock.calls.filter(
          ([queue, message]) => queue === 'sms.outgoing' && (message as { data?: { to?: string } }).data?.to === foreignPhone,
        );
        // `executeSmsNode` filtra `recipientIds` por `tenantId` (ver conversations.service.ts):
        // un userId de otra empresa no resuelve ningún destinatario, aunque siga listado en
        // `data.recipients` del nodo (un flujo compartido puede traer gente de varias empresas).
        expect(toForeignPhone).toHaveLength(0);
      } finally {
        publishSpy.mockRestore();
      }
    });
  });
});
