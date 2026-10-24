import { Module } from '@nestjs/common';
import { FeaturesController } from './features.controller';
import { InvgateModule } from '../invgate/invgate.module';

// Funciones opcionales prendidas (hoy, el voicebot), para que el frontend arme el menú.
@Module({
  imports: [InvgateModule],
  controllers: [FeaturesController],
})
export class FeaturesModule {}
