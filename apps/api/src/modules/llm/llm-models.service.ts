import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

export interface ModelListResult {
  provider: string;
  models: string[];
  /** 'api' = consultado al proveedor · 'fallback' = lista conocida hardcodeada */
  source: 'api' | 'fallback';
  /** Por qué se cayó al fallback, para mostrarlo en la UI. */
  message?: string;
}

/** Listas mínimas para que el dropdown nunca quede vacío si la API no responde. */
const FALLBACK_MODELS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  gemini: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
  claude: [
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
  ],
  openrouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-flash-1.5'],
  // opencode expone modelos según lo que tenga configurado *esa* instancia, así que
  // cualquier lista fija sería inventada. Vacío → la UI cae al campo de texto libre.
  opencodego: [],
};

/**
 * Modelos que devuelve la API pero no sirven para chat (embeddings, audio, imagen).
 * Filtramos por prefijo/substring para no ofrecerlos en el dropdown.
 */
const NON_CHAT_PATTERNS = [
  'embedding',
  'whisper',
  'tts',
  'dall-e',
  'moderation',
  'audio',
  'realtime',
  'transcribe',
  'image',
  'aqa',
];

const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class LlmModelsService {
  private readonly logger = new Logger(LlmModelsService.name);
  private readonly cache = new Map<string, { at: number; result: ModelListResult }>();

  constructor(private readonly appConfig: AppConfigService) {}

  async listModels(provider: string, forceRefresh = false): Promise<ModelListResult> {
    const name = provider.toLowerCase();

    if (!forceRefresh) {
      const hit = this.cache.get(name);
      // Sin Date.now() cacheado a propósito: el TTL es corto y la consulta es barata.
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
    }

    const result = await this.fetchModels(name);
    this.cache.set(name, { at: Date.now(), result });
    return result;
  }

  private fallback(provider: string, message: string): ModelListResult {
    return {
      provider,
      models: FALLBACK_MODELS[provider] ?? [],
      source: 'fallback',
      message,
    };
  }

  private async fetchModels(provider: string): Promise<ModelListResult> {
    try {
      switch (provider) {
        case 'openai':
          return await this.fromOpenAiCompatible(
            provider,
            (await this.appConfig.get('OPENAI_BASE_URL')) || 'https://api.openai.com/v1',
            await this.appConfig.get('OPENAI_API_KEY'),
          );

        case 'openrouter':
          // OpenRouter publica el catálogo sin autenticación.
          return await this.fromOpenAiCompatible(
            provider,
            (await this.appConfig.get('OPENROUTER_BASE_URL')) || 'https://openrouter.ai/api/v1',
            await this.appConfig.get('OPENROUTER_API_KEY'),
            { keyOptional: true },
          );

        case 'opencodego': {
          const baseUrl = await this.appConfig.get('OPENCODEGO_API_URL');
          if (!baseUrl) {
            return this.fallback(provider, 'Falta configurar el host (OPENCODEGO_API_URL).');
          }
          return await this.fromOpenCode(provider, baseUrl);
        }

        case 'gemini':
          return await this.fromGemini(provider);

        case 'claude':
          return await this.fromAnthropic(provider);

        default:
          return this.fallback(provider, `Proveedor desconocido: ${provider}`);
      }
    } catch (err: any) {
      const message = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'El proveedor no respondió a tiempo.'
        : `No se pudo consultar el proveedor: ${err?.message ?? 'error desconocido'}`;
      this.logger.warn(`listModels(${provider}) falló: ${message}`);
      return this.fallback(provider, message);
    }
  }

  private async fromOpenAiCompatible(
    provider: string,
    baseUrl: string,
    apiKey?: string,
    opts: { keyOptional?: boolean } = {},
  ): Promise<ModelListResult> {
    if (!apiKey && !opts.keyOptional) {
      return this.fallback(provider, 'Cargá la API key para ver los modelos disponibles.');
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const body = (await this.requestJson(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })) as { data?: Array<{ id?: string }> };

    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id);

    return { provider, models: this.clean(models), source: 'api' };
  }

  /**
   * opencode (opencode.ai) NO es compatible con OpenAI: no expone `/models` y su
   * SPA responde HTML con 200 a cualquier ruta desconocida. El catálogo real está
   * en `GET /config/providers`, con la forma:
   *   { providers: [ { id, models: { "<modelId>": {...} } } ], default: {...} }
   *
   * Devolvemos `providerID/modelID` porque opencode direcciona los modelos por
   * ese par, y un mismo modelo puede venir de varios proveedores configurados.
   */
  private async fromOpenCode(provider: string, baseUrl: string): Promise<ModelListResult> {
    const url = `${baseUrl.replace(/\/+$/, '')}/config/providers`;
    const body = (await this.requestJson(url)) as {
      providers?: Array<{ id?: string; models?: Record<string, unknown> }>;
    };

    if (!Array.isArray(body.providers)) {
      return this.fallback(
        provider,
        'El host respondió pero no expone /config/providers. ¿Es un servidor de opencode?',
      );
    }

    const models: string[] = [];
    for (const p of body.providers) {
      if (!p.id || !p.models) continue;
      for (const modelId of Object.keys(p.models)) {
        models.push(`${p.id}/${modelId}`);
      }
    }

    if (models.length === 0) {
      return this.fallback(provider, 'opencode no tiene proveedores con modelos configurados.');
    }

    return { provider, models: this.clean(models), source: 'api' };
  }

  private async fromGemini(provider: string): Promise<ModelListResult> {
    const apiKey = await this.appConfig.get('GEMINI_API_KEY');
    if (!apiKey) {
      return this.fallback(provider, 'Cargá la API key para ver los modelos disponibles.');
    }

    const body = (await this.requestJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    )) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };

    const models = (body.models ?? [])
      // Solo los que sirven para chat.
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name?.replace(/^models\//, ''))
      .filter((id): id is string => !!id);

    return { provider, models: this.clean(models), source: 'api' };
  }

  private async fromAnthropic(provider: string): Promise<ModelListResult> {
    const apiKey = await this.appConfig.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return this.fallback(provider, 'Cargá la API key para ver los modelos disponibles.');
    }

    const body = (await this.requestJson('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })) as { data?: Array<{ id?: string }> };

    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id);

    return { provider, models: this.clean(models), source: 'api' };
  }

  /**
   * GET + parseo de JSON con diagnóstico usable.
   *
   * Muchos hosts (SPAs, portales cautivos, proxies) responden **200 con HTML** a
   * rutas que no existen. Si dejáramos que `res.json()` explotara solo, el usuario
   * vería `Unexpected token '<'`, que no dice nada. Chequeamos el content-type y
   * devolvemos un mensaje que apunte al problema real.
   */
  private async requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

    if (!res.ok) {
      // El body puede traer el motivo real (key inválida, cuota, etc.).
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      const preview = (await res.text().catch(() => '')).trim().slice(0, 60);
      const looksLikeHtml = preview.toLowerCase().startsWith('<!doctype') || preview.startsWith('<');
      throw new Error(
        looksLikeHtml
          ? `${url} devolvió HTML en vez de JSON: la URL apunta a una interfaz web, no a la API.`
          : `${url} respondió '${contentType || 'sin content-type'}' en vez de JSON.`,
      );
    }

    return res.json();
  }

  /** Saca modelos que no sirven para chat, deduplica y ordena. */
  private clean(models: string[]): string[] {
    const chat = models.filter(
      (id) => !NON_CHAT_PATTERNS.some((p) => id.toLowerCase().includes(p)),
    );
    return [...new Set(chat)].sort();
  }
}
