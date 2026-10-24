import { Module } from '@nestjs/common';
import { FeaturesController } from './features.controller';

// Funciones opcionales prendidas (hoy, el voicebot), para que el frontend arme el menú.
@Module({
  controllers: [FeaturesController],
})
export class FeaturesModule {}
