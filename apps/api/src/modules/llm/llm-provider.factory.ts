import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmProvider } from './llm-provider.interface';
import { OpenAiProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { OpenCodeGoProvider } from './providers/opencodego.provider';

@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async createProvider(): Promise<LlmProvider> {
    // 1. Buscar en BD (Setting) primero
    const dbProvider = await this.prisma.setting.findUnique({
      where: { key: 'LLM_PROVIDER' },
    });

    // 2. Fallback a env var
    const providerName = (dbProvider?.value ?? this.config.get<string>('LLM_PROVIDER') ?? 'openai').toLowerCase();

    this.logger.log(`LLM provider activo: ${providerName}`);

    switch (providerName) {
      case 'openai':
        return new OpenAiProvider(this.config);
      case 'gemini':
        return new GeminiProvider(this.config);
      case 'claude':
      case 'anthropic':
        return new ClaudeProvider(this.config);
      case 'openrouter':
        return new OpenRouterProvider(this.config);
      case 'opencodego':
      case 'opencode':
      case 'opencode-go':
        return new OpenCodeGoProvider(this.config);
      default:
        this.logger.warn(`Proveedor desconocido: ${providerName}. Usando OpenAI por defecto.`);
        return new OpenAiProvider(this.config);
    }
  }
}
