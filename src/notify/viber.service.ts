import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SubscriberService } from './subscriber.service';
import { t, type Locale } from '../common/i18n';
import { MetricsService } from '../metrics/metrics.service';

type ViberCallback = {
  event?: string;
  context?: string;
  sender?: { id?: string; name?: string; language?: string };
  user?: { id?: string; name?: string; language?: string };
  message?: { type?: string; text?: string; location?: { lat?: number; lon?: number } };
};

@Injectable()
export class ViberService implements OnModuleInit {
  private readonly logger = new Logger(ViberService.name);
  private readonly token: string;
  private readonly senderName: string;
  private readonly publicUrl: string;
  readonly uri: string;

  constructor(
    config: ConfigService,
    private readonly subscribers: SubscriberService,
    metrics: MetricsService,
  ) {
    this.token = (config.get<string>('VIBER_AUTH_TOKEN') || '').trim();
    this.senderName = (config.get<string>('VIBER_SENDER_NAME') || 'AlertsNest').slice(0, 28);
    this.uri = (config.get<string>('VIBER_URI') || '').trim();
    this.publicUrl = (config.get<string>('PUBLIC_BASE_URL') || '').replace(/\/$/, '');
    metrics.viberReady = this.ready;
  }

  get ready(): boolean {
    return Boolean(this.token);
  }

  inviteUrl(): string | null {
    return this.uri ? `viber://pa?chatURI=${this.uri}` : null;
  }

  async onModuleInit(): Promise<void> {
    if (!this.ready || !this.publicUrl.startsWith('https://')) {
      if (this.token && !this.publicUrl.startsWith('https://')) {
        this.logger.warn('VIBER_AUTH_TOKEN set but PUBLIC_BASE_URL is not https — webhook not registered');
      }
      return;
    }
    try {
      const { data } = await axios.post(
        'https://chatapi.viber.com/pa/set_webhook',
        {
          url: `${this.publicUrl}/webhooks/viber`,
          event_types: ['subscribed', 'unsubscribed', 'conversation_started', 'message'],
          send_name: true,
        },
        { headers: { 'X-Viber-Auth-Token': this.token }, timeout: 10_000 },
      );
      this.logger.log(`Viber webhook: ${JSON.stringify(data)}`);
    } catch (err) {
      this.logger.warn(`Viber set_webhook failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  async handleWebhook(body: ViberCallback): Promise<void> {
    if (!this.ready) return;
    if (body.event === 'webhook' || body.event === 'delivered' || body.event === 'seen') return;
    const person = body.sender ?? body.user;
    const id = person?.id;
    if (!id) return;
    const locale = this.localeOf(person?.language);

    if (body.event === 'unsubscribed') {
      await this.subscribers.upsert({ viberId: id, locale }, {});
      return;
    }

    const loc = body.message?.location;
    if (body.message?.type === 'location' && loc?.lat != null && loc.lon != null) {
      const saved = await this.subscribers.saveLocation(
        { viberId: id, firstName: person?.name, locale },
        loc.lat,
        loc.lon,
      );
      const key = saved.oblastCode === 'outside' ? 'location_saved_no_oblast' : 'location_saved';
      await this.send(id, t(saved.locale, key, { oblast: saved.label }), true);
      return;
    }

    await this.send(id, t(locale, 'invite_send_geo'), true);
  }

  async send(to: string, text: string, askLocation = false): Promise<boolean> {
    if (!this.ready) return false;
    const payload: Record<string, unknown> = {
      receiver: to,
      min_api_version: 1,
      sender: { name: this.senderName },
      type: 'text',
      text,
    };
    if (askLocation) {
      payload.keyboard = {
        Type: 'keyboard',
        DefaultHeight: true,
        Buttons: [
          {
            ActionType: 'location-picker',
            ActionBody: 'location',
            Text: '📍',
            Columns: 6,
            Rows: 1,
          },
        ],
      };
    }
    try {
      const { data } = await axios.post('https://chatapi.viber.com/pa/send_message', payload, {
        headers: { 'X-Viber-Auth-Token': this.token, 'Content-Type': 'application/json' },
        timeout: 10_000,
      });
      if (data?.status !== 0) {
        this.logger.warn(`Viber send status=${data?.status} ${data?.status_message ?? ''}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Viber send failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private localeOf(lang?: string): Locale {
    if (lang === 'uk' || lang === 'ua') return 'ua';
    if (lang === 'ru') return 'ru';
    if (lang === 'en') return 'en';
    return 'ua';
  }
}
