import { runToolLoop, LLM_TOOL_MAX_ROUNDS } from './tool-loop';
import { anthropicWithTools, openAiCompatibleWithTools } from './providers/tool-calling';
import type { LlmToolStep, LlmToolTurn } from './llm-provider.interface';
import { isFixedToolArgument } from '../context-sources/context-sources.service';

const tool = { name: 'buscar', description: 'Busca', parameters: { type: 'object', properties: { q: { type: 'string' } } } };
const msgs = [{ role: 'user' as const, content: 'hola' }];

describe('runToolLoop (C61)', () => {
  it('ejecuta las tools que pide el modelo y le devuelve el resultado hasta que contesta', async () => {
    const seen: LlmToolTurn[][] = [];
    const provider = {
      generateWithTools: async (_m: unknown, turns: LlmToolTurn[]): Promise<LlmToolStep> => {
        seen.push([...turns]);
        return turns.length
          ? { text: '<think>pienso</think>Listo: ' + (turns[1] as { content: string }).content, toolCalls: [] }
          : { text: '', toolCalls: [{ id: 'a', name: 'buscar', arguments: { q: 'x' } }] };
      },
    };
    const execute = jest.fn(async () => ({ ok: true, content: 'dato' }));
    const r = await runToolLoop(provider, msgs, [tool], execute, {});
    expect(r).toMatchObject({ supported: true, text: 'Listo: dato', rounds: 1 });
    expect(execute).toHaveBeenCalledWith({ id: 'a', name: 'buscar', arguments: { q: 'x' } });
    expect(r.calls).toEqual([expect.objectContaining({ round: 1, name: 'buscar', ok: true, content: 'dato' })]);
    expect(seen[1]).toEqual([
      { kind: 'calls', text: undefined, calls: [{ id: 'a', name: 'buscar', arguments: { q: 'x' } }] },
      { kind: 'result', callId: 'a', name: 'buscar', content: 'dato' },
    ]);
  });

  it(`a las ${LLM_TOOL_MAX_ROUNDS} vueltas hace una pasada final sin tools; con stopAfterTools no`, async () => {
    const toolsSeen: number[] = [];
    const provider = {
      generateWithTools: async (_m: unknown, _t: unknown, tools: unknown[]): Promise<LlmToolStep> => {
        toolsSeen.push(tools.length);
        return tools.length
          ? { text: '', toolCalls: [{ id: `c${toolsSeen.length}`, name: 'buscar', arguments: {} }] }
          : { text: 'final', toolCalls: [] };
      },
    };
    const execute = async () => ({ ok: true, content: 'x' });
    const r = await runToolLoop(provider, msgs, [tool], execute, {});
    expect(r).toMatchObject({ text: 'final', rounds: 3 });
    expect(toolsSeen).toEqual([1, 1, 1, 0]);

    toolsSeen.length = 0;
    const v = await runToolLoop(provider, msgs, [tool], execute, {}, { stopAfterTools: true });
    expect(v).toMatchObject({ text: '', rounds: 3 });
    expect(v.calls).toHaveLength(3);
    expect(toolsSeen).toEqual([1, 1, 1]);
  });

  it('un error de la tool vuelve al modelo como resultado; cancelled corta antes de la vuelta siguiente', async () => {
    let n = 0;
    const provider = {
      generateWithTools: async (): Promise<LlmToolStep> => {
        n++;
        return { text: '', toolCalls: [{ id: `c${n}`, name: 'buscar', arguments: {} }] };
      },
    };
    const r = await runToolLoop(
      provider,
      msgs,
      [tool],
      async () => {
        throw new Error('se cayó');
      },
      {},
      { cancelled: () => n >= 1 },
    );
    expect(n).toBe(1);
    expect(r.calls[0]).toMatchObject({ ok: false, content: 'No se pudo consultar: se cayó' });
    expect(r.text).toBe('');
  });
});

describe('traducción por proveedor (C61)', () => {
  it('OpenAI y compatibles: tools como function, turnos como tool_calls + role tool; argumentos JSON parseados', async () => {
    const create = jest.fn(async () => ({
      choices: [{ message: { content: null, tool_calls: [{ id: 'z', type: 'function', function: { name: 'buscar', arguments: '{"q":"merlo"}' } }] } }],
    }));
    const client = { chat: { completions: { create } } } as never;
    const turns: LlmToolTurn[] = [
      { kind: 'calls', calls: [{ id: 'a', name: 'buscar', arguments: { q: 'x' } }] },
      { kind: 'result', callId: 'a', name: 'buscar', content: 'dato' },
    ];
    const step = await openAiCompatibleWithTools(client, 'm', msgs, turns, [tool], {}, { reasoning_split: true });
    expect(step).toEqual({ text: '', toolCalls: [{ id: 'z', name: 'buscar', arguments: { q: 'merlo' } }] });
    const body = (create.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(body.reasoning_split).toBe(true);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'buscar', description: 'Busca', parameters: tool.parameters } }]);
    expect(body.messages.slice(1)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'buscar', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'dato' },
    ]);
  });

  it('Claude: system aparte, tool_use del asistente y los tool_result seguidos en un solo mensaje', async () => {
    const create = jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const client = { messages: { create } } as never;
    const turns: LlmToolTurn[] = [
      { kind: 'calls', calls: [{ id: 'a', name: 'buscar', arguments: {} }, { id: 'b', name: 'buscar', arguments: {} }] },
      { kind: 'result', callId: 'a', name: 'buscar', content: '1' },
      { kind: 'result', callId: 'b', name: 'buscar', content: '2' },
    ];
    const step = await anthropicWithTools(client, 'm', [{ role: 'system', content: 'S' }, ...msgs], turns, [], {});
    expect(step).toEqual({ text: 'ok', toolCalls: [] });
    const body = (create.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(body.system).toBe('S');
    expect(body.tools).toBeUndefined(); // pasada final, sin tools
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: '1' },
        { type: 'tool_result', tool_use_id: 'b', content: '2' },
      ],
    });
  });
});

describe('isFixedToolArgument (C61)', () => {
  it('fijo = valor real; {{pregunta}}, vacío, 0 y false los completa el LLM', () => {
    expect(['celsius', 2, true, ['a'], { a: 1 }].map(isFixedToolArgument)).toEqual([true, true, true, true, true]);
    expect(['{{pregunta}}', 'Clima en {{pregunta}}', '', '  ', 0, false, [], {}, null].map(isFixedToolArgument)).toEqual(
      Array(9).fill(false),
    );
  });
});
