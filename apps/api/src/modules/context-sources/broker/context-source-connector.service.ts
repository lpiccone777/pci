import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BrokerService, BrokerMessage } from '../../broker/broker.service';
import { McpToolInfo, callMcpTool, listMcpTools, readConfiguredTools, withMcpSession } from './mcp-client';

/** Cola RPC de "probar conexión". Ver AGENTS.md § Broker / RabbitMQ — patrón RPC. */
export const CONTEXT_SOURCE_TEST_QUEUE = 'context-source.test-connection';

/**
 * Cola RPC de consulta real, disparada por `ConversationsService` cuando una charla
 * se sale del flujo armado y hay una fuente de verdad vinculada (`Flow.contextSourceId`).
 * Cola separada de `CONTEXT_SOURCE_TEST_QUEUE` a propósito: mismo motivo de siempre
 * (AGENTS.md, "Desacople de canales") — el productor real (`ConversationsService`)
 * nunca importa este módulo directamente, solo publica y espera por el broker.
 */
export const CONTEXT_SOURCE_QUERY_QUEUE = 'context-source.query';

/**
 * Cola RPC de "descubrir tools" de un servidor MCP (`tools/list`), para que el
 * formulario de alta/edición ofrezca las tools reales del servidor en vez de que el
 * admin tipee los nombres a ciegas. Solo aplica al tipo `mcp`.
 */
export const CONTEXT_SOURCE_MCP_TOOLS_QUEUE = 'context-source.mcp.list-tools';

const TEST_TIMEOUT_MS = 20_000;
/** Más generoso que TEST_TIMEOUT_MS: acá puede haber un RAG "razonando" de verdad
 *  del otro lado, no solo un chequeo de alcanzabilidad. */
const QUERY_TIMEOUT_MS = 30_000;

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  statusCode?: number;
}

export interface McpToolsListResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  /** Presente solo si `ok`. */
  tools?: McpToolInfo[];
}

export interface ContextSourceQueryResult {
  ok: boolean;
  /** Presente solo si `ok`. */
  answer?: string;
  message: string;
  latencyMs: number;
}

/**
 * Único punto por donde el sistema habla con un MCP/RAG/n8n externo (por HTTP) o con
 * el consumidor de una fuente de tipo `broker` (por una cola propia de RabbitMQ).
 *
 * Respeta el constraint de AGENTS.md ("Desacople de canales: todo I/O externo pasa
 * por el broker"): en vez de que `ContextSourcesController` llame `fetch()`
 * directamente, publica un `BrokerService.request()` a `CONTEXT_SOURCE_TEST_QUEUE`
 * y este servicio —suscripto a esa cola desde `onModuleInit`, mismo patrón que
 * `ConversationsService` con `whatsapp.incoming`— hace la llamada real y responde
 * por el canal RPC (`msg.replyTo` + `correlationId`).
 *
 * Hoy productor y consumidor viven en el mismo proceso (este módulo), así que el
 * viaje por RabbitMQ es "de más" en términos de latencia — pero es la forma
 * correcta de dejar el punto de extensión ya armado para cuando la ejecución real
 * de una fuente de verdad se dispare desde `ConversationsService` (motor de
 * flujos), que si puede vivir en un proceso/worker separado. Ver
 * docs/plan-de-trabajo.md, sección "Fuentes de verdad — pendiente".
 *
 * `mcp` y `broker` hablan su protocolo completo (MCP: `initialize` → `tools/list` →
 * `tools/call`, ver `mcp-client.ts`). `rag`/`n8n` siguen con un chequeo de
 * alcanzabilidad HTTP, sin contrato de consulta definido — ver la misma sección de
 * pendientes.
 */
@Injectable()
export class ContextSourceConnectorService implements OnModuleInit {
  private readonly logger = new Logger(ContextSourceConnectorService.name);

  constructor(private readonly broker: BrokerService) {}

  async onModuleInit() {
    await this.broker.subscribe(CONTEXT_SOURCE_TEST_QUEUE, this.handleTestConnection.bind(this));
    await this.broker.subscribe(CONTEXT_SOURCE_QUERY_QUEUE, this.handleQuery.bind(this));
    await this.broker.subscribe(CONTEXT_SOURCE_MCP_TOOLS_QUEUE, this.handleListMcpTools.bind(this));
  }

  private async handleListMcpTools(msg: BrokerMessage): Promise<void> {
    const { config } = msg.data as { config: Record<string, unknown> };
    const result = await this.listMcpTools(config);

    if (!msg.replyTo) {
      this.logger.warn('Mensaje de mcp.list-tools sin replyTo: no hay a quién responderle');
      return;
    }

    await this.broker.publish(
      msg.replyTo,
      { pattern: 'context-source.mcp.list-tools.result', data: result, correlationId: msg.correlationId },
      { assert: false },
    );
  }

  private async handleTestConnection(msg: BrokerMessage): Promise<void> {
    const { type, config } = msg.data as { type: string; config: Record<string, unknown> };
    const result = await this.testConnection(type, config);

    if (!msg.replyTo) {
      this.logger.warn('Mensaje de test-connection sin replyTo: no hay a quién responderle');
      return;
    }

    await this.broker.publish(
      msg.replyTo,
      {
        pattern: 'context-source.test-connection.result',
        data: result,
        correlationId: msg.correlationId,
      },
      { assert: false },
    );
  }

  private async handleQuery(msg: BrokerMessage): Promise<void> {
    const { type, config, question } = msg.data as {
      type: string;
      config: Record<string, unknown>;
      question: string;
    };
    const result = await this.query(type, config, question);

    if (!msg.replyTo) {
      this.logger.warn('Mensaje de context-source.query sin replyTo: no hay a quién responderle');
      return;
    }

    await this.broker.publish(
      msg.replyTo,
      { pattern: 'context-source.query.result', data: result, correlationId: msg.correlationId },
      { assert: false },
    );
  }

  private async testConnection(type: string, config: Record<string, unknown>): Promise<ConnectionTestResult> {
    switch (type) {
      case 'mcp':
        return this.testMcp(config);
      case 'rag':
        return this.testHttpReachable(String(config.endpointUrl ?? ''), this.bearerHeaders(config.apiKey));
      case 'n8n':
        return this.testWebhook(config);
      case 'broker':
        return this.testBrokerQueue(config);
      default:
        return { ok: false, message: `Tipo de fuente desconocido: "${type}"`, latencyMs: 0 };
    }
  }

  /**
   * Consulta real con la pregunta del usuario, para cuando la charla se sale del
   * flujo armado (ver `ConversationsService.orchestratorLlm`). A diferencia de
   * `testConnection`, solo `broker` y `mcp` tienen un contrato de pregunta/respuesta
   * definido — `rag`/`n8n` (contrato de request propio de cada servicio) quedan
   * pendientes, ver docs/plan-de-trabajo.md.
   */
  private async query(type: string, config: Record<string, unknown>, question: string): Promise<ContextSourceQueryResult> {
    switch (type) {
      case 'broker':
        return this.queryBroker(config, question);
      case 'mcp':
        return this.queryMcp(config, question);
      default:
        return {
          ok: false,
          message: `Consulta en vivo todavía no implementada para el tipo "${type}"`,
          latencyMs: 0,
        };
    }
  }

  /**
   * "Probar conexión" de un MCP con el protocolo de verdad, no un GET a la URL (que
   * en Streamable HTTP responde 405 aunque el servidor ande perfecto, y en SSE deja
   * un stream abierto): `initialize` + `tools/list`, y además verifica que las tools
   * configuradas en la conexión sigan existiendo en el servidor — si alguna falta,
   * la consulta real va a fallar, así que es un `ok:false` con el detalle.
   */
  private async testMcp(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const start = Date.now();
    try {
      const { serverName, tools } = await withMcpSession(config, TEST_TIMEOUT_MS, async (client, remaining) => ({
        serverName: client.getServerVersion()?.name,
        tools: await listMcpTools(client, remaining),
      }));
      const latencyMs = Date.now() - start;
      const available = new Set(tools.map((t) => t.name));
      const configured = readConfiguredTools(config).map((t) => t.name);
      const missing = configured.filter((name) => !available.has(name));
      const head =
        `Conectado a ${serverName ? `"${serverName}"` : 'el servidor MCP'} en ${latencyMs}ms — ` +
        `${tools.length} tools disponibles`;

      if (missing.length) {
        return { ok: false, latencyMs, message: `${head}, pero no existen: ${missing.join(', ')}` };
      }
      if (!configured.length) {
        return { ok: true, latencyMs, message: `${head}. Todavía no hay ninguna configurada para consultar.` };
      }
      return { ok: true, latencyMs, message: `${head}; configuradas: ${configured.join(', ')}` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, message: this.mcpErrorMessage(err) };
    }
  }

  private async listMcpTools(config: Record<string, unknown>): Promise<McpToolsListResult> {
    const start = Date.now();
    try {
      const tools = await withMcpSession(config, TEST_TIMEOUT_MS, (client, remaining) =>
        listMcpTools(client, remaining),
      );
      const latencyMs = Date.now() - start;
      return { ok: true, tools, latencyMs, message: `${tools.length} tools encontradas en ${latencyMs}ms` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, message: this.mcpErrorMessage(err) };
    }
  }

  /**
   * Consulta real contra un MCP: abre sesión e invoca, en paralelo y con la pregunta
   * interpolada en sus argumentos (`{{pregunta}}`), TODAS las tools configuradas en la
   * conexión. Invocación determinística a propósito, mismo criterio que
   * `orchestratorLlm` con la fuente de verdad: no queda a criterio del LLM decidir si
   * consultar. Con varias tools, cada resultado va bajo un encabezado con el nombre de
   * la tool; alcanza con que una responda para que la consulta sea `ok` (las que
   * fallaron quedan en `message`, que el caller loguea).
   */
  private async queryMcp(config: Record<string, unknown>, question: string): Promise<ContextSourceQueryResult> {
    const tools = readConfiguredTools(config);
    if (!tools.length) {
      return { ok: false, latencyMs: 0, message: 'La conexión MCP no tiene ninguna tool configurada para consultar' };
    }

    const start = Date.now();
    try {
      const settled = await withMcpSession(config, QUERY_TIMEOUT_MS, (client, remaining) =>
        Promise.allSettled(tools.map((tool) => callMcpTool(client, tool, question, remaining))),
      );
      const latencyMs = Date.now() - start;

      const answers: { name: string; text: string }[] = [];
      const failures: string[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') answers.push({ name: tools[i].name, text: r.value });
        else failures.push(`${tools[i].name}: ${this.mcpErrorMessage(r.reason)}`);
      });

      if (!answers.length) {
        return { ok: false, latencyMs, message: `Ninguna tool respondió — ${failures.join(' | ')}` };
      }
      const answer =
        tools.length === 1 ? answers[0].text : answers.map((a) => `### ${a.name}\n${a.text}`).join('\n\n');
      const message = failures.length
        ? `Respondieron ${answers.length}/${tools.length} tools en ${latencyMs}ms — fallaron: ${failures.join(' | ')}`
        : `Respondió en ${latencyMs}ms`;
      return { ok: true, answer, message, latencyMs };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - start, message: this.mcpErrorMessage(err) };
    }
  }

  /**
   * Errores del SDK/fetch a un texto útil para el admin: los de red vienen anidados en
   * `cause`, y los HTTP del transporte traen el status en `code` pero no en el mensaje.
   */
  private mcpErrorMessage(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const { cause, code } = err as { cause?: unknown; code?: unknown };
    const detail =
      cause instanceof Error && cause.message && !err.message.includes(cause.message) ? ` (${cause.message})` : '';
    const status = typeof code === 'number' && code >= 400 && code < 600 ? `HTTP ${code} — ` : '';
    const hint = code === 401 || code === 403 ? ' Revisá la autenticación y la API key.' : '';
    return `${status}${err.message}${detail}${hint}`;
  }

  private bearerHeaders(apiKey: unknown): Record<string, string> {
    return typeof apiKey === 'string' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /** Chequeo genérico de alcanzabilidad: GET con timeout, sin validar el protocolo. */
  private async testHttpReachable(url: string, headers: Record<string, string>): Promise<ConnectionTestResult> {
    if (!url) return { ok: false, message: 'Falta la URL a probar', latencyMs: 0 };

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const latencyMs = Date.now() - start;
      return {
        ok: response.ok,
        statusCode: response.status,
        latencyMs,
        message: response.ok
          ? `Respondió ${response.status} en ${latencyMs}ms`
          : `Respondió ${response.status} (${response.statusText || 'sin detalle'})`,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `Sin respuesta después de ${TEST_TIMEOUT_MS}ms`
          : `No se pudo conectar: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, message, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /** El webhook de n8n sí tiene contrato conocido: dispararlo con un payload de prueba. */
  private async testWebhook(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const url = String(config.webhookUrl ?? '');
    if (!url) return { ok: false, message: 'Falta la URL del webhook', latencyMs: 0 };

    const method = config.httpMethod === 'GET' ? 'GET' : 'POST';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const headerName = typeof config.authHeaderName === 'string' ? config.authHeaderName.trim() : '';
    const authToken = typeof config.authToken === 'string' ? config.authToken : '';
    if (headerName && authToken) headers[headerName] = authToken;

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(method === 'POST'
          ? { body: JSON.stringify({ test: true, source: 'pci-chatbot.context-source.test-connection' }) }
          : {}),
      });
      const latencyMs = Date.now() - start;
      return {
        ok: response.ok,
        statusCode: response.status,
        latencyMs,
        message: response.ok
          ? `El workflow respondió ${response.status} en ${latencyMs}ms`
          : `El workflow respondió ${response.status} (${response.statusText || 'sin detalle'})`,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? `Sin respuesta después de ${TEST_TIMEOUT_MS}ms`
          : `No se pudo disparar el webhook: ${err instanceof Error ? err.message : String(err)}`;
      return { ok: false, message, latencyMs };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A diferencia de mcp/rag/n8n, acá no hay un `fetch()` que probar: la conexión de
   * transporte ya es la del propio `BrokerService` (misma `RABBITMQ_URL`). "Probar
   * conexión" para este tipo es publicar un request de prueba en `queueName` y
   * esperar que el proceso externo, suscripto a esa cola, responda — si nadie está
   * escuchando, expira por timeout como cualquier otro caso sin reply.
   *
   * `responseMode` decide cómo esperamos esa respuesta — ver el catálogo
   * (`context-source-types.catalog.ts`) para la explicación completa de cada modo:
   * - `rpc` (default): `BrokerService.request()`, el patrón RPC estándar (cola de
   *   respuesta anónima generada por nosotros, el externo la lee de `replyTo`).
   * - `fixedQueue`: `BrokerService.requestViaQueue()`, para un externo que no
   *   implementa `replyTo`/`correlationId` y en cambio siempre publica sus
   *   resultados en una cola de salida propia y fija (`responseQueueName`).
   */
  private async testBrokerQueue(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const pattern =
      typeof config.pattern === 'string' && config.pattern.trim()
        ? config.pattern.trim()
        : 'context-source.test-connection';
    const message = { pattern, data: { test: true, source: 'pci-chatbot.context-source.test-connection' } };

    const start = Date.now();
    try {
      const { queueUsed } = await this.dispatchBrokerRequest(config, message, TEST_TIMEOUT_MS);
      const latencyMs = Date.now() - start;
      return { ok: true, message: `Llegó respuesta en "${queueUsed}" en ${latencyMs}ms`, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs };
    }
  }

  /**
   * Contrato probado en producción contra DonQuijote (el RAG de referencia, con
   * `responseMode: fixedQueue`): pide `{"text": "..."}` y devuelve
   * `{rag_id, answer, sources, error}`. Otro `broker` que se conecte debería seguir
   * la misma forma — no hay otro contrato definido todavía (docs/plan-de-trabajo.md,
   * "Connector real por tipo").
   */
  private async queryBroker(config: Record<string, unknown>, question: string): Promise<ContextSourceQueryResult> {
    const pattern =
      typeof config.pattern === 'string' && config.pattern.trim() ? config.pattern.trim() : 'context-source.query';
    const message = { pattern, data: { text: question } };

    const start = Date.now();
    try {
      const { reply } = await this.dispatchBrokerRequest(config, message, QUERY_TIMEOUT_MS);
      const latencyMs = Date.now() - start;
      // Igual que al armar el mensaje saliente: DonQuijote no envuelve su respuesta
      // bajo `data` (manda `{rag_id, answer, sources, error}` en la raíz del JSON),
      // así que `reply.data` viene `undefined` y la respuesta real quedaba tirada —
      // verificado en producción, ver docs/plan-de-trabajo.md. Si algún día un
      // consumidor sí responde envuelto (`{data: {...}}`), lo seguimos soportando.
      const data = (
        reply.data && typeof reply.data === 'object' ? reply.data : reply
      ) as Record<string, unknown>;

      if (typeof data.error === 'string' && data.error) {
        return { ok: false, message: data.error, latencyMs };
      }
      const answer = typeof data.answer === 'string' ? data.answer.trim() : '';
      if (!answer) {
        return { ok: false, message: 'La fuente respondió sin ningún campo "answer"', latencyMs };
      }
      return { ok: true, answer, message: `Respondió en ${latencyMs}ms`, latencyMs };
    } catch (err) {
      const latencyMs = Date.now() - start;
      return { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs };
    }
  }

  /**
   * Resuelve `queueName`/`responseMode`/`responseQueueName` del catálogo `broker`
   * (ver `context-source-types.catalog.ts`) y hace el request/reply real por
   * RabbitMQ. Compartido por `testBrokerQueue` (payload de prueba) y `queryBroker`
   * (pregunta real) — la única diferencia entre ambos es el mensaje que mandan y
   * cómo interpretan la respuesta.
   *
   * `message.data` viaja además "aplanado" en la raíz del JSON publicado, no solo
   * anidado bajo `data`: DonQuijote (el RAG de referencia) espera `{"text": "..."}`
   * en la raíz, no dentro de un sobre — verificado en producción, su propio error
   * ("Mensaje vacío: enviá JSON {'text': '...'}") lo confirmó cuando solo mandábamos
   * `data.text`. Aplanar no rompe a un consumidor que sí lea nuestro sobre completo
   * (`pattern`/`data`/`correlationId` siguen presentes), así que es compatible con
   * ambos casos sin necesitar un campo de catálogo nuevo por ahora.
   */
  private async dispatchBrokerRequest(
    config: Record<string, unknown>,
    message: { pattern: string; data: unknown },
    timeoutMs: number,
  ): Promise<{ reply: BrokerMessage; queueUsed: string }> {
    const queueName = typeof config.queueName === 'string' ? config.queueName.trim() : '';
    if (!queueName) throw new Error('Falta el nombre de la cola');

    const flatData = message.data && typeof message.data === 'object' ? (message.data as Record<string, unknown>) : {};
    const outgoing = { ...flatData, ...message };

    const responseMode = config.responseMode === 'fixedQueue' ? 'fixedQueue' : 'rpc';
    if (responseMode === 'fixedQueue') {
      const responseQueueName = typeof config.responseQueueName === 'string' ? config.responseQueueName.trim() : '';
      if (!responseQueueName) throw new Error('Falta la cola de respuesta fija');
      const reply = await this.broker.requestViaQueue(queueName, responseQueueName, outgoing, { timeoutMs });
      return { reply, queueUsed: responseQueueName };
    }

    const reply = await this.broker.request(queueName, outgoing, { timeoutMs });
    return { reply, queueUsed: queueName };
  }
}
