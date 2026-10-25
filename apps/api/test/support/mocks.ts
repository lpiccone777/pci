/**
 * Mocks de FRONTERAS EXTERNAS para los tests e2e.
 *
 * Regla del plan de pruebas: solo se mockean los terceros (SDK de LLM, HTTP de
 * Meta/Twilio/Gupshup/InvGate, transporte SMTP). NUNCA la lógica bajo prueba (endpoints,
 * guards, motor de flujos): eso vaciaría el test de sentido.
 */
import { EmailService, EmailMessage } from '../../src/modules/auth/email.service';
import type {
  LlmMessage,
  LlmCompletionOptions,
  LlmProvider,
  LlmToolDefinition,
  LlmToolStep,
  LlmToolTurn,
} from '../../src/modules/llm/llm-provider.interface';
import {
  runToolLoop,
  type LlmToolChatResult,
  type LlmToolExecutor,
  type LlmToolLoopOptions,
} from '../../src/modules/llm/tool-loop';

/**
 * `EmailService` de test: no manda nada, graba cada mensaje en memoria. Reemplaza al
 * `SmtpEmailService` real (frontera SMTP). Permite leer el código OTP que el flujo de 2FA
 * envía por email (`AuthService.sendOtp` → `EmailService.send`).
 */
export class RecordingEmailService extends EmailService {
  public readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  reset(): void {
    this.sent.length = 0;
  }

  get last(): EmailMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** El último email enviado a `to`, o `undefined`. */
  lastTo(to: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }

  /**
   * Extrae el código (secuencia de 4–8 dígitos) del último email a `to`. `AuthService`
   * escribe "Tu código de verificación es: 123456. …", así que el primer bloque de dígitos
   * del cuerpo es el código.
   */
  codeFor(to: string): string | undefined {
    const msg = this.lastTo(to);
    const m = msg?.text.match(/\b(\d{4,8})\b/);
    return m?.[1];
  }
}

/**
 * `LlmService` de test: frontera del LLM para los tests del CHATBOT (donde el LLM es una
 * dependencia del motor, no lo que se prueba). Determinista y programable.
 *
 * Ojo: NO usar esto en los tests del bloque LLM (BE-LLM-*), donde lo bajo prueba es el propio
 * `LlmService`/`LlmProviderFactory`/providers — ahí se mockea más abajo (SDK/fetch).
 *
 * `chat()` respeta la firma real (`(messages, tenantConfig?) => Promise<string>`). El
 * `responder` recibe los mensajes para poder ramificar (p. ej. devolver "cancelar" cuando el
 * prompt es el clasificador de cancelación).
 */
export class FakeLlmService {
  public readonly calls: { messages: LlmMessage[]; options?: Partial<LlmCompletionOptions> }[] = [];
  private responder: (messages: LlmMessage[], options?: Partial<LlmCompletionOptions>) => string =
    () => 'respuesta simulada del modelo';
  /** Si se setea, `chat()` lanza (para simular un proveedor caído). */
  private failWith: Error | null = null;

  async chat(
    messages: LlmMessage[],
    options?: Partial<LlmCompletionOptions>,
  ): Promise<string> {
    this.calls.push({ messages, options });
    if (this.failWith) throw this.failWith;
    return this.responder(messages, options);
  }

  /**
   * Tool calling (C61). Sin `setToolProvider`, el fake no tiene tools (como OpenCode Go) y el
   * motor sigue con la pre-consulta de siempre. Con un proveedor guionado, `chatWithTools`
   * corre el loop REAL (`runToolLoop`) contra él: lo único falso es el modelo.
   */
  private toolProvider: Required<Pick<LlmProvider, 'generateWithTools'>> | null = null;
  public readonly toolChats: { messages: LlmMessage[]; tools: LlmToolDefinition[] }[] = [];

  setToolProvider(provider: Required<Pick<LlmProvider, 'generateWithTools'>> | null): this {
    this.toolProvider = provider;
    return this;
  }

  async supportsTools(): Promise<boolean> {
    return !!this.toolProvider;
  }

  async chatWithTools(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    execute: LlmToolExecutor,
    opts: LlmToolLoopOptions & { tenantConfig?: Partial<LlmCompletionOptions> } = {},
  ): Promise<LlmToolChatResult> {
    if (!this.toolProvider) return { supported: false, text: '', rounds: 0, calls: [] };
    const options: LlmCompletionOptions = { temperature: 0.7, maxTokens: 1024, ...opts.tenantConfig };
    if (options.systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: options.systemPrompt }, ...messages];
    }
    this.toolChats.push({ messages, tools });
    return runToolLoop(this.toolProvider, messages, tools, execute, options, opts);
  }

  /** Respuesta fija para cualquier llamada. */
  setReply(text: string): this {
    this.responder = () => text;
    return this;
  }

  /** Responder dinámico según los mensajes (para clasificadores, interpretación de menú, etc.). */
  setResponder(
    fn: (messages: LlmMessage[], options?: Partial<LlmCompletionOptions>) => string,
  ): this {
    this.responder = fn;
    return this;
  }

  /** Hace que la próxima (y siguientes) llamada a `chat()` lance, para simular caída del proveedor. */
  setFailure(err: Error = new Error('LLM caído (simulado)')): this {
    this.failWith = err;
    return this;
  }

  clearFailure(): this {
    this.failWith = null;
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.toolChats.length = 0;
    this.toolProvider = null;
    this.failWith = null;
    this.responder = () => 'respuesta simulada del modelo';
  }

  /** El texto del último mensaje `user` de la última llamada (útil para clasificadores). */
  lastUserMessage(): string | undefined {
    const call = this.calls[this.calls.length - 1];
    const users = call?.messages.filter((m) => m.role === 'user') ?? [];
    return users[users.length - 1]?.content;
  }
}

/**
 * Modelo guionado con tool calling para la fuente de clima del MCP falso (C61): pide
 * `geocoding` de Merlo, con esas coordenadas pide `weather_forecast` (con una unidad inválida
 * a propósito, que pci tiene que pisar con la fija de la configuración) y después contesta con
 * el pronóstico. `steps` guarda qué tools y qué turnos vio en cada vuelta.
 */
export function weatherToolScript(opts: { city?: string; finalText?: (forecast: string) => string } = {}) {
  const steps: { messages: LlmMessage[]; tools: LlmToolDefinition[]; turns: LlmToolTurn[] }[] = [];
  const provider = {
    async generateWithTools(messages: LlmMessage[], turns: LlmToolTurn[], tools: LlmToolDefinition[]): Promise<LlmToolStep> {
      steps.push({ messages, tools, turns: [...turns] });
      const results = turns.filter((x): x is Extract<LlmToolTurn, { kind: 'result' }> => x.kind === 'result');
      const geo = results.find((r) => r.name === 'geocoding');
      const forecast = results.find((r) => r.name === 'weather_forecast');
      if (!geo && tools.length) {
        return { text: '', toolCalls: [{ id: 'call-geo', name: 'geocoding', arguments: { name: opts.city ?? 'Merlo' } }] };
      }
      if (geo && !forecast && tools.length) {
        const hit = (JSON.parse(geo.content) as { results: { latitude: number; longitude: number }[] }).results[0];
        return {
          text: '',
          toolCalls: [
            { id: 'call-fc', name: 'weather_forecast', arguments: { latitude: hit.latitude, longitude: hit.longitude, temperature_unit: 'kelvin' } },
          ],
        };
      }
      return { text: (opts.finalText ?? ((f) => `Según la fuente: ${f}`))(forecast?.content ?? ''), toolCalls: [] };
    },
  };
  return { provider, steps };
}

/** Respuesta simulada que devuelve el router de `installFetchMock`. */
export interface MockHttpResponse {
  status?: number;
  /** Objeto (se serializa a JSON) o string crudo. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type FetchRouter = (
  url: string,
  init: RequestInit | undefined,
) => MockHttpResponse | Promise<MockHttpResponse>;

/**
 * Mockea el `fetch` global (frontera HTTP de Meta/Twilio/Gupshup/InvGate/MCP/RAG/n8n).
 * El `router` decide qué responder según la URL y el `init`. Registra las requests para
 * poder asertar el payload que armó el conector.
 *
 * Devuelve `{ spy, requests, restore }`. Llamar `restore()` en el `afterEach`/`afterAll`.
 */
export function installFetchMock(router: FetchRouter) {
  const requests: { url: string; init?: RequestInit }[] = [];

  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      requests.push({ url, init });
      const res = await router(url, init);
      const status = res.status ?? 200;
      const isString = typeof res.body === 'string';
      const bodyStr = res.body === undefined ? '' : isString ? (res.body as string) : JSON.stringify(res.body);
      const headers = new Headers(res.headers ?? {});
      if (!headers.has('content-type')) {
        headers.set('content-type', isString ? 'text/plain' : 'application/json');
      }
      return new Response(bodyStr, { status, headers });
    }) as unknown as typeof fetch);

  return {
    spy,
    requests,
    restore: () => spy.mockRestore(),
  };
}
