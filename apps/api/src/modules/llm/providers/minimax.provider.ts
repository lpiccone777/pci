import OpenAI from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  ResolvedProviderConfig,
} from '../llm-provider.interface';

// MiniMax expone /v1/chat/completions compatible con el formato de OpenAI
// (https://platform.minimax.io/docs/api-reference/text-openai-api), así que
// se implementa igual que OpenAiProvider/OpenRouterProvider, solo cambia la
// base URL por default.
//
// Sin @Injectable(): no lo instancia Nest, lo construye LlmProviderFactory
// pasándole la config ya resuelta.
export class MiniMaxProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(config: ResolvedProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || 'https://api.minimax.io/v1',
    });
    this.defaultModel = config.model;
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const completion = await this.client.chat.completions.create({
      model: this.defaultModel,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 1024,
    });

    return completion.choices[0]?.message?.content ?? '';
  }
}
