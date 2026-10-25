/**
 * Tools de la fuente de verdad para el LLM del flujo (contrato C61) — SRC-TOOLS-*
 *
 * Con una fuente MCP, el LLM del flujo (`llm_query` en modo charla y el de respaldo,
 * `orchestratorLlm`) recibe como tools las configuradas en la fuente, elige tool y argumentos y
 * encadena hasta 3 vueltas; los valores fijos de la configuración los inyecta pci.
 *
 * Todo el viaje es real salvo el modelo: motor → `ContextSourcesService.mcpToolsetForLlm` →
 * broker (RPC `context-source.mcp.list-tools` y `context-source.mcp.call-tool`) → connector →
 * servidor MCP REAL en loopback (`fake-mcp-server.ts` con las tools de clima). El modelo es un
 * guion (`weatherToolScript`) que corre dentro del loop real (`runToolLoop`).
 */
import { LlmService } from '../src/modules/llm/llm.service';
import { SecretsCipher } from '../src/config/secrets.cipher';
import {
  createTestApp,
  TestApp,
  http,
  createTenant,
  createRole,
  createUser,
  createFlow,
  createContextSource,
  uniqueSlug,
  uniqueEmail,
  uniquePhone,
  FakeLlmService,
  weatherToolScript,
  startNode,
  llmQueryNode,
  menuNode,
  messageNode,
  edge,
} from './support';
import { FAKE_MCP_API_KEY, startFakeMcp } from './support/fake-mcp-server';

describe('Tools de la fuente de verdad para el LLM del flujo (SRC-TOOLS-*)', () => {
  let t: TestApp;
  let llm: FakeLlmService;
  let cipher: SecretsCipher;
  let fake: { baseUrl: string; close: () => Promise<void> };

  const simulate = (from: string, tenantId: string, body: string) =>
    http(t).post('/conversations/simulate').set('Authorization', `Bearer ${t.authToken}`).send({ from, body, tenantId });

  async function newKnownUser(label: string) {
    const tenant = await createTenant(t.prisma, { slug: uniqueSlug(label) });
    const role = await createRole(t.prisma, { tenantId: tenant.id, name: 'Rol' });
    const phone = uniquePhone();
    await createUser(t.prisma, { email: uniqueEmail(label), phone, firstName: 'Uso', memberships: [{ tenantId: tenant.id, roleId: role.id }] });
    return { tenant, role, phone };
  }

  /** Fuente "clima" como la del usuario, bien configurada: fijos `count`, `language`, la unidad y los días. */
  const weatherSource = (tenantId: string) =>
    createContextSource(t.prisma, {
      tenantId,
      name: 'clima',
      type: 'mcp',
      config: {
        serverUrl: `${fake.baseUrl}/mcp`,
        transport: 'http',
        authType: 'bearer',
        apiKey: cipher.encrypt(FAKE_MCP_API_KEY),
        tools: [
          { name: 'geocoding', arguments: { name: '{{pregunta}}', count: 1, language: 'es' } },
          { name: 'weather_forecast', arguments: { latitude: 0, longitude: 0, temperature_unit: 'celsius', forecast_days: 2 } },
        ],
      },
    });

  beforeAll(async () => {
    fake = await startFakeMcp({ weather: true });
    llm = new FakeLlmService();
    t = await createTestApp({ customize: (b) => b.overrideProvider(LlmService).useValue(llm) });
    cipher = t.moduleRef.get(SecretsCipher, { strict: false });
  });

  afterAll(async () => {
    await t.close();
    await fake.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  it('SRC-TOOLS-01: llm_query (charla) encadena geocoding → weather_forecast; el LLM no ve los fijos y pci los inyecta', async () => {
    const { tenant, role, phone } = await newKnownUser('tools01');
    const source = await weatherSource(tenant.id);
    await createFlow(t.prisma, {
      name: `F-${uniqueSlug('tools01')}`,
      contextSourceId: source.id,
      nodes: [startNode('s'), llmQueryNode('q', { systemPrompt: 'Sos el asistente del clima.' })],
      edges: [edge('s', 'q', 'known')],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    const script = weatherToolScript();
    llm.setToolProvider(script.provider);

    const res = await simulate(phone, tenant.id, '¿qué tiempo va a hacer mañana en Merlo?');

    expect(res.status).toBe(201);
    // Coordenadas de geocoding, y la unidad y los días de la configuración (el LLM pidió kelvin).
    expect(res.body.reply).toContain('Según la fuente: Pronóstico en -34.66536,-58.72744 (celsius, 2 días)');
    expect(llm.calls).toHaveLength(0); // sin `chat()`: ni pre-consulta ni llamada aparte

    expect(script.steps).toHaveLength(3); // geocoding, forecast, respuesta
    const tools = script.steps[0].tools;
    expect(tools.map((x) => x.name)).toEqual(['geocoding', 'weather_forecast']);
    const props = (name: string) => Object.keys((tools.find((x) => x.name === name)!.parameters.properties ?? {}) as object);
    expect(props('geocoding')).toEqual(['name']); // `{{pregunta}}` lo completa el LLM; count/language son fijos
    expect(props('weather_forecast')).toEqual(['latitude', 'longitude']); // 0 no es fijo; unidad y días sí
    expect(tools[0].description).toContain('coordenadas');

    const sys = script.steps[0].messages[0];
    expect(sys.role).toBe('system');
    expect(sys.content).toContain('Sos el asistente del clima.');
    expect(sys.content).toContain('fuente de verdad "clima"');
  });

  it('SRC-TOOLS-02: el LLM de respaldo (orchestratorLlm) también opera la fuente con tools', async () => {
    const { tenant, role, phone } = await newKnownUser('tools02');
    const source = await weatherSource(tenant.id);
    await createFlow(t.prisma, {
      name: `F-${uniqueSlug('tools02')}`,
      contextSourceId: source.id,
      nodes: [
        startNode('s'),
        menuNode('m', { text: 'Elegí:', options: [{ value: 'a', label: 'Soporte' }, { value: 'b', label: 'Ventas' }] }),
        messageNode('ma', 'A'),
        messageNode('mb', 'B'),
      ],
      edges: [edge('s', 'm', 'known'), edge('m', 'ma', 'a'), edge('m', 'mb', 'b')],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    // El clasificador del menú dice que el mensaje no es ninguna opción → charla con el LLM de respaldo.
    llm.setResponder(() => 'NINGUNA');
    const script = weatherToolScript({ finalText: (f) => `Respaldo: ${f}` });
    llm.setToolProvider(script.provider);

    await simulate(phone, tenant.id, 'hola');
    const res = await simulate(phone, tenant.id, '¿llueve mañana en Merlo?');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('Respaldo: Pronóstico en -34.66536,-58.72744 (celsius, 2 días)');
    expect(script.steps.map((s) => s.turns.length)).toEqual([0, 2, 4]);
  });

  it('SRC-TOOLS-03: sin tool calling en el proveedor (OpenCode Go) sigue la pre-consulta de siempre', async () => {
    const { tenant, role, phone } = await newKnownUser('tools03');
    const source = await weatherSource(tenant.id);
    await createFlow(t.prisma, {
      name: `F-${uniqueSlug('tools03')}`,
      contextSourceId: source.id,
      nodes: [startNode('s'), llmQueryNode('q')],
      edges: [edge('s', 'q', 'known')],
      assign: [{ tenantId: tenant.id, isStart: true, roleIds: [role.id] }],
    });
    llm.setReply('respuesta sin tools');

    const res = await simulate(phone, tenant.id, 'Merlo');

    expect(res.status).toBe(201);
    expect(res.body.reply).toContain('respuesta sin tools');
    expect(llm.toolChats).toHaveLength(0);
    // La pre-consulta llamó a las dos tools con la plantilla: geocoding encontró "Merlo" y el
    // pronóstico con 0,0 respondió (como antes de C61).
    const sys = llm.calls[llm.calls.length - 1].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('### geocoding');
    expect(sys).toContain('Pronóstico en 0,0 (celsius, 2 días)');
  });
});
