import { Controller, Post, Body, GatewayTimeoutException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  /**
   * Inyecta un mensaje como si viniera de un canal, pasando por RabbitMQ de punta
   * a punta (cola propia `whatsapp.simulate.incoming`, ver ConversationsService):
   * el objetivo es simular el funcionamiento real, no atajarlo.
   * Devuelve la respuesta del bot: es un endpoint de prueba y ver qué contestó
   * es justamente para lo que sirve.
   */
  @Post('simulate')
  async simulate(@Body() dto: { from: string; body: string; tenantId: string }) {
    try {
      const reply = await this.conversationsService.simulateIncomingMessage(
        dto.from,
        dto.body,
        dto.tenantId,
      );
      return { message: 'Mensaje procesado', reply };
    } catch (err: any) {
      // El request/reply vía RabbitMQ puede no volver nunca (RabbitMQ caído, LLM
      // colgado, etc.): un timeout claro es mejor que dejar la request esperando
      // o devolver un 500 genérico que no dice qué pasó.
      throw new GatewayTimeoutException(
        err?.message ?? 'No se recibió respuesta del orquestador a tiempo',
      );
    }
  }
}
