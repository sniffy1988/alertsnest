import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GeoService, type ResolvedPlace } from '../geo/geo.service';
import { NotifyService } from '../notify/notify.service';
import { TelegramService } from '../telegram/telegram.service';
import { MetricsService } from '../metrics/metrics.service';
import { escapeHtml, previewMessage } from '../common/text';
import { t } from '../common/i18n';
import { threatLabel } from '../llm/threat-slang';
import { ALERT_DEDUP_MS, eventKeysOverlap } from './event-key';

export type AlertPayload = {
  messageId: number;
  channel: string;
  text: string;
  summary: string | null;
  eventKey: string;
  threatType: string | null;
  trackLost?: boolean;
  places: ResolvedPlace[];
};

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly concurrency: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly geo: GeoService,
    private readonly notify: NotifyService,
    private readonly telegram: TelegramService,
    private readonly metrics: MetricsService,
  ) {
    this.concurrency = Math.max(1, Number(config.get('ALERT_SEND_CONCURRENCY') ?? 8));
  }

  async dispatch(payload: AlertPayload): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        isBanned: false,
        silentMode: false,
        NOT: { oblastCode: 'outside' },
      },
    });

    const already = await this.prisma.alertDelivery.findMany({
      where: {
        eventKey: payload.eventKey,
        sentAt: { gte: new Date(Date.now() - ALERT_DEDUP_MS) },
      },
      select: { userId: true },
    });
    const alreadyIds = new Set(already.map((row) => row.userId));
    if (payload.threatType === 'all_clear' && alreadyIds.size > 0) {
      this.logger.log(`skip key=${payload.eventKey}: all_clear already sent`);
      return;
    }

    const targets = users.filter((user) => {
      if (alreadyIds.has(user.id)) return false;
      if (user.lat == null && user.lon == null && !user.oblastCode) return false;
      return this.geo.matchUser(user, payload.places, {
        cityWide: payload.threatType === 'all_clear',
      }).ok;
    });

    this.logger.log(
      `dispatch key=${payload.eventKey} places=[${payload.places.map((p) => p.name).join(', ')}] ` +
        `users=${users.length} matched=${targets.length} dedup=${alreadyIds.size}`,
    );
    if (!targets.length) return;

    let i = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, targets.length) }, async () => {
      while (i < targets.length) {
        const user = targets[i++];
        await this.sendOne(user, payload);
      }
    });
    await Promise.all(workers);
    this.metrics.lastAlertAt = new Date().toISOString();
    void this.telegram.offerPlaceFix({
      messageId: payload.messageId,
      channel: payload.channel,
      text: payload.text,
      place: payload.places[0]?.name ?? '—',
      users: targets.length,
    });
  }

  private async sendOne(
    user: {
      id: number;
      telegramId: bigint | null;
      whatsappPhone: string | null;
      viberId: string | null;
      locale: string;
      lat: number | null;
      lon: number | null;
      oblastCode: string | null;
    },
    payload: AlertPayload,
  ): Promise<void> {
    const recent = await this.prisma.alertDelivery.findMany({
      where: {
        userId: user.id,
        sentAt: { gte: new Date(Date.now() - ALERT_DEDUP_MS) },
        eventKey: { not: null },
      },
      select: { eventKey: true },
      take: 50,
    });
    if (recent.some((row) => row.eventKey && eventKeysOverlap(row.eventKey, payload.eventKey))) {
      return;
    }

    const match = this.geo.matchUser(user, payload.places, {
      cityWide: payload.threatType === 'all_clear',
    });
    const loc = user.locale;
    const place = match.place?.name ?? payload.places[0]?.name ?? 'Харків';
    const km =
      match.km != null ? t(loc, 'alert_distance', { km: String(Math.max(1, Math.round(match.km))) }) : '';
    const kind = threatLabel(payload.threatType, loc);
    const titleKey =
      payload.threatType === 'all_clear'
        ? 'alert_clear_title'
        : payload.trackLost
          ? 'alert_lost_title'
          : 'alert_title';
    const lines = [
      t(loc, titleKey),
      kind,
      payload.summary || previewMessage(payload.text, 240),
      `${place}${km ? ` · ${km}` : ''}`,
      t(loc, 'alert_source', { channel: payload.channel }),
    ];
    const text = lines.join('\n');
    const html = [
      `<b>${escapeHtml(t(loc, titleKey))}</b>`,
      `<b>${escapeHtml(kind)}</b>`,
      escapeHtml(payload.summary || previewMessage(payload.text, 240)),
      `${escapeHtml(place)}${km ? ` · ${escapeHtml(km)}` : ''}`,
      escapeHtml(t(loc, 'alert_source', { channel: payload.channel })),
    ].join('\n');

    try {
      const sent = await this.notify.send(user, {
        html,
        text,
        telegramMarkup: this.telegram.alertWrongPlaceKeyboard(loc, payload.messageId),
      });
      if (!sent) {
        this.logger.warn(`alert to user ${user.id} skipped: no delivery channel`);
        return;
      }
      await this.prisma.alertDelivery.create({
        data: {
          userId: user.id,
          messageId: payload.messageId,
          eventKey: payload.eventKey,
        },
      });
      this.logger.log(
        `sent user=${user.id} place=${place} km=${match.km != null ? match.km.toFixed(1) : '-'} key=${payload.eventKey}`,
      );
    } catch (err) {
      this.logger.warn(`alert to user ${user.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
