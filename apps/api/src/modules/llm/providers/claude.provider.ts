import Anthropic from '@anthropic-ai/sdk';
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
export class ClaudeProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;

  // La config llega resuelta desde LlmProviderFactory (BD → env → default).
  constructor(config: ResolvedProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.defaultModel = config.model;
  }

  async generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      system: systemMessage?.content ?? options?.systemPrompt,
      messages: conversationMessages,
    });

    const content = response.content[0];
    return content.type === 'text' ? content.text : '';
  }

  /**
   * Tool use de la Messages API: los mensajes `system` (puede haber varios: prompt base +
   * contexto) van juntos en `system`; el pedido de herramientas es un bloque `tool_use` del
   * asistente y cada resultado un bloque `tool_result` en un turno `user` (los resultados
   * consecutivos van en el mismo turno, como pide la API).
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

    const messages: Anthropic.MessageParam[] = [];
    for (const t of turns) {
      if (t.role === 'system') continue;
      if (isToolCallTurn(t)) {
        messages.push({
          role: 'assistant',
          content: [
            ...(t.content ? [{ type: 'text' as const, text: t.content }] : []),
            ...t.toolCalls.map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.arguments ?? {} })),
          ],
        });
      } else if (isToolResultTurn(t)) {
        const block = { type: 'tool_result' as const, tool_use_id: t.toolCallId, content: t.content };
        const last = messages[messages.length - 1];
        if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b: any) => b.type === 'tool_result')) {
          (last.content as any[]).push(block);
        } else {
          messages.push({ role: 'user', content: [block] });
        }
      } else {
        messages.push({ role: t.role as 'user' | 'assistant', content: t.content });
      }
    }

    const response = await this.client.messages.create({
      model: this.defaultModel,
      max_tokens: options?.maxTokens ?? 1024,
      temperature: options?.temperature ?? 0.7,
      ...(system || options?.systemPrompt ? { system: system || options?.systemPrompt } : {}),
      messages,
      ...(tools.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
              input_schema: tool.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
    });

    let text = '';
    const toolCalls: LlmToolResponse['toolCalls'] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, arguments: (block.input ?? {}) as Record<string, unknown> });
      }
    }
    return { text, toolCalls };
  }
}
