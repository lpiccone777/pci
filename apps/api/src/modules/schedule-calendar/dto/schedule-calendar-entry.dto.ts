import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { SCHEDULE_ENTRY_TYPE_VALUES } from '../schedule-entry-types.catalog';
import { SCHEDULE_RECURRENCE_FREQUENCY_VALUES } from '../schedule-recurrence.catalog';

export class CreateScheduleCalendarEntryDto {
  /** El tenant sale del header (`@CurrentTenant()`), nunca del body. */
  @IsIn(SCHEDULE_ENTRY_TYPE_VALUES, {
    message: `El tipo debe ser uno de: ${SCHEDULE_ENTRY_TYPE_VALUES.join(', ')}`,
  })
  type: string;

  @IsString()
  @IsNotEmpty({ message: 'El título es obligatorio' })
  @MaxLength(120)
  title: string;

  /** `null`/ausente = aplica a todos los roles del tenant. */
  @IsString()
  @IsOptional()
  roleId?: string | null;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsBoolean()
  @IsOptional()
  allDay?: boolean;

  /** `null`/ausente = no se repite. Ver `startAt`/`endAt` en schema.prisma. */
  @IsIn(SCHEDULE_RECURRENCE_FREQUENCY_VALUES, {
    message: `La frecuencia debe ser una de: ${SCHEDULE_RECURRENCE_FREQUENCY_VALUES.join(', ')}`,
  })
  @IsOptional()
  recurrenceFreq?: string | null;

  /**
   * Sin sentido sin `recurrenceFreq` — el service lo rechaza en ese caso. Con
   * `recurrenceFreq` seteado, `null`/ausente = "hasta nuevo aviso" (indefinido).
   */
  @IsDateString()
  @IsOptional()
  recurrenceUntil?: string | null;
}

export class UpdateScheduleCalendarEntryDto {
  @IsIn(SCHEDULE_ENTRY_TYPE_VALUES, {
    message: `El tipo debe ser uno de: ${SCHEDULE_ENTRY_TYPE_VALUES.join(', ')}`,
  })
  @IsOptional()
  type?: string;

  @IsString()
  @IsNotEmpty({ message: 'El título es obligatorio' })
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  roleId?: string | null;

  @IsDateString()
  @IsOptional()
  startAt?: string;

  @IsDateString()
  @IsOptional()
  endAt?: string;

  @IsBoolean()
  @IsOptional()
  allDay?: boolean;

  /** Ver el comentario equivalente en CreateScheduleCalendarEntryDto. */
  @IsIn(SCHEDULE_RECURRENCE_FREQUENCY_VALUES, {
    message: `La frecuencia debe ser una de: ${SCHEDULE_RECURRENCE_FREQUENCY_VALUES.join(', ')}`,
  })
  @IsOptional()
  recurrenceFreq?: string | null;

  @IsDateString()
  @IsOptional()
  recurrenceUntil?: string | null;
}
