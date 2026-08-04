import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  ResolvedProviderConfig,
} from '../llm-provider.interface';

// Sin @Injectable(): no lo instancia Nest, lo construye LlmProviderFactory
// pasándole la config ya resuelta.
export class ClaudeProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  // La config llega resuelta desde LlmProviderFactory (BD → env → default).
  constructor(config: ResolvedProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.defaultModel = config.model;
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      system: systemMessage?.content ?? options?.systemPrompt,
      messages: conversationMessages,
    });

    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }
}
