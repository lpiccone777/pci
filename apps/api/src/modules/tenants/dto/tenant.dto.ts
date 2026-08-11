import { IsNotEmpty, IsString, Matches } from 'class-validator';

// `@IsNotEmpty` da por válido un string de solo espacios (`"   "`), que el service recorta
// a `""` y guardaría igual. `@Matches(/\S/)` exige al menos un carácter que no sea espacio,
// así un nombre o slug en blanco se rechaza con 400 en vez de crear una empresa sin datos.
export class CreateTenantDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la empresa es obligatorio' })
  @Matches(/\S/, { message: 'El nombre no puede ser solo espacios' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'El slug de la empresa es obligatorio' })
  @Matches(/\S/, { message: 'El slug no puede ser solo espacios' })
  slug: string;
}

export class UpdateTenantDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la empresa es obligatorio' })
  @Matches(/\S/, { message: 'El nombre no puede ser solo espacios' })
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'El slug de la empresa es obligatorio' })
  @Matches(/\S/, { message: 'El slug no puede ser solo espacios' })
  slug: string;
}
