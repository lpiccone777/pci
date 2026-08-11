import { IsBoolean, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { CONTEXT_SOURCE_TYPE_VALUES } from '../context-source-types.catalog';

export class CreateContextSourceDto {
  /** El tenant sale del header (`@CurrentTenant()`), nunca del body. */
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la fuente de verdad es obligatorio' })
  @MaxLength(80)
  name: string;

  /** Inmutable después de creada: cambiar de tipo invalida `config` entero. */
  @IsIn(CONTEXT_SOURCE_TYPE_VALUES, {
    message: `El tipo debe ser uno de: ${CONTEXT_SOURCE_TYPE_VALUES.join(', ')}`,
  })
  type: string;

  /**
   * Validación profunda (qué keys son válidas para `type`, cuáles son requeridas)
   * la hace `ContextSourcesService` contra el catálogo — acá solo se valida que sea
   * un objeto plano.
   */
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateContextSourceDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la fuente de verdad es obligatorio' })
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
