import { Module } from '@nestjs/common';
import { ChannelsService } from './channels.service';
import { BrokerModule } from '../broker/broker.module';

@Module({
  imports: [BrokerModule],
  providers: [ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
