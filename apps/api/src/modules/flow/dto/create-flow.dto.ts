import { IsString, IsOptional, IsBoolean, IsArray, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FlowNodeDto, FlowEdgeDto } from './flow-elements.dto';
import { FLOW_CONTEXT_VALUES } from '../flow-context';

/**
 * Asignación de un flujo a una empresa, con los roles que lo reciben ahí.
 * `roleIds` vacío o ausente = el flujo queda asignado a la empresa pero no lo
 * recibe ningún usuario (el candado de recepción es por rol).
 */
export class TenantAssignmentDto {
  @IsString()
  tenantId: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  roleIds?: string[];
}

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

  /** Fuente de datos que respalda las respuestas del flujo. Ver flow-context.ts. */
  @IsIn(FLOW_CONTEXT_VALUES)
  @IsOptional()
  context?: string;

  /**
   * En qué empresas está disponible el flujo y, dentro de cada una, qué roles lo
   * reciben. Reemplaza al viejo `tenantIds: string[]`: ahora la asignación lleva
   * roles. Ausente = el flujo nace sin empresas asignadas.
   */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TenantAssignmentDto)
  @IsOptional()
  assignments?: TenantAssignmentDto[];

  /**
   * Flujo de inicio para los pares (empresa + rol) de `assignments`. La invariante
   * es "un flujo de inicio por (empresa + rol)": si otro flujo ya era el inicio
   * para alguno de esos pares, `FlowService` se lo saca al guardar.
   */
  @IsBoolean()
  @IsOptional()
  isStart?: boolean;
}

/** Body de POST /flows/:id/assign-tenants. */
export class AssignTenantsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TenantAssignmentDto)
  assignments: TenantAssignmentDto[];

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

  /** Fuente de datos que respalda las respuestas del flujo. Ver flow-context.ts. */
  @IsIn(FLOW_CONTEXT_VALUES)
  @IsOptional()
  context?: string;
}
