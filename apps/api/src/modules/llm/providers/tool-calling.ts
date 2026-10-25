import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  LlmCompletionOptions,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolStep,
  LlmToolTurn,
} from '../llm-provider.interface';

/**
 * Tool calling por familia de API (contrato C61). Cada función traduce la conversación neutra
 * (`LlmMessage[]` + `LlmToolTurn[]`) al formato del proveedor y la respuesta de vuelta a
 * `LlmToolStep`. Con `tools` vacío es la pasada final: se manda sin tools, así el modelo tiene
 * que contestar con texto.
 */

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

// --- OpenAI y compatibles (OpenAI, OpenRouter, MiniMax /v1) ---

export async function openAiCompatibleWithTools(
  client: OpenAI,
  model: string,
  messages: LlmMessage[],
  turns: LlmToolTurn[],
  tools: LlmToolDefinition[],
  options?: LlmCompletionOptions,
  extra: Record<string, unknown> = {},
): Promise<LlmToolStep> {
  const chat: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
  for (const turn of turns) {
    if (turn.kind === 'calls') {
      chat.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
    } else {
      chat.push({ role: 'tool', tool_call_id: turn.callId, content: turn.content });
    }
  }
  const completion = await client.chat.completions.create({
    model,
    messages: chat,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 1024,
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description ?? '', parameters: t.parameters },
          })),
        }
      : {}),
    ...extra,
  } as any);
  const message: any = completion.choices[0]?.message ?? {};
  const toolCalls: LlmToolCall[] = (message.tool_calls ?? [])
    .filter((c: any) => c?.function?.name)
    .map((c: any, i: number) => ({
      id: c.id || `call_${i}`,
      name: c.function.name,
      arguments: parseArgs(c.function.arguments),
    }));
  return { text: message.content ?? '', toolCalls };
}

// --- Anthropic (Claude) ---

export async function anthropicWithTools(
  client: Anthropic,
  model: string,
  messages: LlmMessage[],
  turns: LlmToolTurn[],
  tools: LlmToolDefinition[],
  options?: LlmCompletionOptions,
  extra: Record<string, unknown> = {},
): Promise<LlmToolStep> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const conversation: any[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  for (const turn of turns) {
    if (turn.kind === 'calls') {
      conversation.push({
        role: 'assistant',
        content: [
          ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
          ...turn.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments })),
        ],
      });
    } else {
      // Los resultados seguidos van juntos en un solo mensaje del usuario (lo exige la API).
      const block = { type: 'tool_result', tool_use_id: turn.callId, content: turn.content };
      const last = conversation[conversation.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        conversation.push({ role: 'user', content: [block] });
      }
    }
  }
  const response: any = await client.messages.create({
    model,
    max_tokens: options?.maxTokens ?? 1024,
    temperature: options?.temperature ?? 0.7,
    ...(system || options?.systemPrompt ? { system: system || options?.systemPrompt } : {}),
    messages: conversation,
    ...(tools.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.parameters })) }
      : {}),
    ...extra,
  } as any);
  const blocks: any[] = response.content ?? [];
  return {
    text: blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    toolCalls: blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: parseArgs(b.input) })),
  };
}

// --- Gemini ---

/** Gemini acepta un subconjunto de OpenAPI en `parameters`: saca lo que rechaza. */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (['$schema', 'additionalProperties', 'default', 'examples', '$id', '$ref', 'exclusiveMinimum', 'exclusiveMaximum'].includes(k)) continue;
    out[k] = geminiSchema(v);
  }
  return out;
}

export async function geminiWithTools(
  client: GoogleGenerativeAI,
  modelName: string,
  messages: LlmMessage[],
  turns: LlmToolTurn[],
  tools: LlmToolDefinition[],
  options?: LlmCompletionOptions,
): Promise<LlmToolStep> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const model = client.getGenerativeModel({
    model: modelName,
    ...(system ? { systemInstruction: system } : {}),
    ...(tools.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description ?? '',
                parameters: geminiSchema(t.parameters),
              })),
            },
          ],
        }
      : {}),
  } as any);
  const contents: any[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  for (const turn of turns) {
    if (turn.kind === 'calls') {
      contents.push({
        role: 'model',
        parts: [
          ...(turn.text ? [{ text: turn.text }] : []),
          ...turn.calls.map((c) => ({ functionCall: { name: c.name, args: c.arguments } })),
        ],
      });
    } else {
      contents.push({ role: 'function', parts: [{ functionResponse: { name: turn.name, response: { content: turn.content } } }] });
    }
  }
  const result: any = await model.generateContent({
    contents,
    generationConfig: { temperature: options?.temperature ?? 0.7, maxOutputTokens: options?.maxTokens ?? 1024 },
  } as any);
  const parts: any[] = result.response?.candidates?.[0]?.content?.parts ?? [];
  return {
    text: parts
      .filter((p) => typeof p.text === 'string')
      .map((p) => p.text)
      .join(''),
    // Gemini no da id por llamada: se arma uno estable por posición.
    toolCalls: parts
      .filter((p) => p.functionCall?.name)
      .map((p, i) => ({ id: `gemini_${turns.length}_${i}`, name: p.functionCall.name, arguments: parseArgs(p.functionCall.args) })),
  };
}
