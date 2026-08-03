// Contrato provider-agnostic de LLM. Cada proveedor (OpenAI, Gemini, Claude...)
// implementa esta interfaz; el resto del sistema depende solo de ella.
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
