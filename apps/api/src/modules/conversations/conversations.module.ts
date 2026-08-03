import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { LlmModule } from '../llm/llm.module';
import { BrokerModule } from '../broker/broker.module';
import { UsersModule } from '../users/users.module';
import { FlowModule } from '../flow/flow.module';

@Module({
  imports: [LlmModule, BrokerModule, UsersModule, FlowModule],
  providers: [ConversationsService],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
