import { Module } from '@nestjs/common';
import { InvgateService } from './invgate.service';

// Integración con Invgate: crear/consultar/actualizar tickets
// usando un usuario técnico con permisos API (nunca credenciales de usuarios finales).
@Module({
  providers: [InvgateService],
  exports: [InvgateService],
})
export class InvgateModule {}
