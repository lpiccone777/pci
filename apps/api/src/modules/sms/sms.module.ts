import { Module } from '@nestjs/common';
import { TwilioSmsService } from './twilio-sms.service';
import { TwilioSmsWebhookController } from './twilio-sms-webhook.controller';
import { GupshupSmsService } from './gupshup-sms.service';
import { GupshupSmsWebhookController } from './gupshup-sms-webhook.controller';
import { GupshupFileLoggerService } from '../whatsapp/gupshup-file-logger.service';
import { BrokerModule } from '../broker/broker.module';
import { MediaModule } from '../../common/media.module';

// Canal de SMS (Twilio o Gupshup, elegido con SMS_PROVIDER). No es una alternativa de
// WhatsApp — es un canal propio, con sus propias colas (`sms.outgoing`/`sms.incoming`) y sus
// propias `Conversation` (`channel: 'sms'`, ver ConversationsService).
//
// `GupshupFileLoggerService` se declara acá TAMBIÉN (no se importa `WhatsAppModule`): es un
// logger de archivo sin estado compartido real entre instancias (solo escribe a la misma
// ruta en disco), así que duplicarlo evita acoplar el módulo de SMS al de WhatsApp para lo
// que sería un solo servicio sin lógica de negocio.
@Module({
  imports: [BrokerModule, MediaModule],
  controllers: [TwilioSmsWebhookController, GupshupSmsWebhookController],
  providers: [TwilioSmsService, GupshupSmsService, GupshupFileLoggerService],
  exports: [TwilioSmsService, GupshupSmsService],
})
export class SmsModule {}
