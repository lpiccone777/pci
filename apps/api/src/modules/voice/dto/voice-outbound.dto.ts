import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min } from 'class-validator';

/**
 * Saliente desde pci (H5, C63). Con `flowId` la llamada corre ese flujo de voz; sin él, es audio +
 * dígito (`audioUrl`, `digits`), como las de n8n. Uno de los dos es obligatorio.
 */
export class CreateVoiceOutboundDto {
  /** Números a discar, en rotación [C34]. Se limpian espacios, guiones, puntos y paréntesis. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  to!: string[];

  @IsOptional()
  @IsString()
  flowId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  audioUrl?: string;

  @IsOptional()
  @Matches(/^[0-9*#]{1,12}$/, { message: 'digits: solo 0-9, * y #' })
  digits?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxRounds?: number;
}
