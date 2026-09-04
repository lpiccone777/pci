import { Module } from '@nestjs/common';
import { TwilioMediaService } from './twilio-media.service';
import { GupshupMediaService } from './gupshup-media.service';

/**
 * Módulo propio (en vez de listar los servicios de media como provider suelto en cada
 * módulo que los usa) para que sean instancias únicas en toda la app — necesario para el
 * `@Cron` de limpieza de `TwilioMediaService`: si cada módulo tuviera su propia instancia
 * (como antes), el cron correría una vez por instancia sobre el mismo directorio en
 * disco, redundante (inofensivo, pero sin sentido). `GupshupMediaService` no tiene cron
 * propio — reusa la limpieza de `TwilioMediaService`, que barre el directorio compartido
 * sin importar qué proveedor descargó cada archivo (ver `media-storage.util.ts`).
 */
@Module({
  providers: [TwilioMediaService, GupshupMediaService],
  exports: [TwilioMediaService, GupshupMediaService],
})
export class MediaModule {}
