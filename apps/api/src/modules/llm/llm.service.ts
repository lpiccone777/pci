import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { LlmProviderFactory } from './llm-provider.factory';
import type { LlmMessage, LlmCompletionOptions } from './llm-provider.interface';

@Injectable()
export class LlmService {
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

    // Merge: config del caller > Setting en BD > env var > default
    // (AppConfigService resuelve la cascada BD → env → default)
    const defaults: LlmCompletionOptions = {
      temperature: await this.appConfig.getNumber('LLM_TEMPERATURE', 0.7),
      maxTokens: await this.appConfig.getNumber('LLM_MAX_TOKENS', 1024),
      systemPrompt: await this.appConfig.get('LLM_SYSTEM_PROMPT'),
    };

    const merged: LlmCompletionOptions = {
      ...defaults,
      ...tenantConfig,
    };

    if (merged.systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: merged.systemPrompt }, ...messages];
    }

    const raw = await provider.generateCompletion(messages, merged);
    return this.stripThinking(raw);
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
