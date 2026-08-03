import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AppConfigModule } from './config/app-config.module';
import { TenantInterceptor } from './common/interceptors/tenant.interceptor';
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
  ],
  controllers: [AppController],
  providers: [AppService, TenantInterceptor],
})
export class AppModule {}
