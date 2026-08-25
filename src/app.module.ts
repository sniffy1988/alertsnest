import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { MetricsModule } from './metrics/metrics.module';
import { GeoModule } from './geo/geo.module';
import { LlmModule } from './llm/llm.module';
import { TelegramModule } from './telegram/telegram.module';
import { NotifyModule } from './notify/notify.module';
import { AlertsModule } from './alerts/alerts.module';
import { ScraperModule } from './scraper/scraper.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MetricsModule,
    GeoModule,
    LlmModule,
    TelegramModule,
    NotifyModule,
    AlertsModule,
    ScraperModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
