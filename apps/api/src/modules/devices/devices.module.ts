import { Module } from '@nestjs/common';

// Fingerprint de dispositivos. v1 = teléfono + User-Agent (decisión fijada en spec §7).
// Validez parametrizable desde backoffice (DEVICE_FINGERPRINT_TTL_DAYS).
@Module({})
export class DevicesModule {}
