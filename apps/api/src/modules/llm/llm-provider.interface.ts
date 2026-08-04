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

export interface LlmProvider {
  generateCompletion(
    messages: LlmMessage[],
    options?: LlmCompletionOptions,
  ): Promise<string>;
}

// Token de inyección de dependencias para el proveedor activo.
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
