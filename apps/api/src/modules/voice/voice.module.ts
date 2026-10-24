import { Module } from '@nestjs/common';
import { BrokerModule } from '../broker/broker.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { FlowModule } from '../flow/flow.module';
import { VoiceTurnsService } from './voice-turns.service';

// Canal de voz (contrato de integración §5): consume `voice.events` y el RPC `voice.turn` del
// voicebot y los corre contra el motor de flujos con canal `voice`.
@Module({
  imports: [BrokerModule, ConversationsModule, FlowModule],
  providers: [VoiceTurnsService],
})
export class VoiceModule {}
