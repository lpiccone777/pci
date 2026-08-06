import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AppConfigModule } from './config/app-config.module';
import { TenantGuard } from './common/guards/tenant.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { DevicesModule } from './modules/devices/devices.module';
import { ConversationsModule } from './modules/conversations/conversations.module';
import { InvgateModule } from './modules/invgate/invgate.module';
import { LlmModule } from './modules/llm/llm.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { BrokerModule } from './modules/broker/broker.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { FlowModule } from './modules/flow/flow.module';
import { SettingsModule } from './modules/settings/settings.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AppConfigModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    RbacModule,
    DevicesModule,
    ConversationsModule,
    InvgateModule,
    LlmModule,
    ChannelsModule,
    BrokerModule,
    MetricsModule,
    FlowModule,
    SettingsModule,
    WhatsAppModule,
  ],
  controllers: [AppController],
  providers: [AppService, TenantGuard],
})
export class AppModule {}
