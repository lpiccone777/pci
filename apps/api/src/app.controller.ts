import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';
import { PRIVACY_POLICY_HTML } from './privacy-policy.html';
import { COMPANY_SITE_HTML } from './company-site.html';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Borrador para completar "URL de la política de privacidad" en Meta for Developers durante testing. */
  @Get('privacy-policy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacyPolicy(): string {
    return PRIVACY_POLICY_HTML;
  }

  /** Borrador para completar "sitio web de la empresa" en Meta for Developers durante testing. */
  @Get('company')
  @Header('Content-Type', 'text/html; charset=utf-8')
  companySite(): string {
    return COMPANY_SITE_HTML;
  }
}
