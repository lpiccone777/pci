import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ScheduleCalendarService } from './schedule-calendar.service';
import {
  CreateScheduleCalendarEntryDto,
  UpdateScheduleCalendarEntryDto,
} from './dto/schedule-calendar-entry.dto';
import { SCHEDULE_ENTRY_TYPES } from './schedule-entry-types.catalog';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('schedule-calendar')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ScheduleCalendarController {
  constructor(private readonly scheduleCalendarService: ScheduleCalendarService) {}

  /** Catálogo de tipos (feriado/guardia), para el selector del formulario. */
  @Get('types')
  @RequirePermission('schedule-calendar', 'read')
  getTypes() {
    return SCHEDULE_ENTRY_TYPES;
  }

  @Get()
  @RequirePermission('schedule-calendar', 'read')
  async findAll(
    @CurrentTenant() tenantId: string,
    @Query('roleId') roleId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.scheduleCalendarService.findAll(tenantId, {
      roleId,
      type,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get(':id')
  @RequirePermission('schedule-calendar', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.scheduleCalendarService.findOne(tenantId, id);
  }

  @Post()
  @RequirePermission('schedule-calendar', 'create')
  async create(@Body() dto: CreateScheduleCalendarEntryDto, @CurrentTenant() tenantId: string) {
    return this.scheduleCalendarService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermission('schedule-calendar', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateScheduleCalendarEntryDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.scheduleCalendarService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('schedule-calendar', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.scheduleCalendarService.remove(tenantId, id);
  }

  /** Importa los feriados nacionales de `year` desde la API pública de argentinadatos.com. */
  @Post('import-ar-holidays/:year')
  @RequirePermission('schedule-calendar', 'create')
  async importArHolidays(
    @Param('year', ParseIntPipe) year: number,
    @CurrentTenant() tenantId: string,
  ) {
    return this.scheduleCalendarService.importArgentinaHolidays(tenantId, year);
  }

  /** Deshace el import de `year` en bloque, sin tocar entradas cargadas a mano. */
  @Delete('import-ar-holidays/:year')
  @RequirePermission('schedule-calendar', 'delete')
  async removeArHolidaysImport(
    @Param('year', ParseIntPipe) year: number,
    @CurrentTenant() tenantId: string,
  ) {
    return this.scheduleCalendarService.removeArgentinaHolidaysImport(tenantId, year);
  }
}
