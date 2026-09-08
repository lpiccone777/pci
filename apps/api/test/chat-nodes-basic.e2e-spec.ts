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
 * Aislamiento: cada test de nodo arma su propio tenant + rol + usuario conocido con un flujo
 * de inicio propio (`TenantFlow.isStart`), así evita el hazard de `Flow.isDefault` GLOBAL (ver
 * flow-builder.ts).
 *
 * CHAT-N-START-02 (usuario desconocido → rama `unknown` del nodo `start`) no tiene un test acá:
 * desde "no hablamos con desconocidos" (pedido 2026-08-27), `handleMessage` rechaza cualquier
 * teléfono sin membresía ANTES de resolver flujo alguno — la rama `unknown` queda como
 * capacidad del motor de flujos, pero inalcanzable por este camino (ver AGENTS.md, "No
 * hablamos con desconocidos"). El rechazo en sí ya lo cubren chat-known.e2e-spec.ts
 * (CHAT-KNOWN-02/03/04) y chat-start.e2e-spec.ts (CHAT-START-02/05).
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
  installFetchMock,
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
    it('CHAT-N-WHK-01: nodo webhook — hace un POST real fire-and-forget (sin responseText) y el flujo sigue de largo', async () => {
      const fetchMock = installFetchMock(() => ({ status: 200, body: { ok: true } }));
      try {
        const { phone, tenant } = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', { url: 'https://ejemplo.test/hook', body: '{"ticket":"{{userFirstName}}"}' }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );

        const res = await simulate(phone, tenant.id);

        expect(res.status).toBe(201);
        // Fire-and-forget: no aporta texto a la respuesta — solo se ve el saludo + el `end`.
        expect(res.body.reply).toBe('¡Hola Deco! Bienvenido de nuevo.\n\nListo.');

        expect(fetchMock.requests).toHaveLength(1);
        const req = fetchMock.requests[0];
        expect(req.url).toBe('https://ejemplo.test/hook');
        expect(req.init?.method).toBe('POST');
        expect(req.init?.body).toBe('{"ticket":"Deco"}'); // interpolado
      } finally {
        fetchMock.restore();
      }
    });

    it('CHAT-N-WHK-02: nodo webhook sin URL configurada — no llama a fetch, no rompe el flujo', async () => {
      const fetchMock = installFetchMock(() => ({ status: 200, body: {} }));
      try {
        const { phone, tenant } = await setupKnownFlow(
          [startNode('s'), webhookNode('w'), endNode('e', 'Listo.')],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );

        const res = await simulate(phone, tenant.id);

        expect(res.status).toBe(201);
        expect(res.body.reply).toBe('¡Hola Deco! Bienvenido de nuevo.\n\nListo.');
        expect(fetchMock.requests).toHaveLength(0);
      } finally {
        fetchMock.restore();
      }
    });

    it('CHAT-N-WHK-03: con GET no manda cuerpo; con POST/PATCH manda el body interpolado como JSON', async () => {
      const fetchMock = installFetchMock(() => ({ status: 200, body: { ok: true } }));
      try {
        const conGet = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', {
              url: 'https://ejemplo.test/hook-get',
              method: 'GET',
              body: '{"no":"deberia viajar"}',
            }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );
        await simulate(conGet.phone, conGet.tenant.id);

        const conPatch = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', {
              url: 'https://ejemplo.test/hook-patch',
              method: 'PATCH',
              body: '{"quien":"{{userFirstName}}"}',
            }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );
        await simulate(conPatch.phone, conPatch.tenant.id);

        const get = fetchMock.requests.find((r) => r.url.endsWith('/hook-get'))!;
        expect(get.init?.method).toBe('GET');
        expect(get.init?.body).toBeUndefined();

        const patch = fetchMock.requests.find((r) => r.url.endsWith('/hook-patch'))!;
        expect(patch.init?.method).toBe('PATCH');
        expect(patch.init?.body).toBe('{"quien":"Deco"}');
        expect((patch.init?.headers as Record<string, string>)['Content-Type']).toBe(
          'application/json',
        );
      } finally {
        fetchMock.restore();
      }
    });

    it('CHAT-N-WHK-03: una respuesta no-2xx o un error de red no traban el flujo', async () => {
      const noOk = installFetchMock(() => ({ status: 500, body: 'x'.repeat(500) }));
      try {
        const { phone, tenant } = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', { url: 'https://ejemplo.test/roto' }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );

        const res = await simulate(phone, tenant.id);

        expect(res.status).toBe(201);
        expect(res.body.reply).toBe('¡Hola Deco! Bienvenido de nuevo.\n\nListo.');
      } finally {
        noOk.restore();
      }

      const caido = installFetchMock(() => {
        throw new Error('ECONNREFUSED (simulado)');
      });
      try {
        const { phone, tenant } = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', { url: 'https://ejemplo.test/caido' }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );

        const res = await simulate(phone, tenant.id);

        // Un webhook caído (una alerta a un chat externo, por ejemplo) no debe trabar el bot.
        expect(res.status).toBe(201);
        expect(res.body.reply).toBe('¡Hola Deco! Bienvenido de nuevo.\n\nListo.');
      } finally {
        caido.restore();
      }
    });

    it.failing(
      'CHAT-N-WHK-04: el nodo webhook debería rechazar destinos internos y esquemas raros (hoy sale sin restricción) @invertido',
      async () => {
        const fetchMock = installFetchMock(() => ({ status: 200, body: { ok: true } }));
        try {
          const { phone, tenant } = await setupKnownFlow(
            [
              startNode('s'),
              webhookNode('w1', {
                url: 'http://169.254.169.254/latest/meta-data/',
                body: '{"filtrado":"{{userFirstName}}"}',
              }),
              webhookNode('w2', { url: 'http://127.0.0.1:9/interno' }),
              webhookNode('w3', { url: 'file:///etc/passwd' }),
              endNode('e', 'Listo.'),
            ],
            [edge('s', 'w1', 'known'), edge('w1', 'w2'), edge('w2', 'w3'), edge('w3', 'e')],
          );

          await simulate(phone, tenant.id);

          // SEGURO: lista blanca de esquemas y bloqueo de direcciones privadas y del servicio de
          // metadatos de la nube. Hoy la llamada sale sin ninguna restricción y, como el `body`
          // se interpola con las variables de la charla, un flujo importado puede además
          // exfiltrar lo que la persona contó. Alcanza con `flows:update` para configurarlo.
          expect(fetchMock.requests).toHaveLength(0);
        } finally {
          fetchMock.restore();
        }
      },
    );

    it('BE-PH-05: el nodo webhook ya no es un stub — hace la llamada HTTP real con tiempo máximo de espera', async () => {
      // El plan describe este caso como "hoy es stub"; el código lo dejó atrás: `case 'webhook'`
      // hace un `fetch` real fire-and-forget con `AbortSignal.timeout`. Lo que sigue pendiente de
      // ese caso es la validación de destino (SSRF), cubierta como falla esperada en
      // CHAT-N-WHK-04.
      const fetchMock = installFetchMock(() => ({ status: 200, body: { ok: true } }));
      try {
        const { phone, tenant } = await setupKnownFlow(
          [
            startNode('s'),
            webhookNode('w', { url: 'https://ejemplo.test/ya-no-es-stub' }),
            endNode('e', 'Listo.'),
          ],
          [edge('s', 'w', 'known'), edge('w', 'e')],
        );

        const res = await simulate(phone, tenant.id);

        expect(fetchMock.requests).toHaveLength(1);
        expect(fetchMock.requests[0].init?.signal).toBeDefined();
        // Y no queda rastro del texto de stub en la respuesta.
        expect(res.body.reply).not.toContain('stub');
      } finally {
        fetchMock.restore();
      }
    });
  });

  describe('rama unknown del nodo start (CHAT-N-START-02)', () => {
    it('CHAT-N-START-02: el handle unknown sigue cableado en el grafo, pero ningún mensaje real lo recorre', async () => {
      const { phone, tenant, flowId } = await setupKnownFlow(
        [
          startNode('s'),
          messageNode('mk', 'Rama conocido'),
          messageNode('mu', 'Rama desconocido'),
          endNode('e'),
        ],
        [
          edge('s', 'mk', 'known'),
          edge('s', 'mu', 'unknown'),
          edge('mk', 'e'),
          edge('mu', 'e'),
        ],
      );

      // Quien está registrado recorre la rama `known`.
      const conocido = await simulate(phone, tenant.id);
      expect(conocido.body.reply).toContain('Rama conocido');
      expect(conocido.body.reply).not.toContain('Rama desconocido');

      // Quien no lo está se rechaza ANTES de resolver flujo alguno: la rama `unknown` no se
      // recorre por este camino (ver AGENTS.md, "No hablamos con desconocidos"). El handle sigue
      // existiendo en el grafo guardado, que es lo que este caso vigila.
      const desconocido = await simulate(uniquePhone(), tenant.id);
      expect(desconocido.body.reply).not.toContain('Rama desconocido');

      const flujo = await t.prisma.flow.findUniqueOrThrow({ where: { id: flowId } });
      const handles = (flujo.edges as any[]).map((e) => e.sourceHandle);
      expect(handles).toContain('unknown');
      expect(handles).toContain('known');
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
