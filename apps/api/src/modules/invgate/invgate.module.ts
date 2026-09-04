import { Module } from '@nestjs/common';
import { InvgateService } from './invgate.service';
import { InvgateController } from './invgate.controller';

// Integración con Invgate: crear/consultar/actualizar tickets
// usando un usuario técnico con permisos API (nunca credenciales de usuarios finales).
@Module({
  providers: [InvgateService],
  controllers: [InvgateController],
  exports: [InvgateService],
})
export class InvgateModule {}
