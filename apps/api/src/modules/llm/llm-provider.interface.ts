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
 * Herramienta que el LLM puede pedir (tool calling, contrato C61): hoy, las tools de una
 * fuente de verdad MCP. `parameters` es un JSON Schema de tipo object.
 */
export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** Una tool que pidió el LLM, con sus argumentos ya parseados. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Lo que pasó después de los mensajes iniciales en una conversación con tools: el LLM pidió
 * tools (con o sin texto antes) y pci le devolvió cada resultado. Cada provider lo traduce a
 * su formato (OpenAI `tool_calls`/`tool`, Anthropic `tool_use`/`tool_result`, Gemini
 * `functionCall`/`functionResponse`).
 */
export type LlmToolTurn =
  | { kind: 'calls'; text?: string; calls: LlmToolCall[] }
  | { kind: 'result'; callId: string; name: string; content: string };

/** Una pasada del LLM con tools: texto (si respondió) y las tools que pidió (si pidió). */
export interface LlmToolStep {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface LlmProvider {
  generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string>;
  /**
   * Pasada con tools. Sin `tools` (lista vacía) es la pasada final, que obliga a contestar
   * con texto. Opcional: un provider sin tool calling (OpenCode Go) no la implementa y el
   * llamador cae al camino sin tools.
   */
  generateWithTools?(
    messages: LlmMessage[],
    turns: LlmToolTurn[],
    tools: LlmToolDefinition[],
    options?: LlmCompletionOptions,
  ): Promise<LlmToolStep>;
}

// Token de inyección de dependencias para el proveedor activo.
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
