import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * El número tal como llega en el INVITE (contrato de integración §3.5): dígitos, letras y los
 * `+`, `*`, `#` que puede marcar un teléfono. Sin espacios ni separadores.
 */
export const EXTENSION_NUMBER_PATTERN = /^[0-9A-Za-z+*#]{1,32}$/;
const NUMBER_MESSAGE = 'El número del interno va sin espacios: dígitos, letras, +, * o # (hasta 32)';

/**
 * Alta de un interno del voicebot. `tenantId` va en el body a propósito, como en el ABM de
 * empresas: el interno es infra global que administra el superusuario desde el tenant de
 * sistema, y `tenantId` es la empresa que lo ATIENDE, no el tenant activo de quien lo carga.
 * `flowId` es el flujo de voz propio del interno (DA8, paso 1): voz, activo y asignado a la
 * empresa del interno (lo valida `ExtensionsService`). `null` = sin flujo propio.
 */
export class CreateExtensionDto {
  @IsString()
  @Matches(EXTENSION_NUMBER_PATTERN, { message: NUMBER_MESSAGE })
  number: string;

  @IsString()
  @IsNotEmpty({ message: 'El nombre del interno es obligatorio' })
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Falta la empresa que atiende el interno' })
  tenantId: string;

  @IsOptional()
  @IsString()
  flowId?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateExtensionDto {
  @IsOptional()
  @IsString()
  @Matches(EXTENSION_NUMBER_PATTERN, { message: NUMBER_MESSAGE })
  number?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'El nombre del interno es obligatorio' })
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Falta la empresa que atiende el interno' })
  tenantId?: string;

  /** `null` o `''` = sacarle el flujo propio (cae al de inicio de la empresa). */
  @IsOptional()
  @IsString()
  flowId?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
