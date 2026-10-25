import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { AppConfigService } from '../../config/app-config.service';
import { LlmProvider, ResolvedProviderConfig } from './llm-provider.interface';
import { anthropicWithTools, openAiCompatibleWithTools } from './providers/tool-calling';
import { VOICE_LLM_CREDENTIALS, VoiceLlmProvider } from '../settings/voicebot-settings.catalog';

/** Solo la parte de tools de un provider: lo que usa el loop (`runToolLoop`). */
export type LlmToolProvider = Required<Pick<LlmProvider, 'generateWithTools'>>;
import { OpenAiProvider } from './providers/openai.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { ClaudeProvider } from './providers/claude.provider';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { OpenCodeGoProvider } from './providers/opencodego.provider';
import { MiniMaxProvider } from './providers/minimax.provider';

/** Claves de configuración de cada proveedor y sus defaults. */
const PROVIDER_KEYS = {
  openai: { apiKey: 'OPENAI_API_KEY', model: 'OPENAI_MODEL', baseUrl: 'OPENAI_BASE_URL', defaultModel: 'gpt-4o-mini' },
  gemini: { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL', baseUrl: null, defaultModel: 'gemini-1.5-flash' },
  claude: { apiKey: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL', baseUrl: null, defaultModel: 'claude-3-5-sonnet-20241022' },
  openrouter: { apiKey: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL', baseUrl: 'OPENROUTER_BASE_URL', defaultModel: 'openai/gpt-4o-mini' },
  opencodego: { apiKey: 'OPENCODEGO_API_KEY', model: 'OPENCODEGO_MODEL', baseUrl: 'OPENCODEGO_API_URL', defaultModel: 'opencode-go-1' },
  minimax: { apiKey: 'MINIMAX_API_KEY', model: 'MINIMAX_MODEL', baseUrl: 'MINIMAX_BASE_URL', defaultModel: 'MiniMax-M2.5' },
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
  minimax: 'minimax',
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
      case 'minimax':
        return new MiniMaxProvider(config);
    }
  }

  /**
   * Provider de tools con la config del LLM de voz (`VOICEBOT_LLM_*`, C53), para elegir las tools
   * de la fuente por voz (C61, decisión del usuario 2026-10-25): el del chat razona y no entra en
   * el tiempo de un turno. Mismas credenciales que pci le sirve al voicebot
   * (`VOICE_LLM_CREDENTIALS`); MiniMax por la interfaz anthropic va con `thinking: disabled`, como
   * en el voicebot. `null` si falta la key: el llamador sigue sin tools.
   */
  async createVoiceToolProvider(): Promise<LlmToolProvider | null> {
    const provider = ((await this.appConfig.get('VOICEBOT_LLM_PROVIDER', 'minimax')) ?? 'minimax') as VoiceLlmProvider;
    const creds = VOICE_LLM_CREDENTIALS[provider];
    if (!creds) return null;
    const model = (await this.appConfig.get('VOICEBOT_LLM_MODEL', 'MiniMax-M3')) || 'MiniMax-M3';
    const apiKey = (await this.appConfig.get(creds.apiKeyKey)) ?? '';
    if (!apiKey) return null;
    const baseUrl =
      ((await this.appConfig.get('VOICEBOT_LLM_BASE_URL')) || (creds.baseUrlKey ? await this.appConfig.get(creds.baseUrlKey) : '')) ?? '';

    switch (provider) {
      case 'minimax': {
        const v1 = (baseUrl || 'https://api.minimax.io/v1').replace(/\/+$/, '');
        if ((await this.appConfig.get('VOICEBOT_LLM_API', 'anthropic')) === 'openai') {
          const client = new OpenAI({ apiKey, baseURL: v1, maxRetries: 0 });
          return {
            generateWithTools: (m, t, tools, o) => openAiCompatibleWithTools(client, model, m, t, tools, o, { reasoning_split: true }),
          };
        }
        // La interfaz anthropic de MiniMax vive en la raíz del host, bajo /anthropic (igual que el voicebot).
        const client = new Anthropic({ apiKey, baseURL: `${v1.replace(/\/v1$/, '')}/anthropic`, maxRetries: 0 });
        return {
          generateWithTools: (m, t, tools, o) =>
            anthropicWithTools(client, model, m, t, tools, o, { thinking: { type: 'disabled' } }),
        };
      }
      case 'claude':
        return new ClaudeProvider({ apiKey, model, baseUrl: baseUrl || undefined });
      case 'openai':
        return new OpenAiProvider({ apiKey, model, baseUrl: baseUrl || undefined });
      case 'openrouter':
        return new OpenRouterProvider({ apiKey, model, baseUrl: baseUrl || undefined });
      case 'gemini':
        return new GeminiProvider({ apiKey, model });
      default:
        return null;
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
