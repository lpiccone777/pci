/**
 * Servidor MCP REAL (SDK oficial, `Server` de bajo nivel, sin zod) para tests: expone
 * los dos transportes del catálogo — `/mcp` (Streamable HTTP) y `/sse` + `/messages`
 * (SSE legado) — y exige `Authorization: Bearer <FAKE_MCP_API_KEY>`. Tools:
 * `buscar_kb({query})`, `horarios({sede})` y `rota` (siempre `isError`).
 *
 * Lo usan el spec unitario del connector y el e2e de context-sources (BE-CS-16).
 */
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const FAKE_MCP_API_KEY = 'secreto-de-prueba';

function buildMcpServer(): Server {
  const server = new Server({ name: 'kb-de-prueba', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'buscar_kb',
        description: 'Busca en la base de conocimiento',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      {
        name: 'horarios',
        description: 'Horarios de atención de una sede',
        inputSchema: { type: 'object', properties: { sede: { type: 'string' } } },
      },
      { name: 'rota', description: 'Siempre falla', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (req.params.name) {
      case 'buscar_kb':
        return { content: [{ type: 'text', text: `KB: resultado para "${String(args.query)}"` }] };
      case 'horarios':
        return { content: [{ type: 'text', text: `Sede ${String(args.sede)}: 9 a 18` }] };
      case 'rota':
        return { isError: true, content: [{ type: 'text', text: 'explotó adentro de la tool' }] };
      default:
        throw new Error(`tool desconocida: ${req.params.name}`);
    }
  });
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Servidor HTTP con los dos transportes: `/mcp` (Streamable HTTP, stateful) y
 * `/sse` + `/messages` (SSE legado). Exige `Authorization: Bearer <FAKE_MCP_API_KEY>`.
 */
export function startFakeMcp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const sse = new Map<string, SSEServerTransport>();

  const http: HttpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${FAKE_MCP_API_KEY}`) {
      res.writeHead(401).end('no autorizado');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/mcp') {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? streamable.get(sessionId) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => streamable.set(id, transport!),
        });
        await buildMcpServer().connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (url.pathname === '/sse' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res);
      sse.set(transport.sessionId, transport);
      res.on('close', () => sse.delete(transport.sessionId));
      await buildMcpServer().connect(transport);
      return;
    }
    if (url.pathname === '/messages' && req.method === 'POST') {
      const transport = sse.get(url.searchParams.get('sessionId') ?? '');
      if (!transport) {
        res.writeHead(404).end();
        return;
      }
      await transport.handlePostMessage(req, res, await readJson(req));
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            http.closeAllConnections();
            http.close(() => r());
          }),
      });
    });
  });
}
