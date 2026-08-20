/**
 * 2.2 Arranque de flujo por tenant y rol (CHAT-START-*)
 *
 * EXEMPLAR del CHATBOT: patrón simulate + FakeLlm + fixtures de flujo.
 *
 * Vía: POST /conversations/simulate con { from, body, tenantId }, que atraviesa RabbitMQ de
 * punta a punta (cola whatsapp.simulate.incoming → handleMessage → publica la respuesta). La
 * respuesta del bot vuelve en `res.body.reply`.
 *
 * Frontera mockeada: `LlmService` → `FakeLlmService` (determinista). El motor de flujos NO se
 * mockea: se ejercita de verdad.
 *
 * Hazard de aislamiento: `Flow.isDefault` es GLOBAL. Cada test que depende del flujo default lo
 * fija explícitamente (desmarca los demás primero). Ver flow-builder.ts.
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
  edge,
} from './support';

describe('2.2 Arranque de flujo por tenant y rol (CHAT-START-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  let tenantA: { id: string };
  let tenantB: { id: string };
  let roleConStart: { id: string };
  let roleSinStart: { id: string };
  let anaPhone: string;
  let betoPhone: string;
  let defaultFlowId: string;

  async function unsetAllDefaults() {
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }
  async function useMyDefault() {
    await unsetAllDefaults();
    await t.prisma.flow.update({ where: { id: defaultFlowId }, data: { isDefault: true } });
  }

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').send({ from, body, tenantId });
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });

    tenantA = await createTenant(t.prisma, { slug: uniqueSlug('acme') });
    tenantB = await createTenant(t.prisma, { slug: uniqueSlug('globex') });
    roleConStart = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Con Start' });
    roleSinStart = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Sin Start' });

    anaPhone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('ana'),
      phone: anaPhone,
      firstName: 'Ana',
      memberships: [{ tenantId: tenantA.id, roleId: roleConStart.id }],
    });
    betoPhone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('beto'),
      phone: betoPhone,
      firstName: 'Beto',
      memberships: [{ tenantId: tenantA.id, roleId: roleSinStart.id }],
    });

    // Flujo de inicio de (tenantA, roleConStart).
    await createFlow(t.prisma, {
      name: 'F-INICIO-A',
      nodes: [startNode('as'), messageNode('am', 'Bienvenido conocido a A'), endNode('ae')],
      edges: [edge('as', 'am', 'known'), edge('am', 'ae')],
      assign: [{ tenantId: tenantA.id, isStart: true, roleIds: [roleConStart.id] }],
    });

    // Flujo default global (con rama known y unknown a partir del nodo start).
    const def = await createFlow(t.prisma, {
      name: 'F-DEFAULT',
      isDefault: true,
      nodes: [
        startNode('ds', { text: '¡Hola! Soy el bot general.' }),
        messageNode('dknown', 'Rama conocido default'),
        messageNode('dunknown', 'Rama desconocido'),
        endNode('de'),
      ],
      edges: [edge('ds', 'dknown', 'known'), edge('ds', 'dunknown', 'unknown'), edge('dknown', 'de'), edge('dunknown', 'de')],
    });
    defaultFlowId = def.id;
  });

  afterAll(async () => {
    await unsetAllDefaults();
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  it('CHAT-START-01: usuario conocido cuyo rol tiene flujo de inicio arranca ese flujo', async () => {
    await useMyDefault();
    const res = await simulate(anaPhone, tenantA.id);

    expect(res.status).toBe(201);
    // Saludo de conocido del nodo start + el mensaje de la rama known del flujo de inicio.
    expect(res.body.reply).toContain('Bienvenido de nuevo');
    expect(res.body.reply).toContain('Bienvenido conocido a A');
  });

  it('CHAT-START-02: usuario desconocido cae al flujo isDefault global (rama desconocido)', async () => {
    await useMyDefault();
    const res = await simulate(uniquePhone(), tenantA.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Soy el bot general');
    expect(res.body.reply).toContain('Rama desconocido');
  });

  it('CHAT-START-03: rol conocido sin flujo de inicio propio cae al default global (rama conocido)', async () => {
    await useMyDefault();
    const res = await simulate(betoPhone, tenantA.id);

    expect(res.status).toBe(201);
    // Beto es miembro (conocido) pero su rol no tiene start flow → default, rama known.
    expect(res.body.reply).toContain('Rama conocido default');
  });

  it('CHAT-START-04: sin flujo de inicio ni default activo responde el orquestador LLM', async () => {
    await unsetAllDefaults(); // no hay ningún default global
    llm.setReply('Respuesta del orquestador sin flujo.');
    // Un tenant sin ningún flujo asignado y sin default → executeFlow devuelve null.
    const tenantSinFlujo = await createTenant(t.prisma, { slug: uniqueSlug('sinflujo') });

    const res = await simulate(uniquePhone(), tenantSinFlujo.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Respuesta del orquestador sin flujo.');
  });

  it('CHAT-START-05: mismo teléfono, conocido en A (su flujo) y desconocido en B (rama desconocido del default)', async () => {
    await useMyDefault();
    const phone = uniquePhone();
    // Conocido en A.
    await createUser(t.prisma, {
      email: uniqueEmail('caro'),
      phone,
      firstName: 'Caro',
      memberships: [{ tenantId: tenantA.id, roleId: roleConStart.id }],
    });

    const enA = await simulate(phone, tenantA.id);
    expect(enA.body.reply).toContain('Bienvenido de nuevo'); // su flujo de inicio

    const enB = await simulate(phone, tenantB.id);
    expect(enB.body.reply).toContain('Rama desconocido'); // no es miembro de B → default, rama unknown
  });
});
