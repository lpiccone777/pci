import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider, LlmMessage, LlmCompletionOptions } from '../llm-provider.interface';

// Provider genérico para API propia de OpenCode Go.
// TODO: completar con el formato real de la API cuando se defina.
@Injectable()
export class OpenCodeGoProvider implements LlmProvider {
  private readonly logger = new Logger(OpenCodeGoProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get('OPENCODEGO_API_URL', '');
    this.apiKey = this.config.get('OPENCODEGO_API_KEY', '');
    this.defaultModel = this.config.get('OPENCODEGO_MODEL', 'opencode-go-1');
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    if (!this.baseUrl || !this.apiKey) {
      throw new NotImplementedException(
        'OpenCode Go provider requiere OPENCODEGO_API_URL y OPENCODEGO_API_KEY. ' +
        'La URL de la API no está configurada.',
      );
    }

    // Implementación con fetch genérico — ajustar según la API real
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.defaultModel,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 1024,
        system_prompt: options?.systemPrompt,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.error(`OpenCode Go API error: ${response.status} ${text}`);
      throw new Error(`OpenCode Go API error: ${response.status}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }
}
