import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { SCHEDULE_ENTRY_TYPE_VALUES } from '../../schedule-calendar/schedule-entry-types.catalog';

/**
 * Body de POST /flows/:id/variants. `blank` y `sourceFlowId` son mutuamente excluyentes;
 * sin ninguno de los dos, el service duplica el Principal de este mismo flujo (default
 * original). Ver `FlowService.createVariant`.
 */
export class CreateFlowVariantDto {
  @IsIn(SCHEDULE_ENTRY_TYPE_VALUES, {
    message: `El tipo debe ser uno de: ${SCHEDULE_ENTRY_TYPE_VALUES.join(', ')}`,
  })
  type: string;

  /** Arrancar en blanco (mismo nodo `start` por defecto que un flujo nuevo), en vez de duplicar. */
  @IsBoolean()
  @IsOptional()
  blank?: boolean;

  /** Duplicar el grafo de este flujo en vez del Principal de `baseFlowId`. */
  @IsString()
  @IsOptional()
  sourceFlowId?: string;
}
