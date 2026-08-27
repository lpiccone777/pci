import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

// Métricas y auditoría: registro estructurado de cada consulta
// (timestamp, usuario, tenant, tiempo de respuesta, canal, resolución).
// Hoy solo expone los conteos del dashboard (`GET /metrics/dashboard`).
@Module({
  providers: [MetricsService],
  controllers: [MetricsController],
})
export class MetricsModule {}
