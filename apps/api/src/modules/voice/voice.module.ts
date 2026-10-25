import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { FlowModule } from '../flow/flow.module';
import { VoiceTurnsService } from './voice-turns.service';
import { VoiceOutboundService } from './voice-outbound.service';
import { VoiceOutboundController } from './voice-outbound.controller';

// Canal de voz (contrato de integración §5): consume `voice.events` y el RPC `voice.turn` del
// voicebot y los corre contra el motor de flujos con canal `voice`. Salientes desde pci (§6, H5).
@Module({
  imports: [BrokerModule, ConversationsModule, FlowModule],
  controllers: [VoiceOutboundController],
  providers: [VoiceTurnsService, VoiceOutboundService],
})
export class VoiceModule {}
