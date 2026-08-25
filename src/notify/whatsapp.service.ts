import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SubscriberService } from './subscriber.service';
import { t } from '../common/i18n';
import { MetricsService } from '../metrics/metrics.service';

type WhatsappMessage = {
  from?: string;
  type?: string;
  text?: { body?: string };
  location?: { latitude?: number; longitude?: number };
};

type WhatsappWebhook = {
  entry?: Array<{
    changes?: Array<{
      value?: { messages?: WhatsappMessage[] };
    }>;
  }>;
};

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly verifyToken: string;
  private readonly apiVersion: string;
  private readonly templateName: string;
  private readonly templateLang: string;
  readonly displayNumber: string;

  constructor(
    config: ConfigService,
    private readonly subscribers: SubscriberService,
    metrics: MetricsService,
  ) {
    this.token = (config.get<string>('WHATSAPP_TOKEN') || '').trim();
    this.phoneNumberId = (config.get<string>('WHATSAPP_PHONE_NUMBER_ID') || '').trim();
    this.verifyToken = (config.get<string>('WHATSAPP_VERIFY_TOKEN') || '').trim();
    this.apiVersion = (config.get<string>('WHATSAPP_API_VERSION') || 'v21.0').trim();
    this.templateName = (config.get<string>('WHATSAPP_TEMPLATE_NAME') || '').trim();
    this.templateLang = (config.get<string>('WHATSAPP_TEMPLATE_LANG') || 'uk').trim();
    this.displayNumber = (config.get<string>('WHATSAPP_DISPLAY_NUMBER') || '').replace(/\D/g, '');
    metrics.whatsappReady = this.ready;
  }

  get ready(): boolean {
    return Boolean(this.token && this.phoneNumberId);
  }

  inviteUrl(): string | null {
    return this.displayNumber ? `https://wa.me/${this.displayNumber}` : null;
  }

  verifyWebhook(mode: string | undefined, token: string | undefined): boolean {
    return mode === 'subscribe' && Boolean(this.verifyToken) && token === this.verifyToken;
  }

  async handleWebhook(body: WhatsappWebhook): Promise<void> {
    if (!this.ready) return;
    const messages = body.entry?.flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []) ?? [];
    for (const msg of messages) {
      const phone = (msg.from || '').replace(/\D/g, '');
      if (!phone) continue;
      if (msg.type === 'location' && msg.location?.latitude != null && msg.location.longitude != null) {
        const saved = await this.subscribers.saveLocation(
          { whatsappPhone: phone, locale: 'ua' },
          msg.location.latitude,
          msg.location.longitude,
        );
        const key = saved.oblastCode === 'outside' ? 'location_saved_no_oblast' : 'location_saved';
        await this.sendText(phone, t(saved.locale, key, { oblast: saved.label }));
        continue;
      }
      await this.sendLocationInvite(phone, 'ua');
    }
  }

  async send(to: string, text: string): Promise<boolean> {
    if (!this.ready) return false;
    if (this.templateName) {
      const ok = await this.sendTemplate(to, text);
      if (ok) return true;
    }
    return this.sendText(to, text);
  }

  async sendLocationInvite(to: string, locale: string): Promise<void> {
    const body = t(locale, 'invite_send_geo');
    const ok = await this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'location_request_message',
        body: { text: body },
        action: { name: 'send_location' },
      },
    });
    if (!ok) await this.sendText(to, body);
  }

  private async sendText(to: string, text: string): Promise<boolean> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    });
  }

  private async sendTemplate(to: string, text: string): Promise<boolean> {
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: this.templateName,
        language: { code: this.templateLang },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: text.replace(/\s+/g, ' ').slice(0, 1024) }],
          },
        ],
      },
    });
  }

  private async post(data: unknown): Promise<boolean> {
    try {
      await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`,
        data,
        {
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          timeout: 10_000,
        },
      );
      return true;
    } catch (err) {
      this.logger.warn(`WhatsApp send failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
