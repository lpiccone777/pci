import { Controller, Post, Body, GatewayTimeoutException, NotFoundException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AppConfigService } from '../../config/app-config.service';
import { ConversationsService } from './conversations.service';

/**
 * Solo `JwtAuthGuard` (sin TenantGuard/RolesGuard): `tenantId` es opcional a propósito —
 * probar el ruteo por membresía requiere NO fijar empresa — así que no hay header
 * `X-Tenant-Id` que validar. Con el ruteo por membresía, un llamador anónimo podía
 * enumerar a qué empresas pertenece un teléfono (el selector lista los nombres) y
 * ejecutar flujos reales: ahora hace falta un token válido. Es deliberadamente solo
 * autenticación, no autorización: `simulate` es una herramienta de desarrollo/test que
 * cualquier persona logueada puede usar contra cualquier tenant/teléfono — para producción,
 * el endpoint entero se cierra con `CONVERSATIONS_SIMULATE_ENABLED` (ver `simulateEnabled()`
 * más abajo), no restringiendo quién lo puede llamar.
 */
@UseGuards(JwtAuthGuard)
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Inyecta un mensaje como si viniera de un canal, pasando por RabbitMQ de punta
   * a punta (cola propia `whatsapp.simulate.incoming`, ver ConversationsService):
   * el objetivo es simular el funcionamiento real, no atajarlo.
   * Devuelve la respuesta del bot: es un endpoint de prueba y ver qué contestó
   * es justamente para lo que sirve.
   *
   * `tenantId` es OPCIONAL: si se manda, se prueba el flujo de esa empresa puntual
   * (corta el ruteo); si se omite, el mensaje pasa por el ruteo por membresía del
   * teléfono igual que un canal real (una empresa → directo; varias → selector de
   * empresa; ninguna → se ignora, no hablamos con desconocidos). Ver
   * InboundTenantRoutingService.
   */
  @Post('simulate')
  async simulate(@Body() dto: { from: string; body: string; tenantId?: string }) {
    // Herramienta de desarrollo/test — deshabilitada por defecto en `NODE_ENV=production` (ver
    // `defaultSimulateEnabled`); `CONVERSATIONS_SIMULATE_ENABLED` en /settings o env la fuerza
    // en cualquier sentido. 404 (no 403): el endpoint no debería ni figurar como existente.
    if (!(await this.appConfig.simulateEnabled())) {
      throw new NotFoundException();
    }
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
