import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { SubscriberService } from './subscriber.service';
import { WhatsappService } from './whatsapp.service';
import { ViberService } from './viber.service';
import { NotifyService } from './notify.service';
import { NotifyController } from './notify.controller';

@Module({
  imports: [TelegramModule],
  controllers: [NotifyController],
  providers: [SubscriberService, WhatsappService, ViberService, NotifyService],
  exports: [SubscriberService, WhatsappService, ViberService, NotifyService],
})
export class NotifyModule {}
