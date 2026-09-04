import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSkillDto {
  /** El tenant sale del header (`@CurrentTenant()`), nunca del body. */
  @IsString()
  @IsNotEmpty({ message: 'El nombre del skill es obligatorio' })
  @MaxLength(80)
  name: string;

  /** Texto libre que se concatena al system prompt base cuando un flujo usa este skill. */
  @IsString()
  @IsNotEmpty({ message: 'El texto del skill es obligatorio' })
  @MaxLength(8000)
  promptText: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateSkillDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre del skill es obligatorio' })
  @MaxLength(80)
  @IsOptional()
  name?: string;

  @IsString()
  @IsNotEmpty({ message: 'El texto del skill es obligatorio' })
  @MaxLength(8000)
  @IsOptional()
  promptText?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
