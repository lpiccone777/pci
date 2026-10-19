import OpenAI from 'openai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  LlmToolDefinition,
  LlmToolResponse,
  LlmTurn,
  ResolvedProviderConfig,
} from '../llm-provider.interface';
import { openAiCompatibleWithTools } from './openai-tools';

// Sin @Injectable(): no lo instancia Nest, lo construye LlmProviderFactory
// pasándole la config ya resuelta.
export class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  // La config llega resuelta desde LlmProviderFactory (BD → env → default).
  constructor(config: ResolvedProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
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

  async generateWithTools(
    turns: LlmTurn[],
    tools: LlmToolDefinition[],
    options?: LlmCompletionOptions,
  ): Promise<LlmToolResponse> {
    return openAiCompatibleWithTools(this.client, this.defaultModel, turns, tools, options);
  }
}
