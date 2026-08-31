/**
 * 1.10 LLM — proveedores y modelos (BE-LLM-*)
 *
 * Vía: no hay endpoint HTTP genérico de "chat" (el motor de conversaciones es el único
 * consumidor real de `LlmService.chat()`), así que estos tests llaman directo a los servicios
 * (`LlmProviderFactory`, `LlmModelsService`, `LlmService`) sacados del `moduleRef` de una app
 * real — mismo patrón que sugiere el README para "un test más unitario".
 *
 * Frontera mockeada: SOLO el SDK/HTTP del proveedor externo (`fetch`, vía `installFetchMock`) o,
 * cuando lo que se prueba es el merge de parámetros / `stripThinking` de `LlmService` (no la
 * `LlmProviderFactory` en sí), un `LlmProviderFactory` fake que devuelve un provider controlable
 * — exactamente el patrón que documenta `test/support/README.md` ("Para inyectar un provider
 * fake usá override del LlmProviderFactory vía createTestApp({customize})"). La lógica bajo
 * prueba (`LlmProviderFactory.resolveConfig`/alias/fallback, `LlmService.chat`/`stripThinking`)
 * nunca se mockea.
 *
 * Dos apps conviven en este spec:
 *  - `t`: app por defecto, con la `LlmProviderFactory` REAL — para BE-LLM-02/03/04/05 (la config
 *    y el alias/fallback son justamente lo que se prueba) y BE-LLM-08/09/11/12 (con `fetch`
 *    mockeado, para que la factory real construya el provider real de verdad, HTTP incluido).
 *  - `tFake`: app con `LlmProviderFactory` overrideada por un fake que devuelve un
 *    `FakeProvider` controlable — para BE-LLM-10/17/18/20, donde lo que se prueba es el merge de
 *    parámetros y `stripThinking` de `LlmService`, no la factory.
 *
 * Bloqueados (BE-LLM-01/06/07/13/14/15/16): el plan pide una key real de un proveedor externo
 * (OpenAI/Claude/Gemini/OpenRouter/MiniMax) para verificar que la respuesta es la del modelo de
 * verdad. Mockear el SDK ahí vaciaría el caso.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import {
  createTestApp,
  TestApp,
  setSetting,
  deleteSetting,
  installFetchMock,
} from './support';
import { LlmService } from '../src/modules/llm/llm.service';
import { LlmProviderFactory } from '../src/modules/llm/llm-provider.factory';
import { LlmModelsService } from '../src/modules/llm/llm-models.service';
import type {
  LlmMessage,
  LlmCompletionOptions,
  LlmProvider,
} from '../src/modules/llm/llm-provider.interface';
import { OpenAiProvider } from '../src/modules/llm/providers/openai.provider';
import { GeminiProvider } from '../src/modules/llm/providers/gemini.provider';
import { ClaudeProvider } from '../src/modules/llm/providers/claude.provider';
import { OpenCodeGoProvider } from '../src/modules/llm/providers/opencodego.provider';

/** Todas las keys de Setting que este spec puede llegar a tocar (limpieza global en afterEach). */
const LLM_SETTING_KEYS = [
  'LLM_PROVIDER',
  'LLM_TEMPERATURE',
  'LLM_MAX_TOKENS',
  'LLM_SYSTEM_PROMPT',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODEGO_API_URL',
  'OPENCODEGO_API_KEY',
  'OPENCODEGO_AGENT',
];

/**
 * Provider de test controlable: reemplaza al SDK real cuando lo bajo prueba es `LlmService`
 * (merge de parámetros, `stripThinking`), no la factory. Grabar `calls` permite verificar
 * exactamente qué `messages`/`options` armó `LlmService.chat()` antes de llamar al provider.
 */
class FakeProvider implements LlmProvider {
  public readonly calls: { messages: LlmMessage[]; options?: LlmCompletionOptions }[] = [];
  private reply = 'ok';

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    this.calls.push({ messages, options });
    return this.reply;
  }

  setReply(text: string): this {
    this.reply = text;
    return this;
  }
}

/** Fake de `LlmProviderFactory`: mismo contrato (`createProvider()`), sin resolver config real. */
class FakeProviderFactory {
  provider = new FakeProvider();
  async createProvider(): Promise<LlmProvider> {
    return this.provider;
  }
}

describe('1.10 LLM — proveedores y modelos (BE-LLM-*)', () => {
  let t: TestApp;
  let tFake: TestApp;
  const fakeProviderFactory = new FakeProviderFactory();

  beforeAll(async () => {
    t = await createTestApp();
    tFake = await createTestApp({
      customize: (b) => b.overrideProvider(LlmProviderFactory).useValue(fakeProviderFactory),
    });
  });

  afterAll(async () => {
    await t.close();
    await tFake.close();
  });

  beforeEach(() => {
    // Cada test arranca con un FakeProvider limpio (sin calls acumuladas de otro caso).
    fakeProviderFactory.provider = new FakeProvider();
  });

  afterEach(async () => {
    // Settings globales (Setting.key es único en toda la base): limpiar siempre.
    for (const key of LLM_SETTING_KEYS) {
      await deleteSetting(t.prisma, key);
    }
  });

  // --- BLOQUEADOS: requieren una key real de un proveedor externo vivo ---

  it.skip('BE-LLM-01: chat() con proveedor OpenAI configurado y key válida devuelve la respuesta del modelo [BLOQUEADO: requiere key real de OpenAI]', () => {});

  it.skip('BE-LLM-06: GET /settings/providers/:provider/models con key válida devuelve la lista real (source:api) [BLOQUEADO: requiere key real]', () => {});

  it.skip('BE-LLM-07: el mismo endpoint con ?refresh=true saltea la caché y reconsulta al proveedor real [BLOQUEADO: requiere key real (depende de BE-LLM-06 para tener algo que "saltear")]', () => {});

  it.skip('BE-LLM-13: chat() con proveedor Claude (alias anthropic) y key válida devuelve la respuesta del modelo [BLOQUEADO: requiere key real de Anthropic]', () => {});

  it.skip('BE-LLM-14: chat() con proveedor Gemini (alias google) y key válida devuelve la respuesta del modelo [BLOQUEADO: requiere key real de Gemini]', () => {});

  it.skip('BE-LLM-15: chat() con proveedor OpenRouter y key válida devuelve la respuesta del modelo [BLOQUEADO: requiere key real de OpenRouter]', () => {});

  it.skip('BE-LLM-16: chat() con proveedor MiniMax y key válida devuelve la respuesta del modelo [BLOQUEADO: requiere key real de MiniMax]', () => {});

  // --- LlmProviderFactory: resolución de config (app `t`, factory REAL) ---

  it('BE-LLM-02: proveedor sin API key (los que la requieren) devuelve 400 al resolver la config', async () => {
    const factory = t.moduleRef.get(LlmProviderFactory, { strict: false });
    // LLM_PROVIDER sin fijar cae al default 'openai' (mismo valor que ya trae el .env de test);
    // OPENAI_API_KEY tampoco está fijada (ni en BD ni en el .env de test, que la deja vacía).
    let error: any;
    try {
      await factory.createProvider();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('OPENAI_API_KEY');
  });

  it('BE-LLM-03: OpenCode Go sin OPENCODEGO_API_URL (baseUrl) devuelve 400, sin exigir key', async () => {
    const factory = t.moduleRef.get(LlmProviderFactory, { strict: false });
    await setSetting(t.prisma, 'LLM_PROVIDER', 'opencodego');
    // OPENCODEGO_API_URL no se fija (ni BD ni env). OPENCODEGO_API_KEY tampoco: para este
    // proveedor la key es opcional, así que el 400 tiene que ser por la baseUrl, no por la key.

    let error: any;
    try {
      await factory.createProvider();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('OPENCODEGO_API_URL');
  });

  it('BE-LLM-04: los alias de proveedor resuelven a la clase de provider correcta', async () => {
    const factory = t.moduleRef.get(LlmProviderFactory, { strict: false });

    // google → gemini
    await setSetting(t.prisma, 'LLM_PROVIDER', 'google');
    await setSetting(t.prisma, 'GEMINI_API_KEY', 'fake-gemini-key-para-test');
    expect(await factory.createProvider()).toBeInstanceOf(GeminiProvider);

    // anthropic → claude
    await setSetting(t.prisma, 'LLM_PROVIDER', 'anthropic');
    await setSetting(t.prisma, 'ANTHROPIC_API_KEY', 'sk-ant-fake-key-para-test');
    expect(await factory.createProvider()).toBeInstanceOf(ClaudeProvider);

    // opencode → opencodego (acá la key es opcional; lo obligatorio es la baseUrl)
    await setSetting(t.prisma, 'LLM_PROVIDER', 'opencode');
    await setSetting(t.prisma, 'OPENCODEGO_API_URL', 'http://opencode.test');
    expect(await factory.createProvider()).toBeInstanceOf(OpenCodeGoProvider);
  });

  it('BE-LLM-05: proveedor desconocido en LLM_PROVIDER cae a OpenAI con un warning', async () => {
    const factory = t.moduleRef.get(LlmProviderFactory, { strict: false });
    await setSetting(t.prisma, 'LLM_PROVIDER', 'proveedor-inventado-xyz');
    // Para que el fallback llegue a construirse de verdad (y no explote antes por falta de key).
    await setSetting(t.prisma, 'OPENAI_API_KEY', 'sk-fake-openai-key-para-test');

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
    let provider: LlmProvider;
    try {
      provider = await factory.createProvider();
      // Leer las calls ANTES de mockRestore(), que las limpia.
      expect(
        warnSpy.mock.calls.some((args) =>
          args.some((a) => typeof a === 'string' && a.includes('proveedor-inventado-xyz')),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    expect(provider!).toBeInstanceOf(OpenAiProvider);
  });

  // --- LlmModelsService: listar modelos (app `t`, factory REAL, fetch mockeado) ---

  it('BE-LLM-08: proveedor caído devuelve source:fallback + motivo; opencodego cae a lista vacía', async () => {
    const models = t.moduleRef.get(LlmModelsService, { strict: false });
    const fm = installFetchMock(() => {
      throw new Error('ECONNREFUSED (simulado): el proveedor no responde');
    });

    try {
      await setSetting(t.prisma, 'OPENAI_API_KEY', 'sk-fake-openai-key-para-test');
      const openaiResult = await models.listModels('openai', true);
      expect(openaiResult.source).toBe('fallback');
      expect(openaiResult.message).toBeDefined();
      // Para la mayoría de proveedores el fallback es una lista conocida no vacía.
      expect(openaiResult.models.length).toBeGreaterThan(0);

      await setSetting(t.prisma, 'OPENCODEGO_API_URL', 'http://opencode.test');
      const opencodeResult = await models.listModels('opencodego', true);
      expect(opencodeResult.source).toBe('fallback');
      // Excepción a propósito: los modelos de opencode dependen de la instancia, así que
      // FALLBACK_MODELS.opencodego está vacío (la UI cae al campo de texto libre).
      expect(opencodeResult.models).toEqual([]);
    } finally {
      fm.restore();
    }
  });

  it('BE-LLM-09: proveedor cuya API responde HTML 200 en vez de JSON se detecta por content-type', async () => {
    const models = t.moduleRef.get(LlmModelsService, { strict: false });
    const fm = installFetchMock((url) => {
      if (url.includes('/models')) {
        return { status: 200, body: '<!doctype html><html><body>No es una API</body></html>' };
      }
      return { status: 404 };
    });

    try {
      // OpenRouter no exige key para listar modelos (keyOptional:true en el código).
      const result = await models.listModels('openrouter', true);
      expect(result.source).toBe('fallback');
      expect(result.message).toMatch(/HTML/i);
    } finally {
      fm.restore();
    }
  });

  // --- OpenCode Go: provider real, HTTP mockeado (app `t`) ---

  it('BE-LLM-11: OpenCode Go — de una respuesta con partes reasoning + text, solo el text llega', async () => {
    await setSetting(t.prisma, 'LLM_PROVIDER', 'opencodego');
    await setSetting(t.prisma, 'OPENCODEGO_API_URL', 'http://opencode.test');

    const fm = installFetchMock((url, init) => {
      if (url.endsWith('/session') && init?.method === 'POST') {
        return { status: 200, body: { id: 'sess-abc' } };
      }
      if (url.includes('/session/sess-abc/message') && init?.method === 'POST') {
        return {
          status: 200,
          body: {
            parts: [
              { type: 'reasoning', text: 'razonamiento interno del modelo, no debe salir' },
              { type: 'text', text: 'Respuesta final del asistente' },
            ],
          },
        };
      }
      if (url.includes('/session/sess-abc') && init?.method === 'DELETE') {
        return { status: 200, body: {} };
      }
      return { status: 404 };
    });

    try {
      const llm = t.moduleRef.get(LlmService, { strict: false });
      const res = await llm.chat([{ role: 'user', content: 'hola' }]);

      expect(res).toBe('Respuesta final del asistente');
      expect(res).not.toContain('razonamiento interno');
    } finally {
      fm.restore();
    }
  });

  it('BE-LLM-12: OpenCode Go — sin configurar OPENCODEGO_AGENT, el agent enviado es "plan" (no "build")', async () => {
    await setSetting(t.prisma, 'LLM_PROVIDER', 'opencodego');
    await setSetting(t.prisma, 'OPENCODEGO_API_URL', 'http://opencode.test');
    // OPENCODEGO_AGENT deliberadamente sin fijar: debe caer al default 'plan' de la factory.

    const fm = installFetchMock((url, init) => {
      if (url.endsWith('/session') && init?.method === 'POST') {
        return { status: 200, body: { id: 'sess-agent' } };
      }
      if (url.includes('/session/sess-agent/message') && init?.method === 'POST') {
        return { status: 200, body: { parts: [{ type: 'text', text: 'ok' }] } };
      }
      if (url.includes('/session/sess-agent') && init?.method === 'DELETE') {
        return { status: 200, body: {} };
      }
      return { status: 404 };
    });

    try {
      const llm = t.moduleRef.get(LlmService, { strict: false });
      await llm.chat([{ role: 'user', content: 'hola' }]);

      const messageReq = fm.requests.find((r) => r.url.includes('/message'));
      expect(messageReq).toBeDefined();
      const body = JSON.parse(messageReq!.init!.body as string);
      expect(body.agent).toBe('plan');
      expect(body.agent).not.toBe('build'); // build ejecuta herramientas sobre el server: peligroso
    } finally {
      fm.restore();
    }
  });

  // --- LlmService: merge de parámetros y stripThinking (app `tFake`, factory FAKE) ---

  it('BE-LLM-10: merge de parámetros — caller > BD > env/default', async () => {
    const llm = tFake.moduleRef.get(LlmService, { strict: false });

    // 1) BD gana sobre env/default: el .env de test fija LLM_TEMPERATURE=0.7 (igual al default),
    //    así que solo un valor de BD distinto prueba que la cascada lo prioriza.
    await setSetting(tFake.prisma, 'LLM_TEMPERATURE', '0.35');
    await llm.chat([{ role: 'user', content: 'hola' }]);
    expect(fakeProviderFactory.provider.calls[0].options?.temperature).toBe(0.35);

    // 2) El caller gana sobre la BD: BD dice 500, el caller pide 42.
    await setSetting(tFake.prisma, 'LLM_MAX_TOKENS', '500');
    await llm.chat([{ role: 'user', content: 'hola' }], { maxTokens: 42 });
    expect(fakeProviderFactory.provider.calls[1].options?.maxTokens).toBe(42);

    // 3) Mismo orden para systemPrompt, y además se antepone como mensaje `system` cuando el
    //    primer mensaje no lo es (ver LlmService.chat).
    await setSetting(tFake.prisma, 'LLM_SYSTEM_PROMPT', 'PROMPT-DE-BD');
    await llm.chat([{ role: 'user', content: 'hola' }], { systemPrompt: 'PROMPT-DEL-CALLER' });
    const lastCall = fakeProviderFactory.provider.calls[2];
    expect(lastCall.options?.systemPrompt).toBe('PROMPT-DEL-CALLER');
    expect(lastCall.messages[0]).toEqual({ role: 'system', content: 'PROMPT-DEL-CALLER' });
  });

  it('BE-LLM-17: un <think>...</think> cerrado se filtra siempre, sin importar el proveedor', async () => {
    fakeProviderFactory.provider.setReply(
      '<think>razonando en voz alta sobre qué responder</think>Hola, ¿en qué te ayudo?',
    );
    const llm = tFake.moduleRef.get(LlmService, { strict: false });

    const res = await llm.chat([{ role: 'user', content: 'hola' }]);

    expect(res).toBe('Hola, ¿en qué te ayudo?');
    expect(res).not.toContain('razonando');
  });

  it('BE-LLM-18: un <think> abierto sin cerrar corta desde ahí; la respuesta puede quedar vacía', async () => {
    // Simula que max_tokens se agotó a mitad del razonamiento: no hay tag de cierre.
    fakeProviderFactory.provider.setReply('<think>el modelo se quedó sin tokens a mitad de');
    const llm = tFake.moduleRef.get(LlmService, { strict: false });

    const res = await llm.chat([{ role: 'user', content: 'hola' }]);

    // Deliberado (comentario en stripThinking): mejor vacío que mostrar el razonamiento crudo.
    expect(res).toBe('');
  });

  it.skip(
    'BE-LLM-19: los clasificadores de intención usan maxTokens=300 (CLASSIFIER_MAX_TOKENS) para que el ' +
      'razonamiento no agote el presupuesto [BLOQUEADO: requiere el motor de conversaciones]',
    () => {
      // Confirmado leyendo el código (no ejecutado acá):
      //   apps/api/src/modules/conversations/conversations.service.ts:82
      //     const CLASSIFIER_MAX_TOKENS = 300;
      //   Se usa como `maxTokens` en los 3 clasificadores por LLM (cierre de charla, confirmación
      //   de cancelación, interpretación de menú), todos vía `this.llmService.chat(...)`.
      // Es una constante de módulo PRIVADA (no exportada), y los 3 clasificadores son métodos
      // privados de `ConversationsService`: la única forma de ejercitarla es disparando una
      // conversación real a través del motor de flujos (`POST /conversations/simulate`), que es
      // el bloque CHAT-* (2.7 "LLM dentro/fuera"), no este. Acá, en el módulo LLM en sí, no hay
      // nada que distinga "maxTokens para un clasificador" de "maxTokens para cualquier chat":
      // BE-LLM-10 ya prueba que el `maxTokens` que pasa el caller efectivamente llega al
      // provider, que es el mecanismo del que depende este caso.
    },
  );

  it('BE-LLM-20: LLM_MAX_TOKENS bajo + modelo razonador puede hacer que la respuesta llegue vacía', async () => {
    // Tope deliberadamente insuficiente para que el <think> se coma todo el presupuesto — el
    // modo de falla que describe el plan para el chat conversacional normal (no contemplado como
    // en los clasificadores, que usan su propio CLASSIFIER_MAX_TOKENS más generoso).
    await setSetting(tFake.prisma, 'LLM_MAX_TOKENS', '10');
    fakeProviderFactory.provider.setReply('<think>necesito pensar bastante sobre esto y');
    const llm = tFake.moduleRef.get(LlmService, { strict: false });

    const res = await llm.chat([{ role: 'user', content: 'hola' }]);

    // El merge respetó el tope bajo configurado (mismo mecanismo que BE-LLM-10)...
    expect(fakeProviderFactory.provider.calls.at(-1)?.options?.maxTokens).toBe(10);
    // ...y stripThinking corta desde el <think> abierto: la respuesta llega vacía al usuario.
    expect(res).toBe('');
  });
});
