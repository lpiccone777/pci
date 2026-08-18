import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { SkillsService } from './skills.service';
import { CreateSkillDto, UpdateSkillDto } from './dto/skill.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('skills')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class SkillsController {
  constructor(private readonly skillsService: SkillsService) {}

  @Get()
  @RequirePermission('skills', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.skillsService.findAll(tenantId);
  }

  @Get(':id')
  @RequirePermission('skills', 'read')
  async findOne(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.skillsService.findOne(tenantId, id);
  }

  @Post()
  @RequirePermission('skills', 'create')
  async create(@Body() dto: CreateSkillDto, @CurrentTenant() tenantId: string) {
    return this.skillsService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermission('skills', 'update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @CurrentTenant() tenantId: string,
  ) {
    return this.skillsService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('skills', 'delete')
  async remove(@Param('id') id: string, @CurrentTenant() tenantId: string) {
    return this.skillsService.remove(tenantId, id);
  }
}
