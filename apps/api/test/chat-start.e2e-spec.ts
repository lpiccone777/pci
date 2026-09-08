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
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
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

  it('CHAT-START-02: usuario desconocido (sin membresía en el tenant) se rechaza, no llega a ningún flujo', async () => {
    await useMyDefault();
    const res = await simulate(uniquePhone(), tenantA.id);

    expect(res.status).toBe(201);
    // No hablamos con desconocidos: se rechaza antes de resolver flujo alguno — nada del
    // default global ("Soy el bot general") ni de su rama `unknown`.
    expect(res.body.reply).toBe('Este número no está registrado: el bot no atiende mensajes de desconocidos.');
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
    // Un tenant sin ningún flujo asignado y sin default → executeFlow devuelve null. El
    // teléfono tiene que ser MIEMBRO de este tenant: no hablamos con desconocidos, así que un
    // número sin membresía se rechazaría antes de siquiera intentar resolver un flujo.
    const tenantSinFlujo = await createTenant(t.prisma, { slug: uniqueSlug('sinflujo') });
    const roleSinFlujo = await createRole(t.prisma, { tenantId: tenantSinFlujo.id, name: 'Rol Sin Flujo' });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('sinflujo'),
      phone,
      firstName: 'Sin Flujo',
      memberships: [{ tenantId: tenantSinFlujo.id, roleId: roleSinFlujo.id }],
    });

    const res = await simulate(phone, tenantSinFlujo.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Respuesta del orquestador sin flujo.');
  });

  it('CHAT-START-05: mismo teléfono, conocido en A (su flujo) y desconocido en B (se rechaza, no hablamos con desconocidos)', async () => {
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
    // No es miembro de B: se rechaza, no llega a la rama `unknown` del default.
    expect(enB.body.reply).toBe('Este número no está registrado: el bot no atiende mensajes de desconocidos.');
  });

  it('CHAT-START-06: el saludo del nodo start sale de data.text, interpolado (antes era fijo)', async () => {
    await useMyDefault();
    const role = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Saludo Custom' });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('saludo'),
      phone,
      firstName: 'Dina',
      memberships: [{ tenantId: tenantA.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: 'F-SALUDO-CUSTOM',
      nodes: [
        startNode('cs', { text: 'Buenas {{userFirstName}}, te atiende Soporte.' }),
        messageNode('cm', 'Siguiente paso'),
        endNode('ce'),
      ],
      edges: [edge('cs', 'cm', 'known'), edge('cm', 'ce')],
      assign: [{ tenantId: tenantA.id, isStart: true, roleIds: [role.id] }],
    });

    const res = await simulate(phone, tenantA.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Buenas Dina, te atiende Soporte.');
    expect(res.body.reply).not.toContain('Bienvenido de nuevo'); // ya no se manda el fijo
    expect(res.body.reply).toContain('Siguiente paso');
  });

  it('CHAT-START-07: con noGreeting el nodo start no manda nada y la charla arranca con el nodo siguiente', async () => {
    await useMyDefault();
    const role = await createRole(t.prisma, { tenantId: tenantA.id, name: 'Sin Saludo' });
    const phone = uniquePhone();
    await createUser(t.prisma, {
      email: uniqueEmail('sinsaludo'),
      phone,
      firstName: 'Eze',
      memberships: [{ tenantId: tenantA.id, roleId: role.id }],
    });
    await createFlow(t.prisma, {
      name: 'F-SIN-SALUDO',
      // `text` cargado Y `noGreeting`: el tilde manda, el texto no se usa.
      nodes: [
        startNode('ns', { text: 'Esto no se manda', noGreeting: true }),
        messageNode('nm', 'Arranca directo acá'),
        endNode('ne'),
      ],
      edges: [edge('ns', 'nm', 'known'), edge('nm', 'ne')],
      assign: [{ tenantId: tenantA.id, isStart: true, roleIds: [role.id] }],
    });

    const res = await simulate(phone, tenantA.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Arranca directo acá');
    expect(res.body.reply).not.toContain('Bienvenido de nuevo');
    expect(res.body.reply).not.toContain('Esto no se manda');
    expect(res.body.reply).not.toContain('Eze');
  });

  describe('CHAT-START-08: arranque con feriado o guardia vigente', () => {
    let tenantCal: { id: string };
    let roleCal: { id: string };
    let principalId: string;
    let varianteId: string;

    beforeAll(async () => {
      tenantCal = await createTenant(t.prisma, { slug: uniqueSlug('start08') });
      roleCal = await createRole(t.prisma, { tenantId: tenantCal.id, name: 'Rol calendario' });
      const principal = await createFlow(t.prisma, {
        name: 'F-PRINCIPAL-CAL',
        nodes: [startNode('ps'), messageNode('pm', 'Atiende el flujo PRINCIPAL'), endNode('pe')],
        edges: [edge('ps', 'pm', 'known'), edge('pm', 'pe')],
        assign: [{ tenantId: tenantCal.id, isStart: true, roleIds: [roleCal.id] }],
      });
      principalId = principal.id;
      // La variante nace sin empresas asignadas: solo se llega a ella por `FlowAlternative`.
      const variante = await createFlow(t.prisma, {
        name: 'F-PRINCIPAL-CAL (feriado)',
        nodes: [startNode('vs'), messageNode('vm', 'Atiende el flujo de FERIADO'), endNode('ve')],
        edges: [edge('vs', 'vm', 'known'), edge('vm', 've')],
      });
      varianteId = variante.id;
      await t.prisma.flowAlternative.create({
        data: { baseFlowId: principalId, type: 'feriado', variantFlowId: varianteId },
      });
    });

    afterEach(async () => {
      await t.prisma.scheduleCalendarEntry.deleteMany({ where: { tenantId: tenantCal.id } });
      await t.prisma.flow.update({ where: { id: varianteId }, data: { isActive: true } });
    });

    /** Feriado que cubre el instante actual, para todos los roles de la empresa. */
    async function feriadoVigente() {
      const ahora = Date.now();
      await t.prisma.scheduleCalendarEntry.create({
        data: {
          tenantId: tenantCal.id,
          type: 'feriado',
          title: 'Feriado de hoy',
          roleId: null,
          allDay: true,
          startAt: new Date(ahora - 3_600_000),
          endAt: new Date(ahora + 3_600_000),
        },
      });
    }

    async function personaDeLaEmpresa() {
      const phone = uniquePhone();
      await createUser(t.prisma, {
        email: uniqueEmail('start08'),
        phone,
        firstName: 'Cala',
        memberships: [{ tenantId: tenantCal.id, roleId: roleCal.id }],
      });
      return phone;
    }

    it('CHAT-START-08: con feriado vigente y variante configurada, arranca la variante', async () => {
      await feriadoVigente();
      const phone = await personaDeLaEmpresa();

      const res = await simulate(phone, tenantCal.id);

      expect(res.body.reply).toContain('Atiende el flujo de FERIADO');
      expect(res.body.reply).not.toContain('Atiende el flujo PRINCIPAL');
    });

    it('CHAT-START-08: sin feriado vigente arranca el Principal', async () => {
      const phone = await personaDeLaEmpresa();

      const res = await simulate(phone, tenantCal.id);

      expect(res.body.reply).toContain('Atiende el flujo PRINCIPAL');
    });

    it('CHAT-START-08: con la variante inactiva, el feriado no cambia nada', async () => {
      await feriadoVigente();
      await t.prisma.flow.update({ where: { id: varianteId }, data: { isActive: false } });
      const phone = await personaDeLaEmpresa();

      const res = await simulate(phone, tenantCal.id);

      expect(res.body.reply).toContain('Atiende el flujo PRINCIPAL');
    });
  });
});
