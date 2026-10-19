import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  isToolCallTurn,
  isToolResultTurn,
  type LlmProvider,
  type LlmMessage,
  type LlmCompletionOptions,
  type LlmToolDefinition,
  type LlmToolResponse,
  type LlmTurn,
  type ResolvedProviderConfig,
} from '../llm-provider.interface';

// Sin @Injectable(): no lo instancia Nest, lo construye LlmProviderFactory
// pasándole la config ya resuelta.
export class GeminiProvider implements LlmProvider {
  private readonly client: GoogleGenerativeAI;
  private readonly defaultModel: string;

  // La config llega resuelta desde LlmProviderFactory (BD → env → default).
  constructor(config: ResolvedProviderConfig) {
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.defaultModel = config.model;
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const model = this.client.getGenerativeModel({ model: this.defaultModel });

    // Gemini no usa system role; convertimos todo a parts
    const parts = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({
      history: parts.slice(0, -1),
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 1024,
      },
    });

    const lastMessage = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMessage.content);
    return result.response.text() ?? '';
  }

  /**
   * Function calling de Gemini: `system` va en `systemInstruction`, el pedido de herramientas
   * es una parte `functionCall` del turno `model` y cada resultado una `functionResponse` en un
   * turno `function`. El schema de parámetros se reduce al subconjunto OpenAPI que acepta Gemini.
   */
  async generateWithTools(
    turns: LlmTurn[],
    tools: LlmToolDefinition[],
    options?: LlmCompletionOptions,
  ): Promise<LlmToolResponse> {
    const system = turns
      .filter((t): t is LlmMessage => t.role === 'system')
      .map((t) => t.content)
      .join('\n\n');

    const contents: any[] = [];
    for (const t of turns) {
      if (t.role === 'system') continue;
      if (isToolCallTurn(t)) {
        contents.push({
          role: 'model',
          parts: [
            ...(t.content ? [{ text: t.content }] : []),
            ...t.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.arguments ?? {} } })),
          ],
        });
      } else if (isToolResultTurn(t)) {
        const part = { functionResponse: { name: t.name, response: { content: t.content } } };
        const last = contents[contents.length - 1];
        if (last?.role === 'function') last.parts.push(part);
        else contents.push({ role: 'function', parts: [part] });
      } else {
        contents.push({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] });
      }
    }

    const model = this.client.getGenerativeModel({
      model: this.defaultModel,
      ...(system || options?.systemPrompt ? { systemInstruction: system || options?.systemPrompt } : {}),
    });
    const result = await model.generateContent({
      contents,
      ...(tools.length
        ? {
            tools: [
              {
                functionDeclarations: tools.map((tool) => {
                  const parameters = toGeminiSchema(tool.parameters);
                  // Gemini rechaza un objeto sin propiedades: una tool sin parámetros va sin schema.
                  const empty = !Object.keys((parameters.properties as object) ?? {}).length;
                  return { name: tool.name, description: tool.description ?? '', ...(empty ? {} : { parameters: parameters as any }) };
                }),
              },
            ],
          }
        : {}),
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens ?? 1024,
      },
    });

    const calls = result.response.functionCalls() ?? [];
    let text = '';
    try {
      text = calls.length ? '' : result.response.text();
    } catch {
      text = '';
    }
    return {
      text,
      toolCalls: calls.map((c, i) => ({ id: `gemini_${i}_${c.name}`, name: c.name, arguments: (c.args ?? {}) as Record<string, unknown> })),
    };
  }
}

/**
 * Reduce un JSON Schema al subconjunto que acepta Gemini (tipo, descripción, enum, items,
 * properties, required). Uniones (`anyOf`) pasan a string y se descartan `$schema`,
 * `additionalProperties`, `default`, límites numéricos, etc., que la API rechaza.
 */
function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const s = schema as Record<string, any>;
  let type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  if (!type && (s.anyOf || s.oneOf)) type = 'string';
  const out: Record<string, unknown> = { type: type ?? 'string' };
  if (typeof s.description === 'string') out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
  if (type === 'array') out.items = toGeminiSchema(s.items);
  if (type === 'object') {
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  }
  return out;
}
