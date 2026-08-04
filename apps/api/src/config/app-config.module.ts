import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { SecretsCipher } from './secrets.cipher';

@Global()
@Module({
  providers: [AppConfigService, SecretsCipher],
  exports: [AppConfigService, SecretsCipher],
})
export class AppConfigModule {}
