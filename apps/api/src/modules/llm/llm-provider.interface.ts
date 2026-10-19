// Contrato provider-agnostic de LLM. Cada proveedor (OpenAI, Gemini, Claude...)
// implementa esta interfaz; el resto del sistema depende solo de ella.
/**
 * Config concreta de un proveedor, ya resuelta (BD → env → default) y descifrada
 * por `LlmProviderFactory`. Los providers no leen configuración por su cuenta:
 * la reciben armada, así el mismo provider sirve para cualquier origen de config.
 */
export interface ResolvedProviderConfig {
  apiKey: string;
  model: string;
  /** Host/endpoint. Obligatorio en OpenCode Go, opcional en el resto. */
  baseUrl?: string;
  /**
   * Solo OpenCode Go: qué agent de opencode usar. Cada uno trae su propio prompt y
   * su propio set de herramientas permitidas. Los demás proveedores lo ignoran.
   */
  agent?: string;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Herramienta (function calling) que el modelo puede pedir invocar. `parameters` es un
 * JSON Schema de objeto — el mismo formato que anuncian los servidores MCP en `tools/list`.
 */
export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Pedido del modelo de invocar una herramienta. `id` correlaciona el resultado. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Turno de una conversación con herramientas: además de los mensajes de texto, el turno
 * del asistente que pidió herramientas y el resultado de cada una. Cada provider lo
 * traduce al formato de su API (OpenAI `tool_calls`/`role: tool`, Claude `tool_use`/
 * `tool_result`, Gemini `functionCall`/`functionResponse`).
 */
export type LlmTurn =
  | LlmMessage
  | { role: 'assistant'; content: string; toolCalls: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LlmToolResponse {
  /** Texto del modelo (puede venir vacío si solo pidió herramientas). */
  text: string;
  /** Herramientas pedidas; vacío = respuesta final. */
  toolCalls: LlmToolCall[];
}

export interface LlmProvider {
  generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string>;

  /**
   * Opcional: un paso de una conversación con herramientas. Los providers que no lo
   * implementan (ej. OpenCode Go, que no expone function calling) quedan fuera del modo
   * agente — `LlmService.supportsTools()` lo informa y el caller cae al modo sin tools.
   */
  generateWithTools?(
    turns: LlmTurn[],
    tools: LlmToolDefinition[],
    options?: LlmCompletionOptions,
  ): Promise<LlmToolResponse>;
}

export function isToolCallTurn(t: LlmTurn): t is { role: 'assistant'; content: string; toolCalls: LlmToolCall[] } {
  return t.role === 'assistant' && 'toolCalls' in t;
}

export function isToolResultTurn(t: LlmTurn): t is { role: 'tool'; toolCallId: string; name: string; content: string } {
  return t.role === 'tool';
}

// Token de inyección de dependencias para el proveedor activo.
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
