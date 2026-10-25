import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from './config';

export class Mailer {
  private transport: Transporter | null = null;

  constructor(private config: Config) {
    if (config.smtp.enabled) {
      this.transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      });
    }
  }

  get enabled() {
    return !!this.transport;
  }

  async send(to: string, subject: string, text: string) {
    if (!this.transport) {
      console.log(`[mail] SMTP disabled; would send to ${to}: ${subject}\n${text}`);
      return;
    }
    await this.transport.sendMail({ from: this.config.smtp.from, to, subject, text });
  }
}
