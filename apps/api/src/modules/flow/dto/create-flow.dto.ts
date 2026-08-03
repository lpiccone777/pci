import { IsString, IsOptional, IsBoolean, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { FlowNodeDto, FlowEdgeDto } from './flow-elements.dto';

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

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tenantIds?: string[];
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
}
