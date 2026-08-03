import { Controller, Post, Body } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post('simulate')
  async simulate(
    @Body() dto: { from: string; body: string; tenantId: string },
  ) {
    await this.conversationsService.processIncomingMessage(
      dto.from,
      dto.body,
      dto.tenantId,
    );
    return { message: 'Mensaje procesado' };
  }
}
