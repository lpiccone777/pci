import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Cliente MCP mínimo para `ContextSourceConnectorService`: abre una sesión contra un
 * servidor MCP remoto (handshake `initialize` del protocolo, lo hace `Client.connect`),
 * ejecuta lo que haga falta (`tools/list`, `tools/call`) y la cierra. Una sesión por
 * operación, sin pool: las consultas son esporádicas (una por mensaje que se sale del
 * flujo) y así no hay sesiones colgadas si el servidor se reinicia entre medio.
 *
 * Usa el SDK oficial (`@modelcontextprotocol/sdk`) en vez de hablar JSON-RPC a mano:
 * cubre los dos transportes del catálogo (`transport: 'sse' | 'http'`) con sus
 * detalles (endpoint anunciado por el stream SSE, `Mcp-Session-Id`, respuestas en
 * JSON o en stream), que son justamente lo que se rompe si se reimplementa.
 */

/** Tool tal como la anuncia el servidor en `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Tool configurada en la conexión (`config.tools` del tipo `mcp`, ver el catálogo).
 * `arguments` es una plantilla: cualquier string que contenga `{{pregunta}}` se
 * reemplaza por el texto del usuario antes de invocarla.
 */
export interface McpToolConfig {
  name: string;
  arguments?: Record<string, unknown>;
}

export const MCP_QUESTION_PLACEHOLDER = '{{pregunta}}';

/** Tope por resultado de tool: va entero a un system prompt, no puede ser ilimitado. */
const MAX_TOOL_RESULT_CHARS = 8_000;

/** Tope de páginas de `tools/list` (un servidor con cursor roto no nos deja en loop). */
const MAX_LIST_PAGES = 20;

export function mcpAuthHeaders(config: Record<string, unknown>): Record<string, string> {
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey : '';
  if (!apiKey) return {};
  if (config.authType === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  if (config.authType === 'apiKey') return { 'x-api-key': apiKey };
  return {};
}

/**
 * Corre `fn` dentro de una sesión MCP abierta contra `config.serverUrl`. `timeoutMs`
 * es el presupuesto TOTAL (handshake + lo que haga `fn`): `remaining()` le dice a
 * cada request cuánto le queda, así la operación entera nunca pasa del timeout con
 * el que el connector responde por RPC.
 */
export async function withMcpSession<T>(
  config: Record<string, unknown>,
  timeoutMs: number,
  fn: (client: Client, remaining: () => number) => Promise<T>,
): Promise<T> {
  const rawUrl = typeof config.serverUrl === 'string' ? config.serverUrl.trim() : '';
  if (!rawUrl) throw new Error('Falta la URL del servidor MCP');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL del servidor MCP inválida: "${rawUrl}"`);
  }

  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`Sin respuesta del servidor MCP después de ${timeoutMs}ms`);
    return left;
  };

  const requestInit: RequestInit = { headers: mcpAuthHeaders(config) };
  const transport: Transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit })
      : new SSEClientTransport(url, { requestInit });

  const client = new Client({ name: 'pci-chatbot', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: remaining() });
    return await fn(client, remaining);
  } finally {
    // `close` aborta cualquier fetch/stream pendiente — también si `fn` tiró por timeout.
    await client.close().catch(() => undefined);
  }
}

export async function listMcpTools(client: Client, remaining: () => number): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: remaining() });
    for (const t of res.tools) {
      tools.push({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/**
 * Invoca una tool configurada con la pregunta interpolada y devuelve su resultado
 * como texto plano, listo para inyectar en el prompt. Tira si la tool reporta error
 * (`isError`) o si no devolvió nada legible.
 */
export async function callMcpTool(
  client: Client,
  tool: McpToolConfig,
  question: string,
  remaining: () => number,
): Promise<string> {
  const args = interpolateQuestion(tool.arguments ?? {}, question) as Record<string, unknown>;
  const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: remaining() });

  const text = toolResultToText(result);
  if (result.isError) throw new Error(text || 'la tool devolvió error sin detalle');
  if (!text) throw new Error('la tool respondió sin contenido de texto');
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[…resultado recortado]` : text;
}

/** Reemplaza `{{pregunta}}` en todos los strings de la plantilla, a cualquier profundidad. */
export function interpolateQuestion(value: unknown, question: string): unknown {
  if (typeof value === 'string') return value.split(MCP_QUESTION_PLACEHOLDER).join(question);
  if (Array.isArray(value)) return value.map((v) => interpolateQuestion(v, question));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateQuestion(v, question)]),
    );
  }
  return value;
}

/**
 * Aplana el `CallToolResult` a texto: bloques `text` tal cual, recursos embebidos con
 * texto también; imágenes/audio no sirven para un prompt de texto y se omiten con una
 * marca. Si no hay ningún bloque de texto pero sí `structuredContent`, va como JSON.
 */
function toolResultToText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? (result.content as Array<Record<string, any>>) : [];
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push(block.resource.text);
    else if (block.type === 'resource_link' && typeof block.uri === 'string') parts.push(`[recurso: ${block.uri}]`);
    else if (block.type === 'image' || block.type === 'audio') parts.push(`[${block.type} omitido]`);
  }
  const text = parts.join('\n').trim();
  if (text) return text;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return JSON.stringify(result.structuredContent);
  }
  // SDKs viejos devuelven `{ toolResult }` en vez de `content` (CompatibilityCallToolResult).
  if (result.toolResult !== undefined) {
    return typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
  }
  return '';
}

/**
 * Normaliza `config.tools` tal como llega del body (o de la base): descarta basura en
 * vez de romper. La validación estricta, con mensaje al usuario, la hace
 * `ContextSourcesService` al guardar — esto es la red de seguridad del lado del connector.
 */
export function readConfiguredTools(config: Record<string, unknown>): McpToolConfig[] {
  const raw = Array.isArray(config.tools) ? config.tools : [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .filter((t) => typeof t.name === 'string' && t.name.trim() !== '')
    .map((t) => ({
      name: String(t.name).trim(),
      arguments:
        t.arguments && typeof t.arguments === 'object' && !Array.isArray(t.arguments)
          ? (t.arguments as Record<string, unknown>)
          : {},
    }));
}
