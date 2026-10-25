import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { LlmProviderFactory } from './llm-provider.factory';
import type { LlmMessage, LlmCompletionOptions, LlmToolDefinition } from './llm-provider.interface';
import { LlmToolChatResult, LlmToolExecutor, LlmToolLoopOptions, runToolLoop, stripThinking } from './tool-loop';

export { LLM_TOOL_MAX_ROUNDS } from './tool-loop';
export type { LlmToolChatResult, LlmToolTrace } from './tool-loop';

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

  /** Si el proveedor activo tiene tool calling (todos salvo OpenCode Go). */
  async supportsTools(): Promise<boolean> {
    const provider = await this.factory.createProvider();
    return typeof provider.generateWithTools === 'function';
  }

  /**
   * Conversación con tools (contrato C61): el LLM elige tool y argumentos, `execute` la corre
   * (pci, contra la fuente de verdad) y el resultado vuelve al LLM, hasta
   * `LLM_TOOL_MAX_ROUNDS` vueltas. Agotadas, una pasada final sin tools obliga a contestar con
   * texto. `execute` nunca tira: un error vuelve al LLM como resultado ("no se pudo…").
   * Con `stopAfterTools` (voz) no hace la pasada final: alcanza con los resultados.
   */
  async chatWithTools(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
    execute: LlmToolExecutor,
    opts: LlmToolLoopOptions & { tenantConfig?: Partial<LlmCompletionOptions> } = {},
  ): Promise<LlmToolChatResult> {
    const provider = await this.factory.createProvider();
    if (!provider.generateWithTools) return { supported: false, text: '', rounds: 0, calls: [], llmMs: [] };

    const merged: LlmCompletionOptions = {
      temperature: await this.appConfig.getNumber('LLM_TEMPERATURE', 0.7),
      maxTokens: await this.appConfig.getNumber('LLM_MAX_TOKENS', 1024),
      systemPrompt: await this.appConfig.get('LLM_SYSTEM_PROMPT'),
      ...opts.tenantConfig,
    };
    if (merged.systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: merged.systemPrompt }, ...messages];
    }
    return runToolLoop(provider as Required<typeof provider>, messages, tools, execute, merged, opts);
  }

  /** Ver `stripThinking` en `tool-loop.ts`. */
  private stripThinking(text: string): string {
    return stripThinking(text);
  }
}
