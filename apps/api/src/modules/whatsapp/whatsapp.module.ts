import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { GupshupWhatsAppService } from './gupshup-whatsapp.service';
import { GupshupWebhookController } from './gupshup-webhook.controller';
import { GupshupFileLoggerService } from './gupshup-file-logger.service';
import { BrokerModule } from '../broker/broker.module';
import { MediaModule } from '../../common/media.module';

/**
 * Agrupa los tres conectores de WhatsApp (Meta, Twilio y Gupshup) más sus webhooks. Los tres
 * quedan registrados siempre — cuál de los tres `*Service` realmente se suscribe a
 * `whatsapp.outgoing` lo decide el setting `WHATSAPP_PROVIDER` en cada `onModuleInit`
 * (ver el comentario ahí). Los tres webhooks también quedan siempre montados: solo importa
 * cuál URL se configuró del lado de Meta/Twilio/Gupshup.
 */
@Module({
  imports: [BrokerModule, MediaModule],
  controllers: [WhatsAppWebhookController, TwilioWebhookController, GupshupWebhookController],
  providers: [WhatsAppService, TwilioWhatsAppService, GupshupWhatsAppService, GupshupFileLoggerService],
  exports: [WhatsAppService, TwilioWhatsAppService, GupshupWhatsAppService],
})
export class WhatsAppModule {}
