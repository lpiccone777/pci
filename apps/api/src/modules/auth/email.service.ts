// Abstracción de envío de emails. En producción se implementa con
// nodemailer/SMTP, SendGrid, AWS SES, etc.
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export abstract class EmailService {
  abstract send(message: EmailMessage): Promise<void>;
}
