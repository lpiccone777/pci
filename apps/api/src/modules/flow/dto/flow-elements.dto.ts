import { IsString, IsOptional, IsBoolean, IsJSON, IsArray, IsNumber, ValidateNested } from 'class-validator';
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

  /**
   * Nodo `condition`, formato nuevo: variable de `flowState` a comparar (ej. "userRole"
   * o "{{userRole}}", incluye las que siempre trae el nodo `start`: userRole, userRoleId,
   * isKnownUser, userName, userFirstName, userLastName, userEmail, userPhone, userId).
   * Si está seteada, el nodo evalúa esta única comparación y tiene 2 salidas fijas por
   * `sourceHandle`: 'true' (afirmativo) / 'false' (negativo) — reemplaza a `conditions`/
   * `defaultTargetNodeId`, que quedan como fallback para flujos viejos sin este campo.
   */
  @IsString()
  @IsOptional()
  compareVariable?: string;

  /** Nodo `condition` formato nuevo: default 'equals' si no se define. */
  @IsString()
  @IsOptional()
  compareOperator?: 'equals' | 'not_equals' | 'contains' | 'exists' | 'not_exists';

  /** Nodo `condition` formato nuevo: valor contra el que se compara (no aplica a exists/not_exists). */
  @IsString()
  @IsOptional()
  compareValue?: string;

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

  /** Nodo `notification`: label del botón único (ej. "Sin foto"). */
  @IsString()
  @IsOptional()
  buttonLabel?: string;

  /**
   * Nodo `notification`: qué hace el botón. 'confirm' (default) espera a que lo toquen
   * para seguir el flujo; 'link' lo abre como URL y sigue de una (WhatsApp no avisa el
   * tap de un botón de link).
   */
  @IsString()
  @IsOptional()
  buttonMode?: 'confirm' | 'link';

  /** Nodo `notification` en modo `link`: URL que abre el botón. */
  @IsString()
  @IsOptional()
  buttonUrl?: string;

  /**
   * Nodo `notification` en modo `confirm`: si está en `true`, mandar una imagen cuenta
   * como disparador para seguir el flujo, igual que tocar el botón (ej. "Agregue sus
   * fotos" / "Sin foto" — cualquiera de las dos opciones avanza). Sin esto, solo el
   * click del botón avanza; una imagen (o cualquier otro mensaje) cae al LLM.
   */
  @IsBoolean()
  @IsOptional()
  expectsPhoto?: boolean;

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
   * Nodo `llm_query`: temperature de las llamadas al LLM de este nodo (0-2, default:
   * cae al `LLM_TEMPERATURE` global de /settings si no se define acá). Se aplica a la
   * respuesta libre y a `generateLlmQueryQuestion` (redacción de la pregunta cuando
   * falta una variable) — NO a `extractLlmQueryValues` (la clasificación de si una
   * variable ya fue dicha), que siempre corre en 0 sin importar este valor: es una
   * tarea de clasificación, no de redacción, y no debe ser "creativa".
   */
  @IsNumber()
  @IsOptional()
  temperature?: number;

  /**
   * Nodo `llm_query` en modo extracción: en vez de mandarle al usuario el texto del
   * modelo, evalúa una o más variables contra la charla. Las que no estén en el
   * mensaje se le preguntan al usuario (deteniendo el flujo hasta resolverlas o
   * hasta que se niegue a darlas, en cuyo caso quedan en "no definido") — ver
   * ConversationsService, case 'llm_query' / executeLlmQueryExtraction.
   */
  @IsArray()
  @IsOptional()
  extractVariables?: Array<{
    /** Nombre de la variable de flowState a setear (ej. "sede" o "{{sede}}"). */
    variable: string;
    /** Nombre humano del dato, para el prompt y la pregunta al usuario. Default: variable. */
    label?: string;
    /** Universo cerrado de valores válidos — sin esto, el modelo/usuario puede dar cualquier valor. */
    allowedValues?: string[];
  }>;

  /** Nodo `llm_query` en modo extracción: cuántas veces preguntarle al usuario un dato antes de darlo por "no definido". */
  @IsOptional()
  maxAttempts?: number;

  /**
   * LEGACY, IGNORADO por el motor (2026-08-28): `llm_query` en modo extracción sale
   * siempre por la arista dibujada, para ambos resultados (todas resueltas / alguna en
   * "no definido") — ramificar se hace con un nodo `condition` después. Se mantiene en el
   * DTO solo para que los flujos viejos que lo tengan guardado pasen la validación
   * (`forbidNonWhitelisted`) al re-guardarse; el editor ya no lo muestra.
   */
  @IsString()
  @IsOptional()
  foundTargetNodeId?: string;

  /** LEGACY, IGNORADO por el motor — ver `foundTargetNodeId`. */
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

  @IsString()
  @IsOptional()
  body?: string;

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
