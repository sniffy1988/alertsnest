import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { PipelineService } from './pipeline.service';
import { LlmModule } from '../llm/llm.module';
import { NotifyModule } from '../notify/notify.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [LlmModule, NotifyModule, TelegramModule],
  providers: [AlertsService, PipelineService],
  exports: [AlertsService, PipelineService],
})
export class AlertsModule {}
