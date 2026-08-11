import { IsString, IsOptional, IsBoolean, IsArray, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FlowNodeDto, FlowEdgeDto } from './flow-elements.dto';
import { FLOW_CONTEXT_VALUES } from '../flow-context';

export class CreateFlowDto {
  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlowNodeDto)
  nodes: FlowNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlowEdgeDto)
  edges: FlowEdgeDto[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  /**
   * DEPRECATED: fuente de datos de la lista cerrada de flow-context.ts. Se
   * conserva por compatibilidad — el campo nuevo es `contextSourceId`.
   */
  @IsIn(FLOW_CONTEXT_VALUES)
  @IsOptional()
  context?: string;

  /**
   * Fuente de verdad (MCP/RAG/n8n/broker) que este flujo consulta. `null` desvincula.
   * `FlowService` no valida tenant acá: el frontend solo ofrece en el dropdown las
   * fuentes del tenant activo, pero un flujo puede estar asignado a varios
   * tenants (`TenantFlow`) y `ContextSource` es por tenant — ver la limitación
   * documentada en AGENTS.md.
   */
  @IsString()
  @IsOptional()
  contextSourceId?: string | null;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tenantIds?: string[];

  /**
   * Flujo de inicio para los tenants de `tenantIds`. Un tenant tiene como máximo
   * un flujo de inicio: si ya tenía otro, `FlowService` lo desmarca solo.
   */
  @IsBoolean()
  @IsOptional()
  isStart?: boolean;
}

/** Body de POST /flows/:id/assign-tenants. */
export class AssignTenantsDto {
  @IsArray()
  @IsString({ each: true })
  tenantIds: string[];

  /** Ver CreateFlowDto.isStart. */
  @IsBoolean()
  @IsOptional()
  isStart?: boolean;
}

export class UpdateFlowDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlowNodeDto)
  @IsOptional()
  nodes?: FlowNodeDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FlowEdgeDto)
  @IsOptional()
  edges?: FlowEdgeDto[];

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  /** DEPRECATED: ver el comentario equivalente en CreateFlowDto. */
  @IsIn(FLOW_CONTEXT_VALUES)
  @IsOptional()
  context?: string;

  /** Ver el comentario equivalente en CreateFlowDto. */
  @IsString()
  @IsOptional()
  contextSourceId?: string | null;
}
