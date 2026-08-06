import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { LlmModule } from '../llm/llm.module';
import { BrokerModule } from '../broker/broker.module';
import { UsersModule } from '../users/users.module';
import { FlowModule } from '../flow/flow.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [LlmModule, BrokerModule, UsersModule, FlowModule, AuthModule],
  providers: [ConversationsService],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
