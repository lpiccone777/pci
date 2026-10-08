import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * Conexión de la empresa con su TitanHR. `itPassword` sigue la regla de los secrets del
 * resto del sistema: ausente = no tocar la guardada, `null`/`''` = borrarla.
 */
export class UpsertTitanConnectionDto {
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  @MaxLength(300)
  baseUrl!: string;

  @IsEmail()
  @MaxLength(200)
  itEmail!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  @MaxLength(200)
  itPassword?: string | null;
}

export class ImportTitanUsersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsInt({ each: true })
  titanUserIds!: number[];

  /** Rol de PCI (permisos del backoffice) para los usuarios NUEVOS. */
  @IsString()
  @IsNotEmpty()
  roleId!: string;

  @IsOptional()
  @IsString()
  areaId?: string;
}
