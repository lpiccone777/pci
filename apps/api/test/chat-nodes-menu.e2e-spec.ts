/**
 * 2.3 Nodos del motor — `menu` (CHAT-N-MENU-01..14).
 *
 * Mismo patrón que el exemplar (`chat-start.e2e-spec.ts`) y que `chat-nodes-basic.e2e-spec.ts`:
 * `POST /conversations/simulate` → `res.body.reply`, atravesando RabbitMQ de punta a punta.
 * Única frontera mockeada: `LlmService` (`FakeLlmService`). El motor de flujos
 * (`ConversationsService.executeNode`/`executeFlow`) NO se mockea.
 *
 * Aislamiento: cada test arma su propio tenant + rol + usuario conocido con un flujo de inicio
 * propio (`TenantFlow.isStart`), así nunca depende de `Flow.isDefault` (GLOBAL, ver
 * flow-builder.ts) y no hace falta desmarcarlo en ningún lado.
 *
 * ## Gotcha verificado en el código: el "cierre de charla" (paso 3.5 de `handleMessage`) es
 * ANTERIOR a `executeFlow` y corre para CUALQUIER mensaje entrante, no solo dentro de un nodo
 * `menu`/`input`. `looksLikeCancelAttempt` matchea por substring contra `CANCEL_HINT_WORDS`, que
 * incluye la palabra suelta `'volver'` — el mismísimo texto de la opción sintética "Volver" del
 * menú. Si el mensaje matchea, se llama a `confirmEndChatIntent` (LLM, prompt PROPIO, distinto
 * del de `interpretMenuChoice`) y, si responde CERRAR, cierra la charla ENTERA antes de que el
 * motor de flujos vea el mensaje. El `FakeLlmService` de este archivo despacha por contenido del
 * system prompt (única forma de distinguir `interpretMenuChoice` de `confirmEndChatIntent` de
 * `orchestratorLlm`, que comparten el mismo `chat()`) y siempre responde SEGUIR para el
 * clasificador de cierre — así el gate nunca interfiere y cada test ejercita de verdad la lógica
 * del nodo `menu`, no la del cierre de charla (eso es harina de otro costal, cubierto en el
 * bloque 2.8 del plan).
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmMessage } from '../src/modules/llm/llm-provider.interface';
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
  menuNode,
  endNode,
  subflowNode,
  edge,
  FlowNode,
  FlowEdge,
} from './support';

describe('2.3 Nodos del motor — menu (CHAT-N-MENU-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;

  // Controlan, por test, qué devuelve cada clasificador LLM relevante. Se reinician en
  // `beforeEach`. `endChatAnswer` siempre "SEGUIR" a propósito (ver comentario de cabecera).
  let menuChoiceAnswer: string;
  let orchestratorAnswer: string;

  function simulate(from: string, tenantId: string, body = 'hola') {
    return http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });
  }

  /** Cuenta las líneas "N. texto" de una respuesta (texto numerado plano, sin interactivo). */
  function numberedLines(reply: string): string[] {
    return reply
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\s/.test(l));
  }

  /** Despacha por el contenido del primer mensaje `system` — es lo único que distingue a
   * `interpretMenuChoice` de `confirmEndChatIntent` de `orchestratorLlm`, los tres detrás del
   * mismo `LlmService.chat()`. Verificado leyendo los tres system prompts en
   * conversations.service.ts. */
  function dispatch(messages: LlmMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('clasificador de intención para un menú de opciones')) return menuChoiceAnswer;
    if (sys.includes('cerrar o reiniciar la charla completa')) return 'SEGUIR';
    if (sys.includes('Eres un orquestador de soporte técnico')) return orchestratorAnswer;
    return 'NINGUNA';
  }

  /** Tenant + rol + usuario CONOCIDO propios, con el flujo dado asignado como inicio de ese
   * (tenant, rol) — nunca toca `isDefault` global. Mismo patrón que chat-nodes-basic.ts. */
  async function setupMenuFlow(nodes: FlowNode[], edges: FlowEdge[]) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug('men') });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol Menu' });
    const phone = uniquePhone();
    const user = await createUser(t.prisma, {
      email: uniqueEmail('menu'),
      phone,
      firstName: 'Deco',
      memberships: [{ tenantId: tenant.id, roleId: role.id }],
    });
    const flow = await createFlow(t.prisma, {
      name: uniqueSlug('flow-menu'),
      nodes,
      edges,
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    return { tenant, role, user, phone, flowId: flow.id };
  }

  // --- Topología compartida por varios casos: menú raíz de 3 opciones (botones) con un
  // submenú de 2 opciones al elegir "reclamo". La opción "estado" NO tiene arista con
  // sourceHandle propio — solo `targetNodeId` (CHAT-N-MENU-10).
  function mainMenuNodes(): FlowNode[] {
    return [
      startNode('s'),
      menuNode('menuRoot', {
        text: '¿En qué te ayudamos?',
        options: [
          { value: 'estado', label: 'Ver estado del ticket actual', targetNodeId: 'endEstado' },
          { value: 'reclamo', label: 'Hacer un reclamo' },
          { value: 'otro', label: 'Otro tema' },
        ],
      }),
      menuNode('submenu', {
        text: 'Elegí el tipo de reclamo',
        options: [
          { value: 'factura', label: 'Facturación' },
          { value: 'soporte', label: 'Soporte técnico' },
        ],
      }),
      endNode('endEstado', 'Acá tenés tu estado.'),
      endNode('endOtro', 'Listo, anotado el otro tema.'),
      endNode('endFactura', 'Listo, derivado a facturación.'),
      endNode('endSoporte', 'Listo, derivado a soporte técnico.'),
    ];
  }
  function mainMenuEdges(): FlowEdge[] {
    return [
      edge('s', 'menuRoot', 'known'),
      edge('menuRoot', 'submenu', 'reclamo'),
      edge('menuRoot', 'endOtro', 'otro'),
      // Sin arista para 'estado' a propósito: fuerza el ruteo por targetNodeId.
      edge('submenu', 'endFactura', 'factura'),
      edge('submenu', 'endSoporte', 'soporte'),
    ];
  }

  beforeAll(async () => {
    llm = new FakeLlmService();
    t = await createTestApp({
      customize: (b) => b.overrideProvider(LlmService).useValue(llm),
    });
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(() => {
    llm.reset();
    menuChoiceAnswer = 'NINGUNA';
    orchestratorAnswer = 'Respuesta genérica del orquestador.';
    llm.setResponder(dispatch);
  });

  // ── CHAT-N-MENU-01: primera llegada, ≤3 opciones → botones ──────────────────

  it('CHAT-N-MENU-01: primera llegada con ≤3 opciones muestra el menú como botones (título truncado a 20)', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    const longLabel = 'Ver estado del ticket actual';
    expect(longLabel.length).toBeGreaterThan(20);

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('¿En qué te ayudamos?');
    // buildMenuInteractive trunca el título a 20 con options.length<=3 (botones). Se verifica
    // con el mismo `.slice(0,20)` que usa el código Y que el label completo NO aparezca —
    // así se prueba que de verdad truncó, no que el `toContain` matchee por prefijo casual.
    expect(res.body.reply).toContain(longLabel.slice(0, 20));
    expect(res.body.reply).not.toContain(longLabel);
    // 3 opciones → 3 líneas numeradas (formatInteractiveAsText, vía /simulate).
    expect(numberedLines(res.body.reply)).toHaveLength(3);

    // La conversación queda parada en el nodo esperando la elección.
    const conv = await t.prisma.conversation.findFirst({ where: { userId: (await t.prisma.user.findUnique({ where: { phone } }))!.id } });
    expect(conv?.status).toBe('active');
    expect(conv?.currentNodeId).toBe('menuRoot');
  });

  // ── CHAT-N-MENU-02: primera llegada, 4–10 opciones → lista ──────────────────

  it('CHAT-N-MENU-02: primera llegada con 4–10 opciones muestra el menú como lista (título truncado a 24)', async () => {
    const longLabel = 'Área de facturación y cobranzas';
    expect(longLabel.length).toBeGreaterThan(24);
    const nodes: FlowNode[] = [
      startNode('s'),
      menuNode('menuList', {
        text: 'Elegí un área',
        options: [
          { value: 'a', label: longLabel },
          { value: 'b', label: 'Soporte técnico' },
          { value: 'c', label: 'Recursos humanos' },
          { value: 'd', label: 'Ventas' },
          { value: 'e', label: 'Postventa' },
        ],
      }),
    ];
    const { phone, tenant } = await setupMenuFlow(nodes, [edge('s', 'menuList', 'known')]);

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Elegí un área');
    expect(res.body.reply).toContain(longLabel.slice(0, 24));
    expect(res.body.reply).not.toContain(longLabel);
    expect(numberedLines(res.body.reply)).toHaveLength(5);
  });

  // ── CHAT-N-MENU-03: primera llegada, 0 o >10 opciones → texto numerado ──────

  it('CHAT-N-MENU-03: primera llegada con >10 opciones cae a texto numerado, sin truncar', async () => {
    const options = Array.from({ length: 11 }, (_, i) => ({ value: `o${i + 1}`, label: `Opción número ${i + 1}` }));
    const nodes: FlowNode[] = [startNode('s'), menuNode('menuGrande', { text: 'Elegí (muchas opciones)', options })];
    const { phone, tenant } = await setupMenuFlow(nodes, [edge('s', 'menuGrande', 'known')]);

    const res = await simulate(phone, tenant.id);

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Elegí (muchas opciones)');
    // buildMenuInteractive devuelve undefined con >10 opciones: no hay truncamiento (eso solo
    // pasa en el armado de botones/lista) y las 11 aparecen enteras.
    expect(res.body.reply).toContain('11. Opción número 11');
    expect(numberedLines(res.body.reply)).toHaveLength(11);
  });

  // ── CHAT-N-MENU-04: respuesta por número ────────────────────────────────────

  it('CHAT-N-MENU-04: respuesta por número matchea la opción y enruta por su handle', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    // Opción 'otro' es la 3ra del array (índice 2) → "3".
    const res = await simulate(phone, tenant.id, '3');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Listo, anotado el otro tema.');
    expect(llm.calls).toHaveLength(0); // match literal: nunca se gastó una llamada al LLM.
  });

  // ── CHAT-N-MENU-05: respuesta por label o value exactos ─────────────────────

  it('CHAT-N-MENU-05: respuesta exacta por label matchea y enruta', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    const res = await simulate(phone, tenant.id, 'Otro tema');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Listo, anotado el otro tema.');
    expect(llm.calls).toHaveLength(0);
  });

  it('CHAT-N-MENU-05: respuesta exacta por value matchea y enruta', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    const res = await simulate(phone, tenant.id, 'otro');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Listo, anotado el otro tema.');
    expect(llm.calls).toHaveLength(0);
  });

  // ── CHAT-N-MENU-06: lenguaje natural equivalente a una opción ───────────────

  it('CHAT-N-MENU-06: respuesta en lenguaje natural la mapea el LLM (interpretMenuChoice) y enruta', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    menuChoiceAnswer = 'reclamo';
    const res = await simulate(phone, tenant.id, 'se me rompió la impresora y necesito que alguien me ayude');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Elegí el tipo de reclamo');
    // Se gastó la llamada al clasificador de menú (nunca en el camino de match literal).
    expect(
      llm.calls.some((c) => c.messages[0]?.content.includes('clasificador de intención para un menú de opciones')),
    ).toBe(true);
  });

  // ── CHAT-N-MENU-07: cancelación coloquial interpretada por el LLM ───────────

  it('CHAT-N-MENU-07: cancelación coloquial la interpreta el LLM y cierra la gestión', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    menuChoiceAnswer = 'CANCELAR';
    // A propósito con palabras de CANCEL_HINT_WORDS ('dejalo', 'no quiero'): dispara TAMBIÉN el
    // gate de cierre de charla completa (paso 3.5 de handleMessage, ANTES de executeFlow). El
    // dispatch responde SEGUIR para ese clasificador, así que el gate no interfiere y lo que se
    // verifica es la cancelación DEL MENÚ (cancelInteraction), con su propio texto — distinto del
    // de cierre de charla completa ("Listo, cerré la charla...").
    const res = await simulate(phone, tenant.id, 'mejor dejalo, no quiero seguir con esto');

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe('Listo, cancelé la gestión. Decime si necesitás otra cosa.');

    const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect(conv?.status).toBe('closed');
    expect(conv?.currentFlowId).toBeNull();
    expect(conv?.currentNodeId).toBeNull();
  });

  // ── CHAT-N-MENU-08: sin match ni cancelación → fallback LLM ─────────────────

  it('CHAT-N-MENU-08: respuesta que no matchea ninguna opción ni es cancelación entra en fallback LLM (menú secuestrado)', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    orchestratorAnswer = 'Entendido, te ayudo con tu consulta general.';
    const res = await simulate(phone, tenant.id, 'asdkjaskjd zzzz sin sentido');

    expect(res.status).toBe(201);
    expect(res.body.reply).toBe(orchestratorAnswer);

    let conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect(conv?.status).toBe('active'); // no cierra: waitForInput sigue esperando.
    expect((conv?.flowState as any)?.__llmFallback).toBe('menuRoot');

    // El siguiente mensaje NO vuelve a mostrar el menú: va directo al LLM.
    orchestratorAnswer = 'Segunda respuesta libre del LLM.';
    const callsBefore = llm.calls.length;
    const res2 = await simulate(phone, tenant.id, 'otra pregunta random sin relación con el menú');

    expect(res2.body.reply).toBe(orchestratorAnswer);
    expect(res2.body.reply).not.toContain('¿En qué te ayudamos?');
    const newCalls = llm.calls.slice(callsBefore);
    // No se re-evaluó el menú: ninguna llamada nueva es al clasificador `interpretMenuChoice`.
    expect(newCalls.every((c) => !c.messages[0]?.content.includes('clasificador de intención para un menú de opciones'))).toBe(true);
    expect(newCalls.some((c) => c.messages[0]?.content.includes('Eres un orquestador de soporte técnico'))).toBe(true);

    conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect((conv?.flowState as any)?.__llmFallback).toBe('menuRoot'); // se mantiene secuestrado.
  });

  // ── CHAT-N-MENU-09: el LLM falla al interpretar → mismo camino que 08 ───────

  it('CHAT-N-MENU-09: si el LLM falla al interpretar la opción no corta la charla — cae al fallback LLM igual que sin match', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    llm.setFailure(); // interpretMenuChoice Y orchestratorLlm van a tirar (mismo mock).
    const res = await simulate(phone, tenant.id, 'no entiendo qué opción elegir, tengo un problema raro');

    expect(res.status).toBe(201);
    // interpretMenuChoice atrapa el error y devuelve {cancel:false} (silencioso, sin log de
    // error) → cae al fallback → orchestratorLlm TAMBIÉN tira, pero SÍ tiene su propio catch
    // final (es la respuesta al usuario, no puede quedar sin nada) y devuelve la disculpa fija.
    expect(res.body.reply).toBe(
      'Perdón, tuve un problema para responderte. ¿Podés reformular tu consulta o intentar de nuevo en un momento?',
    );

    const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect(conv?.status).toBe('active'); // no se corta la charla por la falla del proveedor.
    expect((conv?.flowState as any)?.__llmFallback).toBe('menuRoot');
  });

  // ── CHAT-N-MENU-10: opción sin arista con targetNodeId ──────────────────────

  it('CHAT-N-MENU-10: opción con sourceHandle sin arista pero con targetNodeId enruta por targetNodeId', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    // 'estado' es la opción 1; mainMenuEdges() NO tiene arista con sourceHandle 'estado'.
    const res = await simulate(phone, tenant.id, '1');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Acá tenés tu estado.');
  });

  // ── CHAT-N-MENU-11 / 12: "Volver" sintético según la pila ───────────────────

  it('CHAT-N-MENU-11: submenú al que se llegó eligiendo una opción ofrece automáticamente "Volver"', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    const res = await simulate(phone, tenant.id, '2'); // 'reclamo' → submenu

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Elegí el tipo de reclamo');
    // submenu tiene 2 opciones propias + Volver = 3 → sigue en botones.
    expect(res.body.reply).toContain('3. Volver');
    expect(numberedLines(res.body.reply)).toHaveLength(3);
  });

  it('CHAT-N-MENU-12: el menú raíz (pila vacía) no ofrece "Volver"', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());

    const res = await simulate(phone, tenant.id, 'hola');

    expect(res.status).toBe(201);
    expect(res.body.reply).not.toContain('Volver');
    expect(numberedLines(res.body.reply)).toHaveLength(3);
  });

  // ── CHAT-N-MENU-13: elegir "Volver" desapila y regresa ──────────────────────

  it('CHAT-N-MENU-13: elegir "Volver" por label literal desapila el tope y regresa a ese menú (sin Volver, pila vacía otra vez)', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');
    const enSubmenu = await simulate(phone, tenant.id, '2'); // → submenu, ofrece Volver
    expect(enSubmenu.body.reply).toContain('3. Volver');

    const res = await simulate(phone, tenant.id, 'Volver');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('¿En qué te ayudamos?');
    expect(res.body.reply).not.toContain('Volver'); // pila quedó vacía: es el menú raíz otra vez.

    const conv = await t.prisma.conversation.findFirst({ where: { userId: (await t.prisma.user.findFirst({ where: { phone } }))!.id } });
    expect(conv?.currentNodeId).toBe('menuRoot');
  });

  it('CHAT-N-MENU-13: elegir "Volver" en lenguaje natural ("volvamos") lo interpreta el LLM y desapila igual', async () => {
    const { phone, tenant } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');
    await simulate(phone, tenant.id, '2'); // → submenu

    // "volvamos" NO matchea literal (ni value/label/índice) y tampoco contiene la palabra suelta
    // 'volver' de CANCEL_HINT_WORDS (evita a propósito el gate de cierre de charla, ya cubierto
    // en el caso anterior): cae a interpretMenuChoice.
    menuChoiceAnswer = '__volver';
    const res = await simulate(phone, tenant.id, 'mejor volvamos al menú anterior');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('¿En qué te ayudamos?');
    expect(res.body.reply).not.toContain('Volver');
  });

  it('CHAT-N-MENU-13: si el menú anterior es de otro flujo (llegado por subflow), "Volver" cruza el límite y cambia de flujo', async () => {
    // Flow B: un único menú, referenciado por id/entryNodeId desde el nodo `subflow` de A.
    const flowB = await createFlow(t.prisma, {
      name: uniqueSlug('flow-b-subflow'),
      nodes: [menuNode('menuB', { text: 'Menú B (subflujo)', options: [{ value: 'x', label: 'Opción X' }] })],
      edges: [],
    });

    const nodesA: FlowNode[] = [
      startNode('s'),
      menuNode('menuA', {
        text: 'Menú A',
        options: [{ value: 'sub', label: 'Ir a subflujo', targetNodeId: 'toSub' }],
      }),
      subflowNode('toSub', { flowId: flowB.id, entryNodeId: 'menuB' }),
    ];
    const { phone, tenant, flowId: flowAId } = await setupMenuFlow(nodesA, [edge('s', 'menuA', 'known')]);

    await simulate(phone, tenant.id, 'hola');
    const enB = await simulate(phone, tenant.id, 'sub'); // menuA → subflow → menuB (mismo request)
    expect(enB.body.reply).toContain('Menú B (subflujo)');
    expect(enB.body.reply).toContain('Volver'); // pila no vacía: viene de menuA (Flow A)

    const res = await simulate(phone, tenant.id, 'Volver');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Menú A');
    expect(res.body.reply).not.toContain('Volver'); // de vuelta en la raíz de A: pila vacía otra vez.

    const user = await t.prisma.user.findFirst({ where: { phone } });
    const conv = await t.prisma.conversation.findFirst({ where: { userId: user!.id } });
    // Prueba directa de que cruzó el límite de flujo: quedó parada en A, no en B.
    expect(conv?.currentFlowId).toBe(flowAId);
    expect(conv?.currentNodeId).toBe('menuA');
  });

  // ── CHAT-N-MENU-14: 10 opciones + Volver = 11 → cae a texto plano ───────────

  it('CHAT-N-MENU-14: un menú con 10 opciones al que se le suma "Volver" (11) cae a texto plano numerado', async () => {
    const options10 = Array.from({ length: 10 }, (_, i) => ({ value: `o${i + 1}`, label: `Opción ${i + 1}` }));
    const nodes: FlowNode[] = [
      startNode('s'),
      menuNode('menuA', { text: 'Menú A', options: [{ value: 'go', label: 'Ir al menú grande' }] }),
      menuNode('menuB', { text: 'Menú con 10 opciones', options: options10 }),
    ];
    const { phone, tenant } = await setupMenuFlow(nodes, [edge('s', 'menuA', 'known'), edge('menuA', 'menuB', 'go')]);

    await simulate(phone, tenant.id, 'hola'); // menuA (1 opción, botones)
    const res = await simulate(phone, tenant.id, '1'); // → menuB con pila no vacía → 10+Volver=11

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Menú con 10 opciones');
    expect(res.body.reply).toContain('11. Volver');
    expect(res.body.reply).toContain('5. Opción 5'); // texto plano: labels enteros, sin truncar.
    // 11 líneas numeradas → un solo camino de render (si se hubiese armado interactivo Y texto a
    // la vez, por un bug, se duplicarían las líneas).
    expect(numberedLines(res.body.reply)).toHaveLength(11);
  });

  // ── CHAT-N-MENU-15: en fallback LLM, una opción exacta sale del LLM libre ────
  // Verificado en `case 'menu'`: con `__llmFallback === node.id`, un `body.trim()` que iguale
  // EXACTO un `value`, `label` o el índice (`String(idx+1)`) —o "Volver"— limpia `__llmFallback`
  // y deja que el matching normal procese la selección; si no iguala, sigue en `orchestratorLlm`.

  it('CHAT-N-MENU-15: en __llmFallback, una opción exacta (número) limpia el fallback y procesa la selección; una respuesta no exacta sigue en LLM libre', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');

    // Secuestro del menú: un mensaje sin match ni cancelación entra en fallback LLM (CHAT-N-MENU-08).
    orchestratorAnswer = 'Te ayudo con tu consulta general.';
    await simulate(phone, tenant.id, 'xyz algo sin sentido');
    let conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect((conv?.flowState as any)?.__llmFallback).toBe('menuRoot');

    // Respuesta NO exacta: sigue en LLM libre, NO procesa ninguna opción.
    orchestratorAnswer = 'Sigo en LLM libre.';
    const noExacto = await simulate(phone, tenant.id, 'otra cosa random poco clara');
    expect(noExacto.body.reply).toBe('Sigo en LLM libre.');
    conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect((conv?.flowState as any)?.__llmFallback).toBe('menuRoot'); // sigue secuestrado

    // Opción EXACTA por número ('3' = 'otro'): match estricto → limpia el fallback y enruta.
    const res = await simulate(phone, tenant.id, '3');
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Listo, anotado el otro tema.'); // procesó la selección
    conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    // La opción 'otro' llega a un `end` → la charla cierra y `closeConversation` deja flowState en null.
    expect((conv?.flowState as any)?.__llmFallback).toBeUndefined(); // salió del LLM libre
  });

  it('CHAT-N-MENU-15: en __llmFallback dentro de un submenú, tipear "Volver" (label exacto) sale del LLM libre y desapila al menú anterior', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    await simulate(phone, tenant.id, 'hola');
    await simulate(phone, tenant.id, '2'); // reclamo → submenu (pila = [menuRoot], ofrece Volver)

    orchestratorAnswer = 'Consulta libre en el submenú.';
    await simulate(phone, tenant.id, 'xyz sin match en el submenu');
    let conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect((conv?.flowState as any)?.__llmFallback).toBe('submenu');

    // "Volver" iguala EXACTO el label de la opción sintética → sale del fallback y desapila.
    // (El gate de cierre de charla evalúa 'Volver' pero el dispatch responde SEGUIR, así que no cierra.)
    const res = await simulate(phone, tenant.id, 'Volver');
    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('¿En qué te ayudamos?'); // de vuelta en el menú raíz
    expect(res.body.reply).not.toContain('Volver'); // raíz: pila vacía, sin Volver

    conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect((conv?.flowState as any)?.__llmFallback).toBeUndefined();
    expect(conv?.currentNodeId).toBe('menuRoot');
  });

  // ── CHAT-N-MENU-16: el botón "Volver" (__volver) no dispara el cierre de charla ─
  // Verificado en `looksLikeCancelAttempt`: excluye por igualdad exacta el id `__volver` (antes
  // matcheaba por substring contra la palabra 'volver' de CANCEL_HINT_WORDS). El clasificador de
  // cierre se programa en CERRAR para probar por contraste que con el botón NUNCA se consulta.

  it('CHAT-N-MENU-16: elegir el botón "Volver" (id __volver) con una gestión abierta NO dispara el cierre de charla; desapila normalmente', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    // Si el gate de cierre se consultara, este clasificador diría CERRAR y cortaría la charla.
    llm.setResponder((messages) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('cerrar o reiniciar la charla completa')) return 'CERRAR';
      return 'NINGUNA';
    });
    await simulate(phone, tenant.id, 'hola');
    await simulate(phone, tenant.id, '2'); // → submenu, ofrece Volver

    const callsBefore = llm.calls.length;
    const res = await simulate(phone, tenant.id, '__volver'); // id EXACTO del botón sintético

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('¿En qué te ayudamos?'); // desapiló al raíz, no cerró
    // looksLikeCancelAttempt excluye el id exacto __volver → el clasificador de cierre nunca se consultó.
    const newCalls = llm.calls.slice(callsBefore);
    expect(newCalls.every((c) => !(c.messages[0]?.content ?? '').includes('cerrar o reiniciar la charla completa'))).toBe(true);

    const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect(conv?.status).toBe('active'); // la charla sigue abierta
    expect(conv?.currentNodeId).toBe('menuRoot');
  });

  it('CHAT-N-MENU-16: escribir "volver" a mano SÍ evalúa el cierre de charla (looksLikeCancelAttempt matchea la palabra suelta)', async () => {
    const { phone, tenant, user } = await setupMenuFlow(mainMenuNodes(), mainMenuEdges());
    llm.setResponder((messages) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      if (sys.includes('cerrar o reiniciar la charla completa')) return 'CERRAR';
      return 'NINGUNA';
    });
    await simulate(phone, tenant.id, 'hola');
    await simulate(phone, tenant.id, '2'); // → submenu

    const callsBefore = llm.calls.length;
    const res = await simulate(phone, tenant.id, 'volver'); // texto a mano, NO el id del botón

    expect(res.status).toBe(201);
    // Acá SÍ se evalúa el cierre: el gate matcheó 'volver' → confirmEndChatIntent → CERRAR → cierra.
    const newCalls = llm.calls.slice(callsBefore);
    expect(newCalls.some((c) => (c.messages[0]?.content ?? '').includes('cerrar o reiniciar la charla completa'))).toBe(true);
    expect(res.body.reply).toBe('Listo, cerré la charla. Escribime cuando necesites algo más.');

    const conv = await t.prisma.conversation.findFirst({ where: { userId: user.id } });
    expect(conv?.status).toBe('closed');
  });
});
