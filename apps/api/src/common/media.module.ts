import { Module } from '@nestjs/common';
import { TwilioMediaService } from './twilio-media.service';

/**
 * Módulo propio (en vez de listar `TwilioMediaService` como provider suelto en cada
 * módulo que lo usa) para que sea una única instancia real en toda la app — necesario
 * para el `@Cron` de limpieza de `TwilioMediaService`: si cada módulo tuviera su propia
 * instancia (como antes), el cron correría una vez por instancia sobre el mismo
 * directorio en disco, redundante (inofensivo, pero sin sentido).
 */
@Module({
  providers: [TwilioMediaService],
  exports: [TwilioMediaService],
})
export class MediaModule {}
