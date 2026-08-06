import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';
import { PERMISSION_TOTAL } from '../permissions.catalog';

export class PermissionEntryDto {
  @IsString()
  @IsNotEmpty()
  resource: string;

  @IsString()
  @IsNotEmpty()
  action: string;
}

/**
 * Cuerpo de `PUT /roles/:id/permissions`: el conjunto completo de permisos que tiene
 * que quedar, no un delta. La ventana modal del backoffice guarda todo de una vez;
 * con altas y bajas individuales serían hasta 48 llamadas sueltas y cualquier corte
 * en el medio dejaría el rol a mitad de camino.
 *
 * `@ArrayMaxSize` es un tope defensivo, no una regla de negocio: el catálogo ya limita
 * qué entra, esto solo evita que alguien mande un array enorme y lo validemos entero.
 */
export class ReplacePermissionsDto {
  @IsArray()
  @ArrayMaxSize(PERMISSION_TOTAL)
  @ValidateNested({ each: true })
  @Type(() => PermissionEntryDto)
  permissions: PermissionEntryDto[];
}
