import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { LlmProviderFactory } from './llm-provider.factory';
import type {
  LlmMessage,
  LlmCompletionOptions,
  LlmToolCall,
  LlmToolDefinition,
  LlmTurn,
} from './llm-provider.interface';

/** Ejecuta una herramienta pedida por el modelo y devuelve su resultado como texto. */
export type LlmToolExecutor = (call: LlmToolCall) => Promise<string>;

export interface LlmToolLoopOptions extends Partial<LlmCompletionOptions> {
  /** Máximo de rondas de herramientas antes de forzar la respuesta (default 6). */
  maxSteps?: number;
}

/** Tope del resultado de una herramienta que vuelve al modelo. */
const MAX_TOOL_RESULT_CHARS = 12_000;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly factory: LlmProviderFactory,
    private readonly appConfig: AppConfigService,
  ) {}

  async chat(
    messages: LlmMessage[],
    tenantConfig?: Partial<LlmCompletionOptions>,
  ): Promise<string> {
    // Lazy: provider se instancia aquí, nunca en startup
    const provider = await this.factory.createProvider();
    const merged = await this.mergedOptions(tenantConfig);

    if (merged.systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: merged.systemPrompt }, ...messages];
    }

    const raw = await provider.generateCompletion(messages, merged);
    return this.stripThinking(raw);
  }

  /** ¿El proveedor activo soporta function calling? (OpenCode Go, por ejemplo, no). */
  async supportsTools(): Promise<boolean> {
    const provider = await this.factory.createProvider();
    return typeof provider.generateWithTools === 'function';
  }

  /**
   * Conversación con herramientas (modo agente): el modelo puede pedir herramientas, se
   * ejecutan con `execute` y sus resultados vuelven al modelo, hasta que responde texto o
   * se agotan `maxSteps` rondas. La lógica es provider-agnostic: cada provider solo traduce
   * los turnos a su API (`generateWithTools`). Un error de una herramienta no corta la charla:
   * vuelve al modelo como resultado para que lo explique o pruebe otra cosa.
   */
  async chatWithTools(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    execute: LlmToolExecutor,
    options: LlmToolLoopOptions = {},
  ): Promise<string> {
    const provider = await this.factory.createProvider();
    if (typeof provider.generateWithTools !== 'function') {
      throw new Error('El proveedor LLM activo no soporta herramientas (function calling)');
    }
    const { maxSteps = 6, ...tenantConfig } = options;
    const merged = await this.mergedOptions(tenantConfig);

    const turns: LlmTurn[] =
      merged.systemPrompt && messages[0]?.role !== 'system'
        ? [{ role: 'system', content: merged.systemPrompt }, ...messages]
        : [...messages];

    for (let step = 0; step <= maxSteps; step++) {
      const lastStep = step === maxSteps;
      if (lastStep) {
        turns.push({
          role: 'system',
          content: 'Ya no podés usar más herramientas: respondé ahora al usuario con la información que tenés.',
        });
      }
      const res = await provider.generateWithTools(turns, tools, merged);
      if (!res.toolCalls.length || lastStep) {
        const text = this.stripThinking(res.text);
        if (text) return text;
        if (lastStep) return 'No pude completar la consulta. ¿Podés reformularla?';
        continue;
      }

      turns.push({ role: 'assistant', content: res.text ?? '', toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        let result: string;
        try {
          result = await execute(call);
        } catch (err) {
          result = `Error al ejecutar ${call.name}: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (result.length > MAX_TOOL_RESULT_CHARS) {
          result = `${result.slice(0, MAX_TOOL_RESULT_CHARS)}\n[…resultado recortado]`;
        }
        this.logger.debug(`tool ${call.name} → ${result.length} caracteres`);
        turns.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
      }
    }
    return 'No pude completar la consulta. ¿Podés reformularla?';
  }

  /** Merge: config del caller > Setting en BD > env var > default (AppConfigService resuelve la cascada). */
  private async mergedOptions(tenantConfig?: Partial<LlmCompletionOptions>): Promise<LlmCompletionOptions> {
    const defaults: LlmCompletionOptions = {
      temperature: await this.appConfig.getNumber('LLM_TEMPERATURE', 0.7),
      maxTokens: await this.appConfig.getNumber('LLM_MAX_TOKENS', 1024),
      systemPrompt: await this.appConfig.get('LLM_SYSTEM_PROMPT'),
    };
    return { ...defaults, ...tenantConfig };
  }

  /**
   * Saca el bloque de razonamiento (`<think>...</think>`) que algunos modelos devuelven
   * mezclado con la respuesta final en vez de en un campo separado — confirmado con
   * MiniMax-M2.x (no se puede apagar el razonamiento en esos modelos, y sin el parámetro
   * `reasoning_split` de esa API el texto queda embebido en `content`; ver
   * `MiniMaxProvider`). Va acá y no en cada provider porque cualquier modelo detrás de
   * cualquier proveedor puede ser "razonador" (ej. DeepSeek R1 vía OpenRouter) — un solo
   * lugar, provider-agnostic, en vez de repetir la limpieza en cada uno.
   */
  private stripThinking(text: string): string {
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Si `max_tokens` se agotó a mitad del razonamiento, no hay tag de cierre y el regex de
    // arriba no lo agarra — cortar desde el `<think>` abierto es mejor que mostrarle al
    // usuario el razonamiento interno crudo (aunque la respuesta quede corta o vacía).
    const openIdx = cleaned.search(/<think>/i);
    if (openIdx !== -1) cleaned = cleaned.slice(0, openIdx);
    return cleaned.trim();
  }
}
