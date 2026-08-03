import { Controller, Get, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { RolesGuard } from '../rbac/guards/roles.guard';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermission('users', 'read')
  async findAll(@CurrentTenant() tenantId: string) {
    return this.usersService.findAll(tenantId);
  }
}
