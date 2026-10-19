import type OpenAI from 'openai';
import {
  isToolCallTurn,
  isToolResultTurn,
  type LlmCompletionOptions,
  type LlmToolDefinition,
  type LlmToolResponse,
  type LlmTurn,
} from '../llm-provider.interface';

/**
 * Function calling para las APIs compatibles con OpenAI Chat Completions (OpenAI,
 * OpenRouter, MiniMax): mismo formato de `tools` / `tool_calls` / `role: 'tool'`, solo
 * cambian el cliente y algún parámetro propio del proveedor (`extraBody`).
 */
export async function openAiCompatibleWithTools(
  client: OpenAI,
  model: string,
  turns: LlmTurn[],
  tools: LlmToolDefinition[],
  options?: LlmCompletionOptions,
  extraBody: Record<string, unknown> = {},
): Promise<LlmToolResponse> {
  const messages = turns.map((t) => {
    if (isToolCallTurn(t)) {
      return {
        role: 'assistant' as const,
        content: t.content || null,
        tool_calls: t.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    if (isToolResultTurn(t)) {
      return { role: 'tool' as const, tool_call_id: t.toolCallId, content: t.content };
    }
    return { role: t.role, content: t.content };
  });

  const completion = await client.chat.completions.create({
    model,
    messages,
    ...(tools.length
      ? {
          tools: tools.map((tool) => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters },
          })),
        }
      : {}),
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 1024,
    ...extraBody,
  } as any);

  const message = (completion as any).choices?.[0]?.message ?? {};
  const toolCalls = (message.tool_calls ?? [])
    .filter((c: any) => c?.type === 'function' && c.function?.name)
    .map((c: any, i: number) => ({
      id: c.id || `call_${i}`,
      name: c.function.name,
      arguments: parseArguments(c.function.arguments),
    }));
  return { text: typeof message.content === 'string' ? message.content : '', toolCalls };
}

/** Los argumentos llegan como string JSON; uno mal formado no rompe la charla. */
function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
