import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { AppConfigService } from '../../config/app-config.service';
import { EmailService, EmailMessage } from './email.service';

/**
 * Envío real por SMTP. Lee la config vía `AppConfigService` (BD → env → default)
 * en cada `send()`, no una sola vez al arrancar — así un cambio desde /settings
 * aplica sin reiniciar el backend, igual que el resto de la config del sistema.
 *
 * Sin `EMAIL_SMTP_HOST` configurado, cae al mismo comportamiento que el viejo
 * `StubEmailService` (loguea en consola) en vez de romper: la mayoría de los
 * entornos de desarrollo nunca van a tener SMTP configurado.
 */
@Injectable()
export class SmtpEmailService extends EmailService {
  private readonly logger = new Logger(SmtpEmailService.name);

  constructor(private readonly appConfig: AppConfigService) {
    super();
  }

  async send(message: EmailMessage): Promise<void> {
    const host = await this.appConfig.get('EMAIL_SMTP_HOST');

    if (!host) {
      this.logger.warn('EMAIL_SMTP_HOST no configurado — logueando el email en consola.');
      console.log('[STUB EMAIL]');
      console.log(`To: ${message.to}`);
      console.log(`Subject: ${message.subject}`);
      console.log(`Body: ${message.text}`);
      return;
    }

    const transporter = await this.buildTransporter(host);
    const from = (await this.appConfig.get('EMAIL_FROM')) || 'no-reply@localhost';

    await transporter.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    this.logger.log(`Email enviado a ${message.to}: "${message.subject}"`);
  }

  private async buildTransporter(host: string): Promise<Transporter> {
    const [port, secure, user, pass] = await Promise.all([
      this.appConfig.getNumber('EMAIL_SMTP_PORT', 587),
      this.appConfig.getBoolean('EMAIL_SMTP_SECURE', false),
      this.appConfig.get('EMAIL_SMTP_USER'),
      this.appConfig.get('EMAIL_SMTP_PASS'),
    ]);

    return createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass } : undefined,
    });
  }
}
