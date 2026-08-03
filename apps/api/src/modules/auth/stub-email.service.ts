import { Injectable } from '@nestjs/common';
import { EmailService, EmailMessage } from './email.service';

// Stub: en desarrollo loguea el email en consola.
// NUNCA usar en producción — reemplazar por implementación real.
@Injectable()
export class StubEmailService extends EmailService {
  async send(message: EmailMessage): Promise<void> {
    console.log('[STUB EMAIL]');
    console.log(`To: ${message.to}`);
    console.log(`Subject: ${message.subject}`);
    console.log(`Body: ${message.text}`);
  }
}
