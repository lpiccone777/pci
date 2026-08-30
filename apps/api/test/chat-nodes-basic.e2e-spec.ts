/**
 * 2.3 Nodos del motor — uno por uno (CHAT-N-*), subconjunto básico.
 *
 * Cubre `start` (CHAT-N-START-*), `message` (CHAT-N-MSG-*), `end` (CHAT-N-END-*),
 * `delay` / `variable` / `webhook` (CHAT-N-DLY-*, CHAT-N-VAR-*, CHAT-N-WHK-01) y el nodo de
 * tipo desconocido (CHAT-N-DEF-01). Los demás tipos (menu, input, condition,
 * device_validation, ticket_create, ticket_query, transfer_agent, sms, llm_query, subflow) los
 * cubren otros specs.
 *
 * Mismo patrón que el exemplar (`chat-start.e2e-spec.ts`): `POST /conversations/simulate` →
 * `res.body.reply`, atravesando RabbitMQ de punta a punta. Única frontera mockeada: `LlmService`
 * (`FakeLlmService`). El motor de flujos (`ConversationsService.executeNode`/`executeFlow`) NO
 * se mockea.
 *
 * Aislamiento: cada test de nodo "downstream" (message/end/delay/variable/webhook/default) arma
 * su propio tenant + rol + usuario conocido con un flujo de inicio propio (`TenantFlow.isStart`),
 * así evita el hazard de `Flow.isDefault` GLOBAL (ver flow-builder.ts). Solo CHAT-N-START-02
 * (usuario desconocido) necesita tocar el default global, porque `findActiveFlowForTenant`
 * SIEMPRE cae a `isDefault` cuando `identity.roleId` es null (verificado en flow.service.ts) —
 * no existe forma de asignarle un flujo de inicio "para desconocidos" vía TenantFlow.
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
  delayNode,
  variableNode,
  webhookNode,
  node,
  edge,
  FlowNode,
  FlowEdge,
} from './support';

describe('2.3 Nodos del motor — uno por uno, básico (CHAT-N-START/MSG/END/DLY/VAR/WHK/DEF)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  async function unsetAllDefaults() {
    await t.prisma.flow.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  /**
   * Tenant + rol + usuario CONOCIDO propios, con un flujo asignado como inicio de ese
   * (tenant, rol) — así el flujo bajo prueba arranca directo, sin tocar `isDefault` global.
   */
  async function setupKnownFlow(
    nodes: FlowNode[],
    edges: FlowEdge[],
    userOverrides: Partial<{ firstName: string | null; lastName: string | null }> = {},
  ) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('nod') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol Nodo' });
    const phone = uniquePhone();
    const user = await createUser(t.prisma, {
      email: uniqueEmail('nodo'),
      phone,
      firstName: 'Deco',
      lastName: 'Nocido',
      ...userOverrides,
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const flow = await createFlow(t.prisma, {
      name: uniqueSlug('flow-nodo'),
      nodes,
      edges,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    return { tenant, role, user, phone, flowId: flow.id };
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
  });

  afterAll(async () => {
    await unsetAllDefaults();
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  // ── start (CHAT-N-START-*) ────────────────────────────────────────────────

  describe('start (CHAT-N-START-*)', () => {
    it('CHAT-N-START-01: usuario conocido — saluda "Bienvenido de nuevo", siembra flowState y rutea por el handle known', async () => {
      const { phone, tenant, user } = await setupKnownFlow(
        [
          startNode('s'),
          messageNode(
            'datos',
            'Datos: {{userFirstName}}|{{userLastName}}|{{userEmail}}|{{userPhone}}|{{userRole}}|{{isKnownUser}}|{{userId}}',
          ),
          endNode('e'),
        ],
        [edge('s', 'datos', 'known'), edge('datos', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('¡Hola Deco! Bienvenido de nuevo.');
      // flowState sembrado por el nodo `start` (ver executeNode, case 'start'), verificado
      // interpolando cada campo en el nodo `message` siguiente.
      expect(res.body.reply).toContain(
        `Datos: Deco|Nocido|${user.email}|${phone}|Rol Nodo|true|${user.id}`,
      );
    });

    it('CHAT-N-START-02: usuario desconocido con data.text propio — usa ese saludo y rutea por el handle unknown', async () => {
      // Único caso de este archivo que depende de `Flow.isDefault` (GLOBAL): un desconocido
      // (identity.roleId === null) siempre cae a `isDefault`, no hay TenantFlow "para
      // desconocidos" (ver flow.service.ts, findActiveFlowForTenant). Se fija explícitamente,
      // desmarcando cualquier otro default primero (hazard documentado en flow-builder.ts).
      await unsetAllDefaults();
      const tenantU = await createTenant(t.prisma, { slug: uniqueSlug('nstart-unk-a') });
      const def = await createFlow(t.prisma, {
        name: uniqueSlug('default-unk-text'),
        isDefault: true,
        nodes: [
          startNode('s', { text: 'Hola visitante, bienvenido.' }),
          messageNode('mk', 'rama known (no debería verse)'),
          messageNode('mu', 'rama unknown'),
          endNode('e'),
        ],
        edges: [edge('s', 'mk', 'known'), edge('s', 'mu', 'unknown'), edge('mk', 'e'), edge('mu', 'e')],
      });
      await t.prisma.flow.update({ where: { id: def.id }, data: { isDefault: true } });

      const res = await simulate(uniquePhone(), tenantU.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Hola visitante, bienvenido.');
      expect(res.body.reply).toContain('rama unknown');
      expect(res.body.reply).not.toContain('rama known');
    });

    it('CHAT-N-START-02: usuario desconocido sin data.text — usa el saludo genérico por defecto', async () => {
      await unsetAllDefaults();
      const tenantU = await createTenant(t.prisma, { slug: uniqueSlug('nstart-unk-b') });
      const def = await createFlow(t.prisma, {
        name: uniqueSlug('default-unk-generic'),
        isDefault: true,
        nodes: [startNode('s'), messageNode('mu', 'rama unknown genérica'), endNode('e')],
        edges: [edge('s', 'mu', 'unknown'), edge('mu', 'e')],
      });
      await t.prisma.flow.update({ where: { id: def.id }, data: { isDefault: true } });

      const res = await simulate(uniquePhone(), tenantU.id);

      expect(res.status).toBe(201);
      // Sin data.text en el nodo start: cae al literal fijo del código (executeNode, case 'start').
      expect(res.body.reply).toContain('¡Hola! Bienvenido. ¿En qué puedo ayudarte?');
      expect(res.body.reply).toContain('rama unknown genérica');
    });

    it('CHAT-N-START-03: conocido sin firstName cargado — saluda sin romper (queda el espacio de más, cosmético)', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), endNode('e', 'Fin.')],
        [edge('s', 'e', 'known')],
        { firstName: null },
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      // greeting = `¡Hola ${user?.firstName || ''}! Bienvenido de nuevo.` (executeNode, case
      // 'start'): con firstName null queda el espacio entre "Hola" y "!" tal cual el plan lo
      // documenta como borde cosmético, no un bug a blindar.
      expect(res.body.reply).toContain('¡Hola ! Bienvenido de nuevo.');
      expect(res.body.reply).toContain('Fin.');
    });

    it('CHAT-N-START-04: sin aristas known/unknown ni *TargetNodeId — cae a la primera arista saliente', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'), // sin data.knownTargetNodeId/unknownTargetNodeId
          messageNode('primera', 'Rama primera'),
          messageNode('segunda', 'Rama segunda'),
          endNode('e'),
        ],
        [
          // Ninguna arista trae sourceHandle: resolveNextNode no puede matchear por
          // handle 'known' y cae a outgoing[0], que es esta (orden del array).
          edge('s', 'primera'),
          edge('s', 'segunda'),
          edge('primera', 'e'),
        ],
      );

      const res = await simulate(phone, tenant.id); // usuario conocido igual (identity.isKnown=true)

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Rama primera');
      expect(res.body.reply).not.toContain('Rama segunda');
    });
  });

  // ── message (CHAT-N-MSG-*) ────────────────────────────────────────────────

  describe('message (CHAT-N-MSG-*)', () => {
    it('CHAT-N-MSG-01: nodo con data.text — emite el texto y avanza al siguiente sin esperar otro mensaje', async () => {
      const { phone, tenant, user } = await setupKnownFlow(
        [startNode('s'), messageNode('m', 'Texto del mensaje'), endNode('e')],
        [edge('s', 'm', 'known'), edge('m', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Texto del mensaje');
      // "avanza sin esperar": en UN solo request ya se encadenó hasta `end` y cerró la charla
      // (si esperara input, la conversación seguiría 'active' parada en el nodo message).
      const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
      expect(conv?.status).toBe('closed');
    });

    it('CHAT-N-MSG-02: nodo sin data.text — no acumula respuesta (ni línea vacía) y avanza igual', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'),
          messageNode('primero', 'Primero'),
          messageNode('vacio'), // sin data.text
          messageNode('tercero', 'Tercero'),
          endNode('e'),
        ],
        [edge('s', 'primero', 'known'), edge('primero', 'vacio'), edge('vacio', 'tercero'), edge('tercero', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      // `if (result.responseText) responses.push(...)`: al ser '' (falsy) el nodo vacío no
      // agrega nada al array de respuestas — "Primero" y "Tercero" quedan pegados por un único
      // separador '\n\n', sin un hueco extra por el nodo del medio.
      expect(res.body.reply).toContain('Primero\n\nTercero');
    });
  });

  // ── end (CHAT-N-END-*) ────────────────────────────────────────────────────

  describe('end (CHAT-N-END-*)', () => {
    it('CHAT-N-END-01: nodo end con texto — emite el texto y cierra la conversación (currentFlowId/currentNodeId en null)', async () => {
      const { phone, tenant, user } = await setupKnownFlow(
        [startNode('s'), endNode('e', 'Adiós, gracias por escribir.')],
        [edge('s', 'e', 'known')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Adiós, gracias por escribir.');

      const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
      expect(conv?.status).toBe('closed');
      expect(conv?.closedAt).not.toBeNull();
      expect(conv?.currentFlowId).toBeNull();
      expect(conv?.currentNodeId).toBeNull();
    });

    it('CHAT-N-END-02: nodo end sin texto — cierra igual, sin agregar texto de despedida', async () => {
      const { phone, tenant, user } = await setupKnownFlow(
        [startNode('s'), endNode('e')], // sin data.text
        [edge('s', 'e', 'known')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      // Sin texto, `end` no aporta nada a `responses`: la respuesta es solo el saludo del start.
      expect(res.body.reply).toBe('¡Hola Deco! Bienvenido de nuevo.');

      const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
      expect(conv?.status).toBe('closed');
    });
  });

  // ── delay / variable / webhook (CHAT-N-DLY-* / CHAT-N-VAR-* / CHAT-N-WHK-01) ─

  describe('delay (CHAT-N-DLY-*)', () => {
    it('CHAT-N-DLY-01: seconds dentro del tope — espera ese tiempo (aprox) y sigue', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), delayNode('d', 1), messageNode('m', 'Después del delay'), endNode('e')],
        [edge('s', 'd', 'known'), edge('d', 'm'), edge('m', 'e')],
      );

      const start = Date.now();
      const res = await simulate(phone, tenant.id);
      const elapsedMs = Date.now() - start;

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Después del delay');
      // seconds:1 → Math.min(1, MAX_DELAY_SECONDS) = 1s reales. Margen para no ser flaky.
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
    });

    it('CHAT-N-DLY-02: seconds > 10 se acota a MAX_DELAY_SECONDS (10) — no cuelga la request', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), delayNode('d', 999), messageNode('m', 'Tras el clamp'), endNode('e')],
        [edge('s', 'd', 'known'), edge('d', 'm'), edge('m', 'e')],
      );

      // No se espera un delay real de 10s (colgaría el test). Se intercepta SOLO el
      // setTimeout de exactamente 10000ms (conversations.service.ts: `MAX_DELAY_SECONDS = 10`,
      // línea 60; `Math.min(data.seconds || 1, MAX_DELAY_SECONDS)` en el case 'delay') y se
      // ejecuta ya mismo — así se verifica el valor real que calculó el clamp sin tocar otros
      // timers reales de la app (p. ej. el timeout de 300s del RPC de /simulate).
      const realSetTimeout = global.setTimeout;
      const capturedDelaysMs: number[] = [];
      const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any, ms?: number, ...args: any[]) => {
        if (ms === 10_000) {
          capturedDelaysMs.push(ms);
          return realSetTimeout(cb, 0, ...args);
        }
        return realSetTimeout(cb, ms, ...args);
      }) as any);

      let res;
      try {
        res = await simulate(phone, tenant.id);
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Tras el clamp');
      expect(capturedDelaysMs).toContain(10_000);
    });
  });

  describe('variable (CHAT-N-VAR-*)', () => {
    it('CHAT-N-VAR-01: action:set con name y value — guarda data.value en el estado', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'miVar', value: 'ValorFijo' }),
          messageNode('m', 'Var: {{miVar}}'),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'm'), edge('m', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Var: ValorFijo');
    });

    it('CHAT-N-VAR-01: action:set con name pero sin value — guarda el mensaje entrante', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'),
          variableNode('v', { action: 'set', name: 'miVar' }), // sin data.value
          messageNode('m', 'Var: {{miVar}}'),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'm'), edge('m', 'e')],
      );

      // `body` es el mismo mensaje entrante en todo el encadenado (executeFlow no lo
      // reasigna entre nodos): data.value ?? body → cae al body original.
      const res = await simulate(phone, tenant.id, 'texto-de-entrada');

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Var: texto-de-entrada');
    });

    it('CHAT-N-VAR-02: action distinto de set — no hace nada, avanza', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'),
          variableNode('v', { action: 'noop', name: 'miVar', value: 'NoDeberiaGuardarse' }),
          messageNode('m', 'Var:[{{miVar}}]'),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'm'), edge('m', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      // No se guardó nada: `interpolate` deja el placeholder tal cual porque flowState.miVar
      // es undefined.
      expect(res.body.reply).toContain('Var:[{{miVar}}]');
    });

    it('CHAT-N-VAR-03: action:set sin name — no guarda nada (la condición exige name), avanza igual', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [
          startNode('s'),
          variableNode('v', { action: 'set', value: 'NoDeberiaGuardarse' }), // sin data.name
          messageNode('m', 'Var:[{{miVar}}]'),
          endNode('e'),
        ],
        [edge('s', 'v', 'known'), edge('v', 'm'), edge('m', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Var:[{{miVar}}]');
    });
  });

  describe('webhook (CHAT-N-WHK-*)', () => {
    it('CHAT-N-WHK-01: nodo webhook — hoy responde el stub fijo (sin HTTP real)', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), webhookNode('w'), endNode('e')],
        [edge('s', 'w', 'known'), edge('w', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Acción webhook ejecutada (stub).');
    });
  });

  // ── nodo de tipo desconocido (CHAT-N-DEF-01) ──────────────────────────────

  describe('nodo de tipo desconocido (CHAT-N-DEF-01)', () => {
    it('CHAT-N-DEF-01: tipo no reconocido con data.text — responde ese texto', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), node('x', 'foo', { text: 'Texto custom del nodo raro' }), endNode('e')],
        [edge('s', 'x', 'known'), edge('x', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Texto custom del nodo raro');
    });

    it('CHAT-N-DEF-01: tipo no reconocido sin data.text — responde "Nodo no implementado."', async () => {
      const { phone, tenant } = await setupKnownFlow(
        [startNode('s'), node('x', 'foo', {}), endNode('e')],
        [edge('s', 'x', 'known'), edge('x', 'e')],
      );

      const res = await simulate(phone, tenant.id);

      expect(res.status).toBe(201);
      expect(res.body.reply).toContain('Nodo no implementado.');
    });
  });
});
