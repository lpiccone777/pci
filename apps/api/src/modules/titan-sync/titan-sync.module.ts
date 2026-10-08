import { Module } from '@nestjs/common';
import { TitanSyncController } from './titan-sync.controller';
import { TitanSyncService } from './titan-sync.service';

/**
 * Módulo instalable de importación de usuarios desde TitanHR.
 *
 * Autocontenido: sus tablas (`TitanConnection`, `TitanUserLink`), su permiso (`titan-sync`)
 * y su interruptor (`TITAN_SYNC_ENABLED`). Ningún otro módulo depende de él. Para
 * desinstalarlo alcanza con apagar el setting; para sacarlo del todo, quitarlo de
 * `app.module.ts` (las tablas quedan, inertes).
 *
 * Usa un usuario técnico de rol IT de Titan por empresa, nunca credenciales del usuario
 * final (mismo criterio que Invgate). Contrato de Titan en `docs/titanhr-rbac.md`.
 */
@Module({
  controllers: [TitanSyncController],
  providers: [TitanSyncService],
})
export class TitanSyncModule {}
