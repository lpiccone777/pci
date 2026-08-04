import { IsEmail, IsNotEmpty } from 'class-validator';

// Sin tenantId: el login autentica a la persona. El tenant se elige después,
// por header X-Tenant-Id en cada request (ver TenantGuard).
export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}
