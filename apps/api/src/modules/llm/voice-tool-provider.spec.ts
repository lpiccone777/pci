const created: { options: Record<string, unknown>; bodies: Record<string, unknown>[] }[] = [];
jest.mock('@anthropic-ai/sdk', () =>
  jest.fn().mockImplementation((options: Record<string, unknown>) => {
    const entry = { options, bodies: [] as Record<string, unknown>[] };
    created.push(entry);
    return {
      messages: {
        create: async (body: Record<string, unknown>) => {
          entry.bodies.push(body);
          return { content: [{ type: 'tool_use', id: 't1', name: 'geocoding', input: { name: 'Merlo' } }] };
        },
      },
    };
  }),
);

import { LlmProviderFactory } from './llm-provider.factory';

const factoryWith = (values: Record<string, string>) =>
  new LlmProviderFactory({ get: async (key: string, def?: string) => values[key] ?? def } as never);

describe('LlmProviderFactory.createVoiceToolProvider (C61, tools por voz con el LLM de voz)', () => {
  beforeEach(() => (created.length = 0));

  it('MiniMax por anthropic: raíz /anthropic, sin reintentos y thinking disabled', async () => {
    const provider = await factoryWith({
      VOICEBOT_LLM_PROVIDER: 'minimax',
      VOICEBOT_LLM_MODEL: 'MiniMax-M3',
      VOICEBOT_MINIMAX_API_KEY: 'k',
      VOICEBOT_MINIMAX_BASE_URL: 'https://api.minimax.io/v1/',
    }).createVoiceToolProvider();
    const step = await provider!.generateWithTools([{ role: 'user', content: 'clima en Merlo' }], [], [
      { name: 'geocoding', parameters: { type: 'object' } },
    ], { maxTokens: 400, temperature: 0 });

    expect(step.toolCalls).toEqual([{ id: 't1', name: 'geocoding', arguments: { name: 'Merlo' } }]);
    expect(created[0].options).toMatchObject({ apiKey: 'k', baseURL: 'https://api.minimax.io/anthropic', maxRetries: 0 });
    expect(created[0].bodies[0]).toMatchObject({ model: 'MiniMax-M3', max_tokens: 400, thinking: { type: 'disabled' } });
  });

  it('sin key del LLM de voz, null (por voz se sigue sin tools)', async () => {
    expect(await factoryWith({ VOICEBOT_LLM_PROVIDER: 'minimax' }).createVoiceToolProvider()).toBeNull();
  });
});
