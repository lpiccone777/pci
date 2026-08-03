import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { LlmProvider, LlmMessage, LlmCompletionOptions } from '../llm-provider.interface';

@Injectable()
export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenerativeAI;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.client = new GoogleGenerativeAI(
      this.config.get('GEMINI_API_KEY', ''),
    );
    this.defaultModel = this.config.get('GEMINI_MODEL', 'gemini-1.5-flash');
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
