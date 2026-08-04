import { Module } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';

@Module({
  providers: [TenantsService, SystemTenantGuard],
  controllers: [TenantsController],
})
export class TenantsModule {}
