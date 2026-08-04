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

    return provider.generateCompletion(messages, merged);
  }
}
