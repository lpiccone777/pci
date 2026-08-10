import { Module } from '@nestjs/common';
import { FlowService } from './flow.service';
import { FlowController } from './flow.controller';
import { SystemTenantGuard } from '../../common/guards/system-tenant.guard';

@Module({
  // SystemTenantGuard inyecta PrismaService + ConfigService, así que va como
  // provider para que Nest lo pueda instanciar en `GET /flows/all`.
  providers: [FlowService, SystemTenantGuard],
  controllers: [FlowController],
  exports: [FlowService],
})
export class FlowModule {}
