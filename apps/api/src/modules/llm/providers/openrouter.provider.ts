import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LlmProvider, LlmMessage, LlmCompletionOptions } from '../llm-provider.interface';

@Injectable()
export class OpenRouterProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.getOrThrow('OPENROUTER_API_KEY'),
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.defaultModel = this.config.get('OPENROUTER_MODEL', 'openai/gpt-4o-mini');
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
