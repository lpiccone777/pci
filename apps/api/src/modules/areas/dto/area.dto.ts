import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateAreaDto {
  /**
   * Único dato del alta: el tenant sale del header (`@CurrentTenant()`), nunca del body.
   */
  @IsString()
  @IsNotEmpty({ message: 'El nombre del área es obligatorio' })
  @MaxLength(80)
  name: string;
}

export class UpdateAreaDto {
  @IsString()
  @IsNotEmpty({ message: 'El nombre del área es obligatorio' })
  @MaxLength(80)
  name: string;
}
