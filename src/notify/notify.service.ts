import { Injectable, Optional } from '@nestjs/common';
import { TelegramService } from '../telegram/telegram.service';
import { WhatsappService } from './whatsapp.service';
import { ViberService } from './viber.service';
import type { AlertMessage, DeliveryUser } from './notify.types';

@Injectable()
export class NotifyService {
  constructor(
    @Optional() private readonly telegram?: TelegramService,
    @Optional() private readonly whatsapp?: WhatsappService,
    @Optional() private readonly viber?: ViberService,
  ) {}

  async send(user: DeliveryUser, message: AlertMessage): Promise<boolean> {
    const jobs: Array<Promise<boolean>> = [];
    if (user.telegramId != null && this.telegram) {
      jobs.push(this.telegram.sendHtml(Number(user.telegramId), message.html, message.telegramMarkup));
    }
    if (user.whatsappPhone && this.whatsapp?.ready) {
      jobs.push(this.whatsapp.send(user.whatsappPhone, message.text));
    }
    if (user.viberId && this.viber?.ready) {
      jobs.push(this.viber.send(user.viberId, message.text));
    }
    if (jobs.length === 0) return false;
    const results = await Promise.allSettled(jobs);
    return results.some((r) => r.status === 'fulfilled' && r.value);
  }
}
