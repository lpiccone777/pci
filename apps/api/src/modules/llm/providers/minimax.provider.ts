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
      // Específico de MiniMax, no tipado en el SDK de OpenAI (de ahí el `as any`). Los
      // modelos M2.x no permiten apagar el razonamiento del todo (confirmado contra el
      // repo de MiniMax, issues #68/#121/#626 — `thinking: {type: "disabled"}` se acepta
      // pero no hace nada en M2.x); esto es lo más cerca que se puede llegar: saca el
      // razonamiento de `content` y lo manda aparte en `reasoning_content`, que acá se
      // ignora a propósito — LlmService.stripThinking() queda como red de seguridad para
      // el bug conocido de M2.7 donde el tag se cuela en `content` igual.
      reasoning_split: true,
    } as any);

    return completion.choices[0]?.message?.content ?? '';
  }
}
