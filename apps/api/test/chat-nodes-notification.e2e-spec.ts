/**
 * 2.3 Nodos del motor — `notification` (CHAT-N-NOT-01..07)
 *
 * Mismo patrón que el exemplar (`chat-start.e2e-spec.ts`): `POST /conversations/simulate` →
 * `res.body.reply`, atravesando RabbitMQ de punta a punta. Única frontera mockeada:
 * `LlmService` (`FakeLlmService`), que despacha por el contenido del system prompt para poder
 * distinguir el orquestador del clasificador de cierre de charla.
 *
 * El interactivo (botón / botón de link) se verifica a través del `reply`: `simulate` le
 * agrega el interactivo formateado como texto plano (ver `formatInteractiveAsText`), así que
 * un botón aparece como `1. <título>` y un botón de link como `<etiqueta>: <url>`.
 *
 * Los adjuntos no viajan por `POST /conversations/simulate` (su DTO es `{from, body,
 * tenantId}`), así que el caso de la foto publica en la MISMA cola y con el MISMO handler
 * (`whatsapp.simulate.incoming` → `handleMessage`) usando el `BrokerService` real, agregando
 * el campo `attachments` que en producción agrega el webhook del canal.
 *
 * CHAT-N-NOT-07: el plan lo lista como ❌ (la URL del botón de link no se interpolaría), pero el
 * código ya interpola —ver el comentario dentro del propio test—, así que va como test normal.
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmMessage } from '../src/modules/llm/llm-provider.interface';
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
  notificationNode,
  variableNode,
  endNode,
  edge,
  FlowNode,
  FlowEdge,
} from './support';

const RESPUESTA_LLM = 'Te explico: el trámite no tiene costo.';

describe('2.3 Nodos del motor — notification (CHAT-N-NOT-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let broker: BrokerService;

  let tenantId: string;
  let roleId: string;

  /** Despacha por el system prompt: el orquestador y el clasificador de cierre comparten `chat()`. */
  function dispatch(messages: LlmMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('cerrar o reiniciar la charla completa')) return 'SEGUIR';
    if (sys.includes('Eres un orquestador de soporte técnico')) return RESPUESTA_LLM;
    return 'NINGUNA';
  }

  function simulate(from: string, body = 'hola') {
    return http(t)
      .post('/conversations/simulate')
      .set('Authorization', `Bearer ${t.authToken}`)
      .send({ from, body, tenantId });
  }

  /** Mismo camino que `simulate`, con adjuntos: publica en la cola de simulate y espera la respuesta. */
  async function simulateConFoto(from: string, body = ''): Promise<string> {
    const reply = await broker.request(
      'whatsapp.simulate.incoming',
      {
        pattern: 'message.received',
        data: {
          from,
          body,
          attachments: [
            { path: '/tmp/no-existe.jpg', filename: 'foto.jpg', contentType: 'image/jpeg' },
          ],
        },
        tenantId,
        timestamp: new Date().toISOString(),
      },
      { timeoutMs: 60_000 },
    );
    return (reply.data as { body: string }).body;
  }

  /** Crea un flujo de inicio propio del tenant con el nodo notification bajo prueba. */
  async function armarFlujo(nodes: FlowNode[], edges: FlowEdge[]) {
    await t.prisma.tenantFlow.deleteMany({ where: { tenantId } });
    await createFlow(t.prisma, {
      name: `F-NOT-${uniqueSlug('x')}`,
      nodes,
      edges,
      assign: [{ tenantId, isStart: true, roleIds: [roleId] }],
    });
  }

  /** Persona nueva por test: cada una arranca su propia conversación. */
  async function nuevaPersona(): Promise<string> {
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('not'),
      phone,
      firstName: 'Nadia',
      memberships: [{ tenantId, roleId }],
    });
    return phone;
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });
    broker = t.moduleRef.get(BrokerService);

    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('notif') });
    tenantId = tenant.id;
    const role = await createRole(t.prisma, { tenantId, name: 'Soporte notificación' });
    roleId = role.id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
    llm.setResponder(dispatch);
  });

  // --- CHAT-N-NOT-01 / 02 / 03 ---

  it('CHAT-N-NOT-01: la primera llegada muestra el texto con el botón y espera', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', { text: 'Cargá tus fotos y confirmá.' }),
        messageNode('m', 'Seguiste de largo'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();

    const res = await simulate(phone);

    expect(res.body.reply).toContain('Cargá tus fotos y confirmá.');
    // Etiqueta por defecto del botón, que `simulate` agrega como "1. Continuar".
    expect(res.body.reply).toContain('1. Continuar');
    // Frenó: no encadenó al nodo siguiente en el mismo turno.
    expect(res.body.reply).not.toContain('Seguiste de largo');
  });

  it('CHAT-N-NOT-01: usa data.buttonLabel cuando está configurado', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', { text: 'Cuando termines, avisá.', buttonLabel: 'Listo' }),
        messageNode('m', 'Seguiste de largo'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();

    const res = await simulate(phone);

    expect(res.body.reply).toContain('1. Listo');
    expect(res.body.reply).not.toContain('Continuar');
  });

  it('CHAT-N-NOT-02: tocar el botón (o responder "1") avanza por la única salida', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', { text: 'Confirmá para seguir.', buttonLabel: 'Listo' }),
        messageNode('m', 'Avanzaste al siguiente nodo'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );

    const conEtiqueta = await nuevaPersona();
    await simulate(conEtiqueta);
    const res1 = await simulate(conEtiqueta, 'Listo');
    expect(res1.body.reply).toContain('Avanzaste al siguiente nodo');

    const conNumero = await nuevaPersona();
    await simulate(conNumero);
    const res2 = await simulate(conNumero, '1');
    expect(res2.body.reply).toContain('Avanzaste al siguiente nodo');
  });

  it('CHAT-N-NOT-03: responder otra cosa deriva al LLM y sigue esperando el botón', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', { text: 'Confirmá para seguir.', buttonLabel: 'Listo' }),
        messageNode('m', 'Avanzaste al siguiente nodo'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();
    await simulate(phone);

    const pregunta = await simulate(phone, '¿esto tiene algún costo?');
    expect(pregunta.body.reply).toContain(RESPUESTA_LLM);
    expect(pregunta.body.reply).not.toContain('Avanzaste al siguiente nodo');

    // Sigue en fallback: una segunda pregunta la atiende el modelo de nuevo.
    const otra = await simulate(phone, '¿y cuánto demora?');
    expect(otra.body.reply).toContain(RESPUESTA_LLM);

    // Y recién al tocar el botón sale del fallback y avanza.
    const boton = await simulate(phone, 'Listo');
    expect(boton.body.reply).toContain('Avanzaste al siguiente nodo');
  });

  // --- CHAT-N-NOT-04: "Espera una foto" ---

  it('CHAT-N-NOT-04: con expectsPhoto prendido, mandar una imagen avanza igual que el botón', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', {
          text: 'Agregue sus fotos.',
          buttonLabel: 'Sin foto',
          expectsPhoto: true,
        }),
        messageNode('m', 'Recibimos tus fotos'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();
    await simulate(phone);

    const conFoto = await simulateConFoto(phone);

    expect(conFoto).toContain('Recibimos tus fotos');
  });

  it('CHAT-N-NOT-04: con expectsPhoto prendido, la imagen también saca del fallback LLM', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', {
          text: 'Agregue sus fotos.',
          buttonLabel: 'Sin foto',
          expectsPhoto: true,
        }),
        messageNode('m', 'Recibimos tus fotos'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();
    await simulate(phone);
    const pregunta = await simulate(phone, '¿qué fotos necesitan?');
    expect(pregunta.body.reply).toContain(RESPUESTA_LLM);

    const conFoto = await simulateConFoto(phone);

    expect(conFoto).toContain('Recibimos tus fotos');
  });

  it('CHAT-N-NOT-04: con expectsPhoto apagado, la imagen cae al LLM como cualquier otro mensaje', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', { text: 'Confirmá para seguir.', buttonLabel: 'Listo' }),
        messageNode('m', 'Avanzaste al siguiente nodo'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();
    await simulate(phone);

    const conFoto = await simulateConFoto(phone);

    expect(conFoto).toContain(RESPUESTA_LLM);
    expect(conFoto).not.toContain('Avanzaste al siguiente nodo');
  });

  // --- CHAT-N-NOT-05 / 06: modo link ---

  it('CHAT-N-NOT-05: en modo link manda el botón con la URL y frena, sin encadenar el nodo siguiente', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', {
          text: 'Mirá el instructivo.',
          buttonMode: 'link',
          buttonLabel: 'Abrir guía',
          buttonUrl: 'https://ayuda.test/guia',
        }),
        messageNode('m', 'Nodo posterior al link'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();

    const primero = await simulate(phone);
    expect(primero.body.reply).toContain('Mirá el instructivo.');
    // Botón de tipo CTA: `simulate` lo formatea como "<etiqueta>: <url>".
    expect(primero.body.reply).toContain('Abrir guía: https://ayuda.test/guia');
    // Sin el freno, el nodo siguiente pisaría el interactivo en el mismo turno.
    expect(primero.body.reply).not.toContain('Nodo posterior al link');

    // El próximo mensaje, sea cual sea, avanza.
    const segundo = await simulate(phone, 'ya lo vi');
    expect(segundo.body.reply).toContain('Nodo posterior al link');
  });

  it('CHAT-N-NOT-06: en modo link sin buttonUrl se degrada a texto plano y sigue de largo', async () => {
    await armarFlujo(
      [
        startNode('s'),
        notificationNode('n', {
          text: 'Te dejamos la novedad.',
          buttonMode: 'link',
          buttonLabel: 'Abrir guía',
        }),
        messageNode('m', 'Nodo posterior al link'),
        endNode('e'),
      ],
      [edge('s', 'n', 'known'), edge('n', 'm'), edge('m', 'e')],
    );
    const phone = await nuevaPersona();

    const res = await simulate(phone);

    expect(res.body.reply).toContain('Te dejamos la novedad.');
    expect(res.body.reply).not.toContain('Abrir guía:');
    // No frena: el mismo turno encadena el nodo siguiente.
    expect(res.body.reply).toContain('Nodo posterior al link');
  });

  // --- CHAT-N-NOT-07 ---

  it(
    'CHAT-N-NOT-07: la buttonUrl del modo link SÍ interpola las variables del flujo',
    async () => {
      await armarFlujo(
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'sede', value: 'central' }),
          notificationNode('n', {
            text: 'Consultá el estado de tu sede.',
            buttonMode: 'link',
            buttonLabel: 'Ver estado',
            buttonUrl: 'https://ayuda.test/sede/{{sede}}',
          }),
          messageNode('m', 'Nodo posterior al link'),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'n'), edge('n', 'm'), edge('m', 'e')],
      );
      const phone = await nuevaPersona();

      const res = await simulate(phone);

      // ⚠️ El plan describe este caso como ❌ ("la URL no se interpola, las llaves llegan
      // crudas"), pero el código ya no se comporta así: `executeFlow` pasa TODO interactivo que
      // devuelve un nodo por `interpolateInteractive`, que en la rama `cta_url` interpola `url`
      // además de `body` y `buttonText` (conversations.service.ts, el `interactive =
      // this.interpolateInteractive(...)` del loop y el `case 'cta_url'`). El nodo
      // `notification` no interpola la URL en su propio `case`, pero el motor sí lo hace un
      // nivel más arriba. Por eso este test verifica el comportamiento REAL y no va como falla
      // esperada. El riesgo del 21656 por Twilio queda acotado a una variable que no exista en
      // el estado, donde el placeholder sí sobrevive.
      expect(res.body.reply).toContain('https://ayuda.test/sede/central');
      expect(res.body.reply).not.toContain('{{sede}}');
    },
  );
});
