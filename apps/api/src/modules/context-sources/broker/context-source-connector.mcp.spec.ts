/**
 * Conexión MCP de `ContextSourceConnectorService` contra un servidor MCP REAL levantado en
 * proceso con el propio SDK (`Server` de bajo nivel, sin zod), en los dos transportes del
 * catálogo: Streamable HTTP (`transport: 'http'`) y SSE (`transport: 'sse'`).
 *
 * Frontera mockeada: solo `BrokerService` (el RPC por RabbitMQ no es lo que se prueba acá;
 * se llama directo a `testConnection`/`query`/`listMcpTools`, que es lo que corre el
 * consumidor de cada cola). El protocolo MCP, el HTTP y el auth van de verdad.
 */
import { ContextSourceConnectorService } from './context-source-connector.service';
import { interpolateQuestion } from './mcp-client';
import { FAKE_MCP_API_KEY as API_KEY, startFakeMcp } from '../../../../test/support/fake-mcp-server';

describe('ContextSourceConnectorService — MCP', () => {
  let fake: { baseUrl: string; close: () => Promise<void> };
  let connector: any;

  beforeAll(async () => {
    fake = await startFakeMcp();
    connector = new ContextSourceConnectorService({} as never);
  });

  afterAll(async () => {
    await fake.close();
  });

  const transports = [
    { transport: 'http', path: '/mcp' },
    { transport: 'sse', path: '/sse' },
  ];

  describe.each(transports)('transporte $transport', ({ transport, path }) => {
    const baseConfig = () => ({
      serverUrl: `${fake.baseUrl}${path}`,
      transport,
      authType: 'bearer',
      apiKey: API_KEY,
    });

    it('lista las tools del servidor', async () => {
      const res = await connector.listMcpTools(baseConfig());
      expect(res.ok).toBe(true);
      expect(res.tools.map((t: { name: string }) => t.name)).toEqual(['buscar_kb', 'horarios', 'rota']);
      expect(res.tools[0].inputSchema.required).toEqual(['query']);
    });

    it('probar conexión: ok y detecta tools configuradas que no existen', async () => {
      const ok = await connector.testConnection('mcp', {
        ...baseConfig(),
        tools: [{ name: 'buscar_kb', arguments: { query: '{{pregunta}}' } }],
      });
      expect(ok.ok).toBe(true);
      expect(ok.message).toContain('"kb-de-prueba"');
      expect(ok.message).toContain('configuradas: buscar_kb');

      const missing = await connector.testConnection('mcp', { ...baseConfig(), tools: [{ name: 'no_existe' }] });
      expect(missing.ok).toBe(false);
      expect(missing.message).toContain('no existen: no_existe');
    });

    it('consulta con una tool: devuelve su texto con la pregunta interpolada', async () => {
      const res = await connector.query(
        'mcp',
        { ...baseConfig(), tools: [{ name: 'buscar_kb', arguments: { query: '{{pregunta}}' } }] },
        '¿cómo reseteo la clave?',
      );
      expect(res).toMatchObject({ ok: true, answer: 'KB: resultado para "¿cómo reseteo la clave?"' });
    });

    it('consulta con varias tools: junta los resultados y tolera una que falla', async () => {
      const res = await connector.query(
        'mcp',
        {
          ...baseConfig(),
          tools: [
            { name: 'buscar_kb', arguments: { query: 'Consulta: {{pregunta}}' } },
            { name: 'horarios', arguments: { sede: 'Centro' } },
            { name: 'rota' },
          ],
        },
        'horario',
      );
      expect(res.ok).toBe(true);
      expect(res.answer).toBe('### buscar_kb\nKB: resultado para "Consulta: horario"\n\n### horarios\nSede Centro: 9 a 18');
      expect(res.message).toContain('Respondieron 2/3');
      expect(res.message).toContain('rota: explotó adentro de la tool');
    });
  });

  it('sin credenciales el servidor rechaza y se informa ok:false', async () => {
    const res = await connector.testConnection('mcp', { serverUrl: `${fake.baseUrl}/mcp`, transport: 'http' });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/401/);
  });

  it('sin tools configuradas la consulta no abre conexión', async () => {
    const res = await connector.query('mcp', { serverUrl: 'http://127.0.0.1:1/mcp', transport: 'http' }, 'x');
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining('ninguna tool configurada') });
  });

  it('servidor inalcanzable: ok:false sin tirar', async () => {
    const res = await connector.query(
      'mcp',
      { serverUrl: 'http://127.0.0.1:1/mcp', transport: 'http', tools: [{ name: 'buscar_kb' }] },
      'x',
    );
    expect(res.ok).toBe(false);
  });

  it('interpolateQuestion reemplaza a cualquier profundidad y no toca otros tipos', () => {
    expect(
      interpolateQuestion({ q: '{{pregunta}}', n: 5, nested: { list: ['a {{pregunta}}', true] } }, 'hola'),
    ).toEqual({ q: 'hola', n: 5, nested: { list: ['a hola', true] } });
  });
});
