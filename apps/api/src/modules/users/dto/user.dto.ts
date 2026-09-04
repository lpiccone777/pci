import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Verificación en vivo de un campo global (email, teléfono, interno o identificador de Invgate)
 * desde el formulario de alta/edición. `excludeUserId` es la persona que se está editando, para
 * que su propio dato no cuente como conflicto consigo misma.
 */
export class CheckAvailabilityQueryDto {
  @IsIn(['email', 'phone', 'invgateUserId', 'internalPhone'])
  field: 'email' | 'phone' | 'invgateUserId' | 'internalPhone';

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  value: string;

  @IsOptional()
  @IsString()
  excludeUserId?: string;
}

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

  /** Opcional: interno telefónico de la persona. Hoy solo se carga; lo usará un voicebot. */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  internalPhone?: string;

  /** Opcional: identificador de la persona en Invgate. Hoy se carga a mano. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;
}

/**
 * Una membresía a crear en el alta multiempresa: la persona entra a esta empresa con este
 * rol y (opcional) esta área. Mapea 1:1 a una fila `UserTenant`.
 */
export class UserMembershipDto {
  @IsString()
  @IsNotEmpty({ message: 'La empresa es obligatoria' })
  tenantId: string;

  /** Obligatorio: todo usuario entra a cada empresa con un rol. */
  @IsString()
  @IsNotEmpty({ message: 'El rol es obligatorio' })
  roleId: string;

  /** Opcional: el área agrupa para auditoría y métricas, no habilita nada. */
  @IsOptional()
  @IsString()
  areaId?: string;
}

/**
 * Alta de una persona en varias empresas a la vez. Solo superadmin (el controlador lo gatea
 * con `SystemTenantGuard`). Los datos de la persona son únicos; el rol y el área van por
 * empresa dentro de `memberships`.
 */
export class CreateUserMultiTenantDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  internalPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Elegí al menos una empresa' })
  @ValidateNested({ each: true })
  @Type(() => UserMembershipDto)
  memberships: UserMembershipDto[];
}

/**
 * Edición multiempresa de una persona: los datos de la persona (compartidos entre sus
 * empresas) más el estado deseado de sus membresías en las empresas que quien edita
 * administra. Es la contraparte de `CreateUserMultiTenantDto` para editar en vez de crear.
 *
 * `memberships` es el estado FINAL, no un delta: el servicio compara contra las membresías
 * actuales y crea, actualiza o da de baja según haga falta. Puede venir vacío (dar de baja de
 * todas las empresas administrables). Solo toca las empresas que el editor administra; las
 * demás membresías de la persona quedan intactas.
 */
export class UpdateUserFullDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El nombre es obligatorio' })
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El apellido es obligatorio' })
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  internalPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  password?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UserMembershipDto)
  memberships: UserMembershipDto[];
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
   * Interno telefónico. Mismo criterio de "no lo toques" que el teléfono: cadena vacía lo
   * deja sin interno; que la clave no venga significa que no se modifica.
   */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  internalPhone?: string;

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

/**
 * Una fila del Excel ya mapeada a campos de persona (el mapeo columna→campo lo resuelve el
 * frontend antes de mandar el body). Sin `password` ni `roleId`: la contraseña se autogenera
 * y el rol/área son un default único para todo el lote (ver `BulkImportUsersDto`) — un Excel
 * de personal casi nunca trae una columna de rol utilizable tal cual.
 */
export class BulkImportUserRowDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  internalPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  invgateUserId?: string;
}

/**
 * Carga masiva desde Excel: mismo rol y (opcional) área para todas las filas, elegidos una
 * sola vez en el modal de importación — no por fila. Crea en el tenant activo (header), como
 * `CreateUserDto`, no cross-tenant como el alta multiempresa.
 */
export class BulkImportUsersDto {
  @IsString()
  @IsNotEmpty({ message: 'El rol por defecto es obligatorio' })
  defaultRoleId: string;

  @IsOptional()
  @IsString()
  defaultAreaId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'El archivo no tiene filas para importar' })
  @ArrayMaxSize(10000, { message: 'Máximo 10000 filas por importación' })
  @ValidateNested({ each: true })
  @Type(() => BulkImportUserRowDto)
  rows: BulkImportUserRowDto[];
}
