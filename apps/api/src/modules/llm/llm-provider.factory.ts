import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { LlmProvider, ResolvedProviderConfig } from './llm-provider.interface';
import { OpenAiProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { OpenCodeGoProvider } from './providers/opencodego.provider';

/** Claves de configuración de cada proveedor y sus defaults. */
const PROVIDER_KEYS = {
  openai: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', baseUrl: 'OPENAI_BASE_URL', defaultModel: 'gpt-4o-mini' },
  gemini: { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL', baseUrl: null, defaultModel: 'gemini-1.5-flash' },
  claude: { apiKey: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL', baseUrl: null, defaultModel: 'claude-3-5-sonnet-20241022' },
  openrouter: { apiKey: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL', baseUrl: 'OPENROUTER_BASE_URL', defaultModel: 'openai/gpt-4o-mini' },
  opencodego: { apiKey: 'OPENCODEGO_API_KEY', model: 'OPENCODEGO_MODEL', baseUrl: 'OPENCODEGO_API_URL', defaultModel: 'opencode-go-1' },
} as const;

type ProviderName = keyof typeof PROVIDER_KEYS;

/** Alias que aceptamos como nombre de proveedor. */
const ALIASES: Record<string, ProviderName> = {
  openai: 'openai',
  gemini: 'gemini',
  google: 'gemini',
  claude: 'claude',
  anthropic: 'claude',
  openrouter: 'openrouter',
  opencodego: 'opencodego',
  opencode: 'opencodego',
  'opencode-go': 'opencodego',
};

@Injectable()
export class LlmProviderFactory {
  private readonly logger = new Logger(LlmProviderFactory.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async createProvider(): Promise<LlmProvider> {
    const raw = (await this.appConfig.get('LLM_PROVIDER', 'openai'))!.toLowerCase();
    const name = ALIASES[raw];

    if (!name) {
      this.logger.warn(`Proveedor desconocido: ${raw}. Usando OpenAI por defecto.`);
      return new OpenAiProvider(await this.resolveConfig('openai'));
    }

    const config = await this.resolveConfig(name);
    this.logger.log(`LLM provider activo: ${name} (modelo ${config.model})`);

    switch (name) {
      case 'openai':
        return new OpenAiProvider(config);
      case 'gemini':
        return new GeminiProvider(config);
      case 'claude':
        return new ClaudeProvider(config);
      case 'openrouter':
        return new OpenRouterProvider(config);
      case 'opencodego':
        return new OpenCodeGoProvider(config);
    }
  }

  /**
   * Arma la config del proveedor desde la cascada BD → env → default.
   * `AppConfigService` descifra las API keys guardadas desde /settings.
   */
  private async resolveConfig(name: ProviderName): Promise<ResolvedProviderConfig> {
    const keys = PROVIDER_KEYS[name];

    const apiKey = (await this.appConfig.get(keys.apiKey)) ?? '';
    const model = (await this.appConfig.get(keys.model, keys.defaultModel))!;
    const baseUrl = keys.baseUrl ? await this.appConfig.get(keys.baseUrl) : undefined;

    if (name === 'opencodego') {
      // opencode corre como servidor propio, normalmente local y sin autenticación:
      // lo obligatorio es el host, no la key.
      if (!baseUrl) {
        throw new BadRequestException(
          'OpenCode Go necesita el host configurado. Cargalo en /settings (OPENCODEGO_API_URL).',
        );
      }
      return {
        apiKey,
        model,
        baseUrl,
        agent: (await this.appConfig.get('OPENCODEGO_AGENT', 'plan')) || undefined,
      };
    } else if (!apiKey) {
      throw new BadRequestException(
        `El proveedor '${name}' no tiene API key configurada. Cargala en /settings (${keys.apiKey}).`,
      );
    }

    return { apiKey, model, baseUrl: baseUrl || undefined };
  }
}
