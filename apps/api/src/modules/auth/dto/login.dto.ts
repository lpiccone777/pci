import { IsEmail, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;

  @IsOptional()
  @IsString()
  tenantId?: string;
}
