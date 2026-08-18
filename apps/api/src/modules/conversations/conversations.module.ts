import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { LlmModule } from '../llm/llm.module';
import { BrokerModule } from '../broker/broker.module';
import { UsersModule } from '../users/users.module';
import { FlowModule } from '../flow/flow.module';
import { AuthModule } from '../auth/auth.module';
import { ContextSourcesModule } from '../context-sources/context-sources.module';
import { InvgateModule } from '../invgate/invgate.module';

@Module({
  imports: [LlmModule, BrokerModule, UsersModule, FlowModule, AuthModule, ContextSourcesModule, InvgateModule],
  providers: [ConversationsService],
  controllers: [ConversationsController],
})
export class ConversationsModule {}
