import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { LlmProvider, LlmMessage, LlmCompletionOptions, LLM_PROVIDER } from '../llm-provider.interface';

@Injectable()
export class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.config.get('OPENAI_API_KEY', ''),
    });
    this.defaultModel = this.config.get('OPENAI_MODEL', 'gpt-4o-mini');
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
