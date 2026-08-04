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

export class UpdateSettingDto {
  @IsString()
  @MaxLength(4000)
  value: string;
}
