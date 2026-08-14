import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AppConfigModule } from './config/app-config.module';
import { TenantGuard } from './common/guards/tenant.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { AreasModule } from './modules/areas/areas.module';
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
import { SmsModule } from './modules/sms/sms.module';
import { ContextSourcesModule } from './modules/context-sources/context-sources.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Habilita @Cron/@Interval en cualquier provider — hoy solo lo usa
    // ConversationsService.closeInactiveConversations().
    ScheduleModule.forRoot(),
    PrismaModule,
    AppConfigModule,
    AuthModule,
    UsersModule,
    TenantsModule,
    AreasModule,
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
    SmsModule,
    ContextSourcesModule,
  ],
  controllers: [AppController],
  providers: [AppService, TenantGuard],
})
export class AppModule {}
