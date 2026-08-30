import { Module } from '@nestjs/common';
import { TwilioSmsService } from './twilio-sms.service';
import { TwilioSmsWebhookController } from './twilio-sms-webhook.controller';
import { GupshupSmsService } from './gupshup-sms.service';
import { GupshupSmsWebhookController } from './gupshup-sms-webhook.controller';
import { BrokerModule } from '../broker/broker.module';
import { MediaModule } from '../../common/media.module';
import { TwilioSignatureGuard } from '../../common/guards/twilio-signature.guard';

// Canal de SMS (Twilio o Gupshup, elegido con SMS_PROVIDER). No es una alternativa de
// WhatsApp — es un canal propio, con sus propias colas (`sms.outgoing`/`sms.incoming`) y sus
// propias `Conversation` (`channel: 'sms'`, ver ConversationsService).
@Module({
  imports: [BrokerModule, MediaModule],
  controllers: [TwilioSmsWebhookController, GupshupSmsWebhookController],
  providers: [TwilioSmsService, GupshupSmsService, TwilioSignatureGuard],
  exports: [TwilioSmsService, GupshupSmsService],
})
export class SmsModule {}
