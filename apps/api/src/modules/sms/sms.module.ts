import { Module } from '@nestjs/common';
import { TwilioSmsService } from './twilio-sms.service';
import { GupshupSmsService } from './gupshup-sms.service';
import { GupshupFileLoggerService } from '../whatsapp/gupshup-file-logger.service';
import { BrokerModule } from '../broker/broker.module';

// Canal de SMS (Twilio o Gupshup, elegido con SMS_PROVIDER) — 100% saliente (avisos, no
// conversación bidireccional): no hay webhook de entrada, solo `sms.outgoing`. No es una
// alternativa de WhatsApp — es un canal propio, con sus propias `Conversation`
// (`channel: 'sms'`, ver ConversationsService) para lo que sí corre por acá (el nodo `sms`
// del editor de flujos).
//
// `GupshupFileLoggerService` se declara acá TAMBIÉN (no se importa `WhatsAppModule`): es un
// logger de archivo sin estado compartido real entre instancias (solo escribe a la misma
// ruta en disco), así que duplicarlo evita acoplar el módulo de SMS al de WhatsApp para lo
// que sería un solo servicio sin lógica de negocio.
@Module({
  imports: [BrokerModule],
  providers: [TwilioSmsService, GupshupSmsService, GupshupFileLoggerService],
  exports: [TwilioSmsService, GupshupSmsService],
})
export class SmsModule {}
