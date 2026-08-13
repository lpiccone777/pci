import { Module } from '@nestjs/common';
import { ContextSourcesService } from './context-sources.service';
import { ContextSourcesController } from './context-sources.controller';
import { ContextSourceConnectorService } from './broker/context-source-connector.service';
import { BrokerModule } from '../broker/broker.module';

@Module({
  imports: [BrokerModule],
  providers: [ContextSourcesService, ContextSourceConnectorService],
  controllers: [ContextSourcesController],
  exports: [ContextSourcesService],
})
export class ContextSourcesModule {}
