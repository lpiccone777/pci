import { IsString, IsOptional, IsBoolean, IsJSON, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class FlowNodeDataDto {
  @IsString()
  @IsOptional()
  text?: string;

  @IsOptional()
  options?: Array<{ label: string; value: string; targetNodeId: string }>;

  @IsString()
  @IsOptional()
  variableName?: string;

  @IsOptional()
  conditions?: Array<{
    type: 'keyword' | 'regex' | 'intent' | 'variable';
    value: string;
    targetNodeId: string;
  }>;

  @IsString()
  @IsOptional()
  defaultTargetNodeId?: string;

  /** Nodo `ticket_create`: nombre real de la categoría en InvGate (ver InvgateService.resolveCategoryId). */
  @IsString()
  @IsOptional()
  category?: string;

  /** Nodo `ticket_create`: nombre real de la prioridad en InvGate (ej. "Media", "Alta") — no low/medium/high. */
  @IsString()
  @IsOptional()
  priority?: string;

  /** Nodo `ticket_create`: nombre real del tipo de incidente en InvGate (ej. "Incidente", "Pregunta"). */
  @IsString()
  @IsOptional()
  ticketType?: string;

  @IsString()
  @IsOptional()
  template?: string;

  @IsString()
  @IsOptional()
  department?: string;

  @IsString()
  @IsOptional()
  message?: string;

  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  systemPrompt?: string;

  /**
   * Cómo combina este `systemPrompt` de nodo con el prompt base (LLM_SYSTEM_PROMPT
   * de /settings + el Skill del flujo, si tiene uno): 'replace' lo reemplaza entero
   * (default, mismo comportamiento que antes de sumar Skills), 'append' lo agrega a
   * continuación. Ver ConversationsService.buildBasePrompt.
   */
  @IsString()
  @IsOptional()
  systemPromptMode?: 'replace' | 'append';

  @IsOptional()
  contextMessages?: number;

  /**
   * Nodo `llm_query` en modo extracción: en vez de mandarle al usuario el texto del
   * modelo, lo usa para decidir un valor puntual (ej. "sede") y ramifica por
   * `foundTargetNodeId`/`missingTargetNodeId` en lugar de por edges — ver
   * ConversationsService, case 'llm_query'.
   */
  @IsString()
  @IsOptional()
  extractVariable?: string;

  /** Nombre humano del dato a extraer, para el prompt (ej. "sede"). Default: extractVariable. */
  @IsString()
  @IsOptional()
  extractLabel?: string;

  /** Universo cerrado de valores válidos para `extractVariable` — sin esto, el modelo devuelve lo que dijo el usuario tal cual. */
  @IsArray()
  @IsOptional()
  allowedValues?: string[];

  /** Nodo `llm_query` en modo extracción: a dónde ir si encontró el valor. */
  @IsString()
  @IsOptional()
  foundTargetNodeId?: string;

  /** Nodo `llm_query` en modo extracción: a dónde ir si NO lo encontró (ej. un `input` que lo pide). */
  @IsString()
  @IsOptional()
  missingTargetNodeId?: string;

  @IsString()
  @IsOptional()
  url?: string;

  @IsString()
  @IsOptional()
  method?: string;

  @IsOptional()
  headers?: Record<string, string>;

  @IsString()
  @IsOptional()
  bodyTemplate?: string;

  @IsOptional()
  seconds?: number;

  @IsString()
  @IsOptional()
  action?: 'set' | 'get';

  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  value?: string;

  @IsString()
  @IsOptional()
  ticketIdVariable?: string;

  @IsString()
  @IsOptional()
  flowId?: string;

  @IsString()
  @IsOptional()
  entryNodeId?: string;

  @IsString()
  @IsOptional()
  flowName?: string;

  // --- Nodo transfer_agent ---
  /** Subconjunto de 'email' | 'ticket' | 'phone' (multiselección; 'phone' reservado, sin implementar). */
  @IsArray()
  @IsOptional()
  methods?: string[];

  /** userId de cada colaborador, en el orden en que rotan por round robin. */
  @IsArray()
  @IsOptional()
  assignees?: string[];

  /** userId de cada observador (se notifican, no se les asigna nada). */
  @IsArray()
  @IsOptional()
  watchers?: string[];

  /** userId de cada colaborador de la tarea (involucrados, tampoco asignados). */
  @IsArray()
  @IsOptional()
  collaborators?: string[];

  /** Nodo `sms`: userId de cada destinatario — se les manda al `user.phone` que tengan cargado. */
  @IsArray()
  @IsOptional()
  recipients?: string[];
}

export class FlowNodeDto {
  @IsString()
  id: string;

  @IsString()
  type: string;

  @ValidateNested()
  @Type(() => FlowNodeDataDto)
  data: FlowNodeDataDto;

  @IsOptional()
  position?: { x: number; y: number };
}

export class FlowEdgeDto {
  @IsString()
  id: string;

  @IsString()
  source: string;

  @IsString()
  target: string;

  /**
   * Renderer de la arista en ReactFlow (ej. 'deletable'). Es dato real que hay que
   * persistir: sin esto la arista vuelve al estilo por defecto y se pierde el botón
   * de borrar. No confundir con las props transitorias que el front descarta antes
   * de enviar (`measured`, `selected`, `dragging`).
   */
  @IsString()
  @IsOptional()
  type?: string;

  @IsString()
  @IsOptional()
  sourceHandle?: string;

  @IsString()
  @IsOptional()
  targetHandle?: string;

  @IsString()
  @IsOptional()
  label?: string;
}
