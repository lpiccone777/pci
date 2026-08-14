import { Module } from '@nestjs/common';
import { TwilioSmsService } from './twilio-sms.service';
import { TwilioSmsWebhookController } from './twilio-sms-webhook.controller';
import { BrokerModule } from '../broker/broker.module';

// Canal de SMS (Twilio). No es una alternativa de WhatsApp — es un canal propio, con sus
// propias colas (`sms.outgoing`/`sms.incoming`) y sus propias `Conversation`
// (`channel: 'sms'`, ver ConversationsService).
@Module({
  imports: [BrokerModule],
  controllers: [TwilioSmsWebhookController],
  providers: [TwilioSmsService],
  exports: [TwilioSmsService],
})
export class SmsModule {}
