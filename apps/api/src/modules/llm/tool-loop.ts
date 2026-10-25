import type {
  LlmCompletionOptions,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolTurn,
} from './llm-provider.interface';

/** Vueltas de tools por consulta (contrato C61); agotadas, una pasada final sin tools. */
export const LLM_TOOL_MAX_ROUNDS = 3;
/** Tools que se ejecutan en paralelo dentro de una vuelta. */
const LLM_TOOL_MAX_PARALLEL = 3;

/** Una tool ejecutada durante `chatWithTools`, para el log y para armar el `context` por voz. */
export interface LlmToolTrace {
  round: number;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  content: string;
  ms: number;
}

export interface LlmToolChatResult {
  /** `false` si el proveedor activo no tiene tool calling (OpenCode Go): el llamador cae al camino de siempre. */
  supported: boolean;
  text: string;
  rounds: number;
  calls: LlmToolTrace[];
}

export interface LlmToolLoopOptions {
  maxRounds?: number;
  /** Sin pasada final (voz): alcanza con los resultados, la respuesta la da otro LLM. */
  stopAfterTools?: boolean;
  /** Corta antes de la vuelta siguiente (p. ej. venció el tiempo del turno de voz). */
  cancelled?: () => boolean;
}

export type LlmToolExecutor = (call: LlmToolCall) => Promise<{ ok: boolean; content: string }>;

/**
 * Saca el bloque de razonamiento (`<think>...</think>`) que algunos modelos devuelven
 * mezclado con la respuesta final en vez de en un campo separado — confirmado con
 * MiniMax-M2.x (no se puede apagar el razonamiento en esos modelos, y sin el parámetro
 * `reasoning_split` de esa API el texto queda embebido en `content`; ver
 * `MiniMaxProvider`). Va acá y no en cada provider porque cualquier modelo detrás de
 * cualquier proveedor puede ser "razonador" (ej. DeepSeek R1 vía OpenRouter) — un solo
 * lugar, provider-agnostic, en vez de repetir la limpieza en cada uno.
 */
export function stripThinking(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Si `max_tokens` se agotó a mitad del razonamiento, no hay tag de cierre y el regex de
  // arriba no lo agarra — cortar desde el `<think>` abierto es mejor que mostrarle al
  // usuario el razonamiento interno crudo (aunque la respuesta quede corta o vacía).
  const openIdx = cleaned.search(/<think>/i);
  if (openIdx !== -1) cleaned = cleaned.slice(0, openIdx);
  return cleaned.trim();
}

/**
 * El loop de tools (contrato C61), independiente de Nest: el LLM elige tool y argumentos,
 * `execute` la corre y el resultado vuelve al LLM, hasta `maxRounds` vueltas. Agotadas, una
 * pasada final sin tools obliga a contestar con texto. Si `execute` tira, el error vuelve al
 * LLM como resultado ("No se pudo consultar: …").
 */
export async function runToolLoop(
  provider: Required<Pick<LlmProvider, 'generateWithTools'>>,
  messages: LlmMessage[],
  tools: LlmToolDefinition[],
  execute: LlmToolExecutor,
  options: LlmCompletionOptions,
  opts: LlmToolLoopOptions = {},
): Promise<LlmToolChatResult> {
  const maxRounds = opts.maxRounds ?? LLM_TOOL_MAX_ROUNDS;
  const turns: LlmToolTurn[] = [];
  const calls: LlmToolTrace[] = [];
  for (let round = 1; round <= maxRounds; round++) {
    if (opts.cancelled?.()) return { supported: true, text: '', rounds: round - 1, calls };
    const step = await provider.generateWithTools(messages, turns, tools, options);
    if (!step.toolCalls.length) {
      return { supported: true, text: stripThinking(step.text), rounds: round - 1, calls };
    }
    const asked = step.toolCalls.slice(0, LLM_TOOL_MAX_PARALLEL);
    turns.push({ kind: 'calls', text: step.text || undefined, calls: asked });
    const results = await Promise.all(
      asked.map(async (call) => {
        const started = Date.now();
        const r = await execute(call).catch((err) => ({
          ok: false,
          content: `No se pudo consultar: ${err instanceof Error ? err.message : err}`,
        }));
        calls.push({ round, name: call.name, arguments: call.arguments, ok: r.ok, content: r.content, ms: Date.now() - started });
        return { call, content: r.content };
      }),
    );
    for (const { call, content } of results) turns.push({ kind: 'result', callId: call.id, name: call.name, content });
  }
  if (opts.stopAfterTools || opts.cancelled?.()) return { supported: true, text: '', rounds: maxRounds, calls };
  const final = await provider.generateWithTools(messages, turns, [], options);
  return { supported: true, text: stripThinking(final.text), rounds: maxRounds, calls };
}
