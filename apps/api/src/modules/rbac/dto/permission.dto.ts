import { IsString, IsNotEmpty } from 'class-validator';

export class CreatePermissionDto {
  @IsString()
  @IsNotEmpty()
  resource: string;

  @IsString()
  @IsNotEmpty()
  action: string;
}
