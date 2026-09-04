import { Logger } from '@nestjs/common';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  ResolvedProviderConfig,
} from '../llm-provider.interface';

/** opencode puede tardar bastante: el modelo razona antes de contestar. */
const REQUEST_TIMEOUT_MS = 120_000;

interface OpenCodeSession {
  id: string;
}

interface OpenCodePart {
  type: string;
  text?: string;
  synthetic?: boolean;
}

interface OpenCodeMessageResponse {
  info?: { error?: unknown; modelID?: string; providerID?: string };
  parts?: OpenCodePart[];
}

/**
 * Provider para opencode (opencode.ai) corriendo como servidor local (`opencode serve`).
 *
 * **No es compatible con OpenAI.** No existe `/chat/completions`: opencode trabaja con
 * sesiones. El ciclo por cada consulta es
 *   `POST /session` → `POST /session/{id}/message` → `DELETE /session/{id}`
 *
 * **Sesión efímera por consulta, a propósito.** `LlmProvider` es una interfaz sin estado:
 * recibe el historial completo en `messages` y devuelve un texto. Mantener una sesión de
 * opencode por `Conversation` obligaría a persistir el `sessionID` (columna nueva) y a
 * romper esa interfaz para todos los proveedores. Como igual mandamos el historial en cada
 * llamada, el contexto no se pierde: lo administra el orquestador, no opencode.
 *
 * **Limitación:** la API de mensajes de opencode no expone `temperature` ni `maxTokens`,
 * así que esos parámetros de `/settings` no tienen efecto con este proveedor. El
 * `systemPrompt` sí se respeta (campo `system`).
 */
export class OpenCodeGoProvider implements LlmProvider {
  private readonly logger = new Logger(OpenCodeGoProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly providerID: string;
  private readonly modelID: string;
  private readonly agent?: string;

  constructor(config: ResolvedProviderConfig) {
    this.agent = config.agent;
    // Sin barra final: abajo concatenamos rutas.
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = config.apiKey;

    // El catálogo de modelos se expone como `providerID/modelID`
    // (ej. `opencode-go/kimi-k2.6`), porque opencode direcciona por ese par.
    const slash = config.model.indexOf('/');
    if (slash > 0) {
      this.providerID = config.model.slice(0, slash);
      this.modelID = config.model.slice(slash + 1);
    } else {
      // Modelo sin proveedor: asumimos el proveedor homónimo del server.
      this.providerID = 'opencode-go';
      this.modelID = config.model;
    }
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt(messages, options);
    const prompt = this.buildPrompt(messages);

    const session = await this.createSession();

    try {
      return await this.sendMessage(session.id, prompt, systemPrompt);
    } finally {
      // Sesión efímera: si la limpieza falla no rompemos la respuesta al usuario,
      // pero sí lo dejamos en el log para no acumular sesiones en silencio.
      void this.deleteSession(session.id);
    }
  }

  /** Los mensajes `system` nuestros + el systemPrompt configurado van al campo `system`. */
  private buildSystemPrompt(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): string | undefined {
    const parts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    if (options?.systemPrompt && !parts.includes(options.systemPrompt)) {
      parts.unshift(options.systemPrompt);
    }
    return parts.length ? parts.join('\n\n') : undefined;
  }

  /**
   * opencode espera el turno del usuario, no un array de mensajes. Como la sesión es
   * nueva en cada consulta, el historial previo se manda como transcripción y el último
   * mensaje del usuario queda como la consulta actual.
   */
  private buildPrompt(messages: LlmMessage[]): string {
    const conversation = messages.filter((m) => m.role !== 'system');
    if (conversation.length === 0) return '';

    const last = conversation[conversation.length - 1];
    const history = conversation.slice(0, -1);

    if (history.length === 0) return last.content;

    const transcript = history
      .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
      .join('\n');

    return [
      'Historial de la conversación:',
      transcript,
      '',
      `Mensaje actual del usuario: ${last.content}`,
    ].join('\n');
  }

  private async createSession(): Promise<OpenCodeSession> {
    const res = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify({ title: 'plataforma-conversacional-inteligente' }),
    });

    const session = (await res.json()) as OpenCodeSession;
    if (!session?.id) {
      throw new Error('opencode no devolvió un sessionID al crear la sesión');
    }
    return session;
  }

  private async sendMessage(
    sessionId: string,
    prompt: string,
    systemPrompt?: string,
  ): Promise<string> {
    const res = await this.request(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({
        model: { providerID: this.providerID, modelID: this.modelID },
        // El agent decide qué herramientas puede ejecutar opencode. El default de
        // opencode (`build`) corre herramientas sobre la máquina del servidor, así
        // que acá se configura explícitamente (ver OPENCODEGO_AGENT en /settings).
        ...(this.agent ? { agent: this.agent } : {}),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        parts: [{ type: 'text', text: prompt }],
      }),
    });

    const body = (await res.json()) as OpenCodeMessageResponse;

    if (body.info?.error) {
      const detail =
        typeof body.info.error === 'object'
          ? JSON.stringify(body.info.error)
          : String(body.info.error);
      this.logger.error(`opencode devolvió un error: ${detail}`);
      throw new Error(`opencode: ${detail}`);
    }

    // La respuesta trae partes de varios tipos (step-start, reasoning, text,
    // step-finish). Solo `text` es la respuesta; `reasoning` es el razonamiento
    // interno del modelo y no debe llegarle al usuario.
    const text = (body.parts ?? [])
      .filter((p) => p.type === 'text' && !p.synthetic && p.text)
      .map((p) => p.text!.trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) {
      this.logger.warn(
        `opencode respondió sin partes de texto (tipos: ${(body.parts ?? []).map((p) => p.type).join(', ') || 'ninguna'})`,
      );
      throw new Error('opencode respondió sin contenido de texto');
    }

    return text;
  }

  private async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.request(`/session/${sessionId}`, { method: 'DELETE' });
    } catch (err: any) {
      this.logger.warn(`No se pudo borrar la sesión ${sessionId}: ${err?.message}`);
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // El server local suele ser abierto; si hay key configurada, la mandamos igual.
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `opencode ${path} respondió HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
      );
    }

    // opencode sirve una SPA: cualquier ruta desconocida devuelve HTML con 200.
    // Sin este chequeo el fallo aparecería recién al parsear, con un error inútil.
    const contentType = res.headers.get('content-type') ?? '';
    if (init.method !== 'DELETE' && !contentType.includes('json')) {
      throw new Error(
        `opencode ${path} devolvió '${contentType || 'sin content-type'}' en vez de JSON. ` +
          '¿OPENCODEGO_API_URL apunta al servidor de opencode?',
      );
    }

    return res;
  }
}
