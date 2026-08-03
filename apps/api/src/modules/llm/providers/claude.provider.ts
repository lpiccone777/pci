import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { LlmProvider, LlmMessage, LlmCompletionOptions } from '../llm-provider.interface';

@Injectable()
export class ClaudeProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get('ANTHROPIC_API_KEY', ''),
    });
    this.defaultModel = this.config.get('ANTHROPIC_MODEL', 'claude-3-5-sonnet-20241022');
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
