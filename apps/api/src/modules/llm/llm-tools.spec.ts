/**
 * Function calling: el loop provider-agnostic de `LlmService.chatWithTools` y la traducción de
 * turnos de cada familia de proveedor (OpenAI-compatible, Claude, Gemini). Los clientes de los
 * SDK se reemplazan por dobles que registran el request y devuelven respuestas armadas.
 */
import { LlmService } from './llm.service';
import type { LlmProvider, LlmToolDefinition, LlmTurn } from './llm-provider.interface';
import { openAiCompatibleWithTools } from './providers/openai-tools';
import { ClaudeProvider } from './providers/claude.provider';
import { GeminiProvider } from './providers/gemini.provider';

const TOOLS: LlmToolDefinition[] = [
  {
    name: 'get_vacation_balance',
    description: 'Saldo de vacaciones',
    parameters: { type: 'object', properties: { employee: { type: 'string' } }, additionalProperties: false, $schema: 'x' },
  },
  { name: 'whoami', description: 'Quién soy', parameters: { type: 'object', properties: {} } },
];

function serviceWith(provider: LlmProvider) {
  const factory = { createProvider: jest.fn().mockResolvedValue(provider) };
  const appConfig = {
    getNumber: jest.fn().mockImplementation((_k: string, d: number) => Promise.resolve(d)),
    get: jest.fn().mockResolvedValue(undefined),
  };
  return new LlmService(factory as never, appConfig as never);
}

describe('LlmService.chatWithTools', () => {
  it('ejecuta las tools pedidas y devuelve la respuesta final del modelo', async () => {
    const seen: LlmTurn[][] = [];
    const provider: LlmProvider = {
      generateCompletion: jest.fn(),
      generateWithTools: jest.fn().mockImplementation(async (turns: LlmTurn[]) => {
        seen.push([...turns]);
        return seen.length === 1
          ? { text: '', toolCalls: [{ id: 'c1', name: 'get_vacation_balance', arguments: {} }] }
          : { text: '<think>pienso</think>Te quedan 14 días.', toolCalls: [] };
      }),
    };
    const execute = jest.fn().mockResolvedValue('{"totalAvailableDays":14}');

    const answer = await serviceWith(provider).chatWithTools([{ role: 'user', content: '¿cuántos días me quedan?' }], TOOLS, execute);

    expect(answer).toBe('Te quedan 14 días.');
    expect(execute).toHaveBeenCalledWith({ id: 'c1', name: 'get_vacation_balance', arguments: {} });
    expect(seen[1].slice(-2)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_vacation_balance', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', name: 'get_vacation_balance', content: '{"totalAvailableDays":14}' },
    ]);
  });

  it('un error de la tool vuelve al modelo como resultado, sin cortar la charla', async () => {
    let call = 0;
    const provider: LlmProvider = {
      generateCompletion: jest.fn(),
      generateWithTools: jest.fn().mockImplementation(async (turns: LlmTurn[]) => {
        call++;
        if (call === 1) return { text: '', toolCalls: [{ id: 'x', name: 'whoami', arguments: {} }] };
        const last = turns[turns.length - 1] as { content: string };
        return { text: `Hubo un problema: ${last.content}`, toolCalls: [] };
      }),
    };
    const answer = await serviceWith(provider).chatWithTools(
      [{ role: 'user', content: 'hola' }],
      TOOLS,
      jest.fn().mockRejectedValue(new Error('sin permiso')),
    );
    expect(answer).toBe('Hubo un problema: Error al ejecutar whoami: sin permiso');
  });

  it('corta en maxSteps y fuerza la respuesta', async () => {
    const provider: LlmProvider = {
      generateCompletion: jest.fn(),
      generateWithTools: jest.fn().mockResolvedValue({ text: '', toolCalls: [{ id: 'l', name: 'whoami', arguments: {} }] }),
    };
    const answer = await serviceWith(provider).chatWithTools([{ role: 'user', content: 'x' }], TOOLS, async () => 'ok', {
      maxSteps: 2,
    });
    expect(provider.generateWithTools).toHaveBeenCalledTimes(3);
    expect(answer).toMatch(/No pude completar/);
  });

  it('supportsTools refleja si el provider implementa function calling', async () => {
    expect(await serviceWith({ generateCompletion: jest.fn() }).supportsTools()).toBe(false);
    expect(await serviceWith({ generateCompletion: jest.fn(), generateWithTools: jest.fn() }).supportsTools()).toBe(true);
  });
});

const TURNS: LlmTurn[] = [
  { role: 'system', content: 'Sos un asistente.' },
  { role: 'system', content: 'Contexto extra.' },
  { role: 'user', content: '¿Cuántos días me quedan?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'get_vacation_balance', arguments: { employee: '1005' } }] },
  { role: 'tool', toolCallId: 't1', name: 'get_vacation_balance', content: '14' },
];

describe('openAiCompatibleWithTools', () => {
  it('traduce turnos y tools al formato de Chat Completions y parsea tool_calls', async () => {
    const create = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 'n1', type: 'function', function: { name: 'whoami', arguments: '{"a":1}' } }],
          },
        },
      ],
    });
    const client = { chat: { completions: { create } } };
    const res = await openAiCompatibleWithTools(client as never, 'gpt-x', TURNS, TOOLS, { maxTokens: 50 }, { reasoning_split: true });

    const body = create.mock.calls[0][0];
    expect(body.messages[3]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_vacation_balance', arguments: '{"employee":"1005"}' } }],
    });
    expect(body.messages[4]).toEqual({ role: 'tool', tool_call_id: 't1', content: '14' });
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'get_vacation_balance' } });
    expect(body.reasoning_split).toBe(true);
    expect(res).toEqual({ text: '', toolCalls: [{ id: 'n1', name: 'whoami', arguments: { a: 1 } }] });
  });
});

describe('ClaudeProvider.generateWithTools', () => {
  it('junta los system, usa tool_use / tool_result y lee los bloques de respuesta', async () => {
    const provider = new ClaudeProvider({ apiKey: 'k', model: 'claude-x' });
    const create = jest.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Busco… ' },
        { type: 'tool_use', id: 'tu1', name: 'whoami', input: {} },
      ],
    });
    (provider as any).client = { messages: { create } };

    const res = await provider.generateWithTools(TURNS, TOOLS);
    const body = create.mock.calls[0][0];
    expect(body.system).toBe('Sos un asistente.\n\nContexto extra.');
    expect(body.messages).toEqual([
      { role: 'user', content: '¿Cuántos días me quedan?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_vacation_balance', input: { employee: '1005' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '14' }] },
    ]);
    expect(body.tools[0]).toMatchObject({ name: 'get_vacation_balance', input_schema: TOOLS[0].parameters });
    expect(res).toEqual({ text: 'Busco… ', toolCalls: [{ id: 'tu1', name: 'whoami', arguments: {} }] });
  });
});

describe('GeminiProvider.generateWithTools', () => {
  it('usa functionCall / functionResponse y limpia el schema para Gemini', async () => {
    const provider = new GeminiProvider({ apiKey: 'k', model: 'gemini-x' });
    const generateContent = jest.fn().mockResolvedValue({
      response: { functionCalls: () => [{ name: 'whoami', args: {} }], text: () => '' },
    });
    const getGenerativeModel = jest.fn().mockReturnValue({ generateContent });
    (provider as any).client = { getGenerativeModel };

    const res = await provider.generateWithTools(TURNS, TOOLS);
    expect(getGenerativeModel.mock.calls[0][0].systemInstruction).toBe('Sos un asistente.\n\nContexto extra.');
    const req = generateContent.mock.calls[0][0];
    expect(req.contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_vacation_balance', args: { employee: '1005' } } }] });
    expect(req.contents[2]).toEqual({
      role: 'function',
      parts: [{ functionResponse: { name: 'get_vacation_balance', response: { content: '14' } } }],
    });
    const [withParams, noParams] = req.tools[0].functionDeclarations;
    expect(withParams.parameters).toEqual({ type: 'object', properties: { employee: { type: 'string' } } });
    expect(noParams.parameters).toBeUndefined();
    expect(res.toolCalls).toEqual([{ id: 'gemini_0_whoami', name: 'whoami', arguments: {} }]);
  });
});
