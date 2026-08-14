import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { TwilioWhatsAppService } from './twilio-whatsapp.service';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { BrokerModule } from '../broker/broker.module';

/**
 * Agrupa los dos conectores de WhatsApp (Meta y Twilio) más sus webhooks. Ambos quedan
 * registrados siempre — cuál de los dos `*Service` realmente se suscribe a
 * `whatsapp.outgoing` lo decide el setting `WHATSAPP_PROVIDER` en cada `onModuleInit`
 * (ver el comentario ahí). Los dos webhooks también quedan siempre montados: solo importa
 * cuál URL se configuró del lado de Meta/Twilio.
 */
@Module({
  imports: [BrokerModule],
  controllers: [WhatsAppWebhookController, TwilioWebhookController],
  providers: [WhatsAppService, TwilioWhatsAppService],
  exports: [WhatsAppService, TwilioWhatsAppService],
})
export class WhatsAppModule {}
