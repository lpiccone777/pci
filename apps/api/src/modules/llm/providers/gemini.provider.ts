import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  LlmProvider,
  LlmMessage,
  LlmCompletionOptions,
  ResolvedProviderConfig,
} from '../llm-provider.interface';

// Sin @Injectable(): no lo instancia Nest, lo construye LlmProviderFactory
// pasándole la config ya resuelta.
export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenerativeAI;
  private readonly defaultModel: string;

  // La config llega resuelta desde LlmProviderFactory (BD → env → default).
  constructor(config: ResolvedProviderConfig) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.defaultModel = config.model;
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const model = this.client.getGenerativeModel({ model: this.defaultModel });

    // Gemini no usa system role; convertimos todo a parts
    const parts = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({
      history: parts.slice(0, -1),
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 1024,
      },
    });

    const lastMessage = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMessage.content);
    return result.response.text() ?? '';
  }
}
