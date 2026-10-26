import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class UpsertSettingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  key: string;

  @IsString()
  @MaxLength(4000)
  value: string;
}

/** "Proponer variantes" de una lista de avisos de espera [C65]: lo que hay en el formulario, sin guardar. */
export class ProposeWaitTextsDto {
  @IsString()
  @MaxLength(4000)
  current: string;
}

export class UpdateSettingDto {
  @IsString()
  @MaxLength(4000)
  value: string;
}
