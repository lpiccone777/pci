import { Injectable } from '@nestjs/common';
import { BrokerService } from '../broker/broker.service';

@Injectable()
export class ChannelsService {
  constructor(private readonly broker: BrokerService) {}

  async sendWhatsApp(to: string, body: string, tenantId: string) {
    return this.broker.publish('whatsapp.outgoing', {
      pattern: 'message.send',
      data: { to, body },
      tenantId,
      timestamp: new Date().toISOString(),
    });
  }
}
