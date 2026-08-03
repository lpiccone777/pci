import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProviderFactory } from './llm-provider.factory';
import type { LlmMessage, LlmCompletionOptions } from './llm-provider.interface';

@Injectable()
export class LlmService {
  constructor(
    private readonly factory: LlmProviderFactory,
    private readonly config: ConfigService,
  ) {}

  async chat(
    messages: LlmMessage[],
    tenantConfig?: Partial<LlmCompletionOptions>,
  ): Promise<string> {
    // Lazy: provider se instancia aquí, nunca en startup
    const provider = await this.factory.createProvider();

    // Merge: tenant-specific config > env defaults
    const defaults: LlmCompletionOptions = {
      temperature: this.config.get('LLM_TEMPERATURE', 0.7),
      maxTokens: this.config.get('LLM_MAX_TOKENS', 1024),
      systemPrompt: this.config.get('LLM_SYSTEM_PROMPT'),
    };

    const merged: LlmCompletionOptions = {
      ...defaults,
      ...tenantConfig,
    };

    if (merged.systemPrompt && messages[0]?.role !== 'system') {
      messages = [{ role: 'system', content: merged.systemPrompt }, ...messages];
    }

    return provider.generateCompletion(messages, merged);
  }
}
