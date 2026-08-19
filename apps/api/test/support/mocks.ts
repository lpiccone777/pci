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
} from '../../src/modules/llm/llm-provider.interface';

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
