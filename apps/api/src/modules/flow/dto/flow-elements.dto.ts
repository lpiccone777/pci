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

  @IsString()
  @IsOptional()
  category?: string;

  @IsString()
  @IsOptional()
  priority?: string;

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

  @IsOptional()
  contextMessages?: number;

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
