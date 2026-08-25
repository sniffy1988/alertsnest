import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { PipelineService } from '../alerts/pipeline.service';
import { fetchChannelHtml, isHttp429 } from './telegram-web-scrape';
import { parseChannelHtml } from './message-parser';
import { cleanMessage } from '../common/text';

@Injectable()
export class ScraperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScraperService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly backoffUntil = new Map<number, number>();
  private readonly backoffMs = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly pipeline: PipelineService,
  ) {}

  onModuleInit(): void {
    const interval = Number(this.config.get('SCRAPE_INTERVAL_MS') ?? 3000);
    const ms = Number.isFinite(interval) && interval >= 1000 ? interval : 3000;
    this.logger.log(`scraper start interval=${ms}ms`);
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  notifyChannelAdded(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.metrics.scrapeActive = true;
    try {
      const channels = await this.prisma.channel.findMany();
      this.metrics.channelCount = channels.length;
      const concurrency = Math.max(1, Number(this.config.get('SCRAPE_CONCURRENCY') ?? 4));
      const now = Date.now();
      const due = channels.filter((ch) => (this.backoffUntil.get(ch.id) ?? 0) <= now);
      for (let i = 0; i < due.length; i += concurrency) {
        const slice = due.slice(i, i + concurrency);
        await Promise.allSettled(slice.map((ch) => this.scrapeOne(ch)));
      }
      this.metrics.lastScrapeAt = new Date().toISOString();
    } catch (err) {
      this.logger.error(`tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.ticking = false;
      this.metrics.scrapeActive = false;
    }
  }

  private async scrapeOne(channel: { id: number; link: string; lastTelegramId: bigint }): Promise<void> {
    try {
      const html = await fetchChannelHtml(channel.link);
      const after = Number(channel.lastTelegramId);
      const { messages, maxTelegramId } = parseChannelHtml(html);

      const fresh = [];
      for (const msg of messages) {
        const text = cleanMessage(msg.text);
        if (!text) continue;
        const saved = await this.prisma.message.upsert({
          where: {
            telegramId_channelId: { telegramId: BigInt(msg.telegramId), channelId: channel.id },
          },
          create: {
            telegramId: BigInt(msg.telegramId),
            message: text,
            date: msg.date,
            channelId: channel.id,
            replyToTelegramId: msg.replyToTelegramId != null ? BigInt(msg.replyToTelegramId) : null,
          },
          update: msg.replyToTelegramId
            ? { replyToTelegramId: BigInt(msg.replyToTelegramId) }
            : {},
          include: { analysis: true },
        });
        if (saved.analysis) continue;
        fresh.push({
          dbId: saved.id,
          telegramId: msg.telegramId,
          text,
          channelId: channel.id,
          channel: channel.link,
          date: msg.date,
          replyToTelegramId: msg.replyToTelegramId ?? (saved.replyToTelegramId != null ? Number(saved.replyToTelegramId) : undefined),
          alert: Date.now() - msg.date.getTime() <= 15 * 60 * 1000,
        });
      }

      if (maxTelegramId && maxTelegramId > after) {
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { lastTelegramId: BigInt(maxTelegramId), lastScrapedAt: new Date() },
        });
      } else {
        await this.prisma.channel.update({
          where: { id: channel.id },
          data: { lastScrapedAt: new Date() },
        });
      }

      if (fresh.length) {
        const toAlert = fresh.filter((f) => f.alert).length;
        this.logger.log(
          `@${channel.link} queued=${fresh.length} alert=${toAlert} learn=${fresh.length - toAlert} lastId=${maxTelegramId ?? after}`,
        );
        this.pipeline.enqueue(fresh);
      }
      this.clearBackoff(channel.id);
    } catch (err) {
      if (isHttp429(err)) {
        const next = Math.min((this.backoffMs.get(channel.id) ?? 10_000) * 2, 40_000);
        this.backoffMs.set(channel.id, next === 20_000 || next === 40_000 ? next : 10_000);
        const wait = this.backoffMs.get(channel.id) ?? 10_000;
        this.backoffUntil.set(channel.id, Date.now() + wait);
        this.logger.warn(`429 on @${channel.link}, backoff ${wait}ms`);
        return;
      }
      this.logger.warn(`scrape @${channel.link} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private clearBackoff(channelId: number): void {
    this.backoffUntil.delete(channelId);
    this.backoffMs.delete(channelId);
  }
}
