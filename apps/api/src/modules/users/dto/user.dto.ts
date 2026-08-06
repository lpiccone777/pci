import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail({}, { message: 'El email no es válido' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(80)
  firstName: string;

  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(80)
  lastName: string;

  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password: string;

  /** Obligatorio: todo usuario entra al tenant con un rol asignado. */
  @IsString()
  @IsNotEmpty({ message: 'El rol es obligatorio' })
  roleId: string;

  /** Opcional: el área agrupa para auditoría y métricas, no habilita nada. */
  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  /** Opcional: identificador de la persona en Invgate. Hoy se carga a mano. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  /**
   * Identificador en Invgate. Cadena vacía lo deja sin identificador; que la clave no
   * venga significa "no lo toques" — mismo criterio que el teléfono.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;

  /** Cambiar el rol del usuario dentro del tenant activo. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string;

  /**
   * Área del usuario dentro del tenant activo. Cadena vacía o `null` lo dejan sin área;
   * que la clave no venga significa "no la toques". Por eso no lleva `@IsNotEmpty()`.
   */
  @IsOptional()
  @IsString()
  areaId?: string | null;

  /** Opcional: si viene, se resetea la contraseña. */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password?: string;
}
