import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { GeoService } from '../geo/geo.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from '../telegram/telegram.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  isAllClearPost,
  isContinuation,
  isEtaOnly,
  isNoisePost,
  leftOblast,
  resolveChainFromKnown,
  type ChainMessage,
} from './message-chain';
import { ALERT_DEDUP_MS, canonicalEventKey, eventKeysOverlap } from './event-key';
import { isCityWideKharkivCue, isPlausiblePlaceLabel } from '../geo/place-match';
import { isThreatLabel } from '../llm/threat-slang';

export type BufferedMessage = {
  dbId: number;
  telegramId: number;
  text: string;
  channelId: number;
  channel: string;
  date: Date;
  replyToTelegramId?: number;
  alert: boolean;
};

const ALERT_MAX_AGE_MS = 15 * 60 * 1000;

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private buffer: BufferedMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private readonly inFlight = new Set<number>();
  private readonly batchSize: number;
  private readonly waitMs: number;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly geo: GeoService,
    private readonly alerts: AlertsService,
    private readonly telegram: TelegramService,
    private readonly metrics: MetricsService,
  ) {
    this.batchSize = Math.max(1, Number(config.get('LLM_BATCH_SIZE') ?? 6));
    this.waitMs = Math.max(500, Number(config.get('LLM_BATCH_WAIT_MS') ?? 2000));
  }

  enqueue(items: BufferedMessage[]): void {
    const queued = new Set(this.buffer.map((item) => item.dbId));
    const fresh = items.filter((item) => {
      if (queued.has(item.dbId) || this.inFlight.has(item.dbId)) return false;
      queued.add(item.dbId);
      return true;
    });
    if (!fresh.length) return;
    this.buffer.push(...fresh);
    this.metrics.bufferSize = this.buffer.length;
    this.logger.debug(`enqueue +${fresh.length} buffer=${this.buffer.length}`);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.waitMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    this.flushing = true;
    const batch = this.buffer.splice(0, this.batchSize);
    for (const item of batch) this.inFlight.add(item.dbId);
    this.metrics.bufferSize = this.buffer.length;
    this.logger.log(`flush batch=${batch.length} leftover=${this.buffer.length} channels=${[...new Set(batch.map((b) => b.channel))].join(',')}`);

    try {
      const chains = await this.loadChains(batch);
      const results = await this.llm.analyzeBatch(
        batch.map((item) => ({
          id: String(item.dbId),
          channel: item.channel,
          text: item.text,
          context: chains.get(item.dbId)?.context ?? [],
        })),
      );

      if (results.length === 0) {
        this.logger.warn('empty LLM result, dropping batch');
        return;
      }

      const deliveredEvents = new Set<string>();

      for (const item of batch) {
        const analysis = results.find((r) => r.id === String(item.dbId));
        if (!analysis) continue;

        const chain = chains.get(item.dbId);
        if (isNoisePost(item.text)) {
          await this.persistAnalysis(item.dbId, analysis, analysis.eventKey);
          this.logger.debug(`msg ${item.dbId} noise/donate, skip`);
          continue;
        }
        if (isEtaOnly(item.text)) {
          this.logger.log(`msg ${item.dbId} ETA only, no push`);
        }
        if (leftOblast(item.text)) {
          this.logger.log(`msg ${item.dbId} left oblast, no city push`);
        }
        const placeText =
          analysis.trackLost && chain?.context.length
            ? `${chain.context[chain.context.length - 1]}\n${item.text}`
            : item.text;
        const resolved =
          analysis.threatType === 'all_clear'
            ? { places: await this.geo.resolveAndLearn(['Харків']), foreign: [] as string[], unknown: [] as string[] }
            : analysis.notify
              ? await this.geo.resolveThreatPlaces({
                  text: placeText,
                  llmPlaces: analysis.places,
                  oblast: analysis.oblast,
                  geoScope: analysis.geoScope,
                })
              : { places: [], foreign: [], unknown: [] };
        const places = [...resolved.places];

        const storedKey =
          places.length > 0
            ? canonicalEventKey({
                threatType: analysis.threatType,
                places,
                trackLost: analysis.trackLost,
              })
            : analysis.eventKey;

        this.logger.log(
          `msg ${item.dbId} @${item.channel} threat=${analysis.isThreat} type=${analysis.threatType ?? '-'} ` +
            `lost=${analysis.trackLost} chain=${chain?.context.length ?? 0} ` +
            `places=[${analysis.places.join(', ')}] resolved=[${places.map((p) => `${p.name}/${p.matchType}`).join(', ')}] ` +
            `foreign=[${resolved.foreign.join(', ')}] unknown=[${resolved.unknown.join(', ')}] ` +
            `key=${storedKey ?? '-'}`,
        );

        await this.persistAnalysis(item.dbId, analysis, storedKey);

        if (places.length) {
          await this.prisma.threatPlace.deleteMany({ where: { messageId: item.dbId } });
          await this.prisma.threatPlace.createMany({
            data: places.map((p) => ({
              messageId: item.dbId,
              name: p.name,
              lat: p.lat,
              lon: p.lon,
              oblastCode: p.code,
              matchType: p.matchType,
            })),
          });
        }

        if (!analysis.notify) continue;
        if (analysis.threatType === 'all_clear' && !isAllClearPost(item.text)) {
          this.logger.log(`msg ${item.dbId} all_clear without відбій/отбой, skip`);
          continue;
        }
        if (resolved.foreign.length && places.length === 0) {
          this.logger.log(`msg ${item.dbId} other city [${resolved.foreign.join(', ')}], skip`);
          continue;
        }
        if (places.length === 0) {
          const guesses = (analysis.places.length ? analysis.places : resolved.unknown).filter(
            (name) => isPlausiblePlaceLabel(name) && !isThreatLabel(name),
          );
          if (!guesses.length && isCityWideKharkivCue(item.text)) {
            const cityWide = await this.geo.resolveAndLearn(['Харків']);
            if (cityWide.length) {
              places.push(...cityWide);
            }
          }
          if (places.length === 0) {
            this.logger.warn(`msg ${item.dbId} threat without resolved places, skip alert`);
            if (guesses.length) {
              void this.telegram.askUnknownToponym({
                channel: item.channel,
                text: item.text,
                guesses,
              });
            } else {
              this.logger.log(`msg ${item.dbId} no plausible place guesses, skip unknown-toponym ask`);
            }
            continue;
          }
        }

        const eventKey = canonicalEventKey({
          threatType: analysis.threatType,
          places,
          trackLost: analysis.trackLost,
        });
        if ([...deliveredEvents].some((prev) => eventKeysOverlap(prev, eventKey))) {
          this.logger.log(`skip duplicate event_key=${eventKey} (same threat already in this batch)`);
          continue;
        }

        if (!item.alert || Date.now() - item.date.getTime() > ALERT_MAX_AGE_MS) {
          this.logger.log(`msg ${item.dbId} learned only (old or backlog), no push`);
          continue;
        }

        const alreadySent = await this.prisma.alertDelivery.findFirst({
          where: {
            eventKey,
            sentAt: { gte: new Date(Date.now() - ALERT_DEDUP_MS) },
          },
          select: { id: true },
        });
        if (alreadySent) {
          this.logger.log(`skip event_key=${eventKey} already delivered recently`);
          continue;
        }

        deliveredEvents.add(eventKey);

        await this.alerts.dispatch({
          messageId: item.dbId,
          channel: item.channel,
          text: item.text,
          summary: analysis.summaryUk,
          eventKey,
          threatType: analysis.threatType,
          trackLost: analysis.trackLost,
          places,
        });
      }
    } catch (err) {
      this.logger.error(`flush failed, requeue: ${err instanceof Error ? err.message : err}`);
      this.buffer.unshift(...batch);
      this.metrics.bufferSize = this.buffer.length;
    } finally {
      for (const item of batch) this.inFlight.delete(item.dbId);
      this.flushing = false;
      if (this.buffer.length >= this.batchSize) void this.flush();
      else if (this.buffer.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, this.waitMs);
      }
    }
  }

  private persistAnalysis(
    messageId: number,
    analysis: {
      isThreat: boolean;
      severity: string | null;
      threatType: string | null;
      summaryUk: string | null;
      eventKey: string | null;
    },
    eventKey: string | null,
  ) {
    return this.prisma.messageAnalysis.upsert({
      where: { messageId },
      create: {
        messageId,
        isThreat: analysis.isThreat,
        severity: analysis.severity,
        threatType: analysis.threatType,
        summary: analysis.summaryUk,
        eventKey,
        rawJson: JSON.stringify(analysis),
        model: 'qwen2.5-3b-m2:latest',
      },
      update: {
        isThreat: analysis.isThreat,
        severity: analysis.severity,
        threatType: analysis.threatType,
        summary: analysis.summaryUk,
        eventKey,
        rawJson: JSON.stringify(analysis),
      },
    });
  }

  private async loadChains(batch: BufferedMessage[]): Promise<Map<number, ReturnType<typeof resolveChainFromKnown>>> {
    const byId = new Map<number, ChainMessage>();
    for (const item of batch) {
      byId.set(item.telegramId, {
        telegramId: item.telegramId,
        text: item.text,
        replyToTelegramId: item.replyToTelegramId,
        date: item.date,
      });
    }

    const channelIds = [...new Set(batch.map((item) => item.channelId))];
    let pending = batch
      .map((item) => item.replyToTelegramId)
      .filter((id): id is number => id != null && !byId.has(id));
    for (let hop = 0; hop < 8 && pending.length; hop++) {
      const rows = await this.prisma.message.findMany({
        where: {
          channelId: { in: channelIds },
          telegramId: { in: pending.map((id) => BigInt(id)) },
        },
        select: { telegramId: true, message: true, replyToTelegramId: true, date: true },
      });
      pending = [];
      for (const row of rows) {
        const id = Number(row.telegramId);
        const replyTo = row.replyToTelegramId != null ? Number(row.replyToTelegramId) : null;
        if (!byId.has(id)) {
          byId.set(id, {
            telegramId: id,
            text: row.message,
            replyToTelegramId: replyTo,
            date: row.date,
          });
        }
        if (replyTo && !byId.has(replyTo)) pending.push(replyTo);
      }
    }

    const chains = new Map<number, ReturnType<typeof resolveChainFromKnown>>();
    for (const item of batch) {
      let recentBefore: ChainMessage[] = [];
      if (!item.replyToTelegramId && isContinuation(item.text)) {
        const rows = await this.prisma.message.findMany({
          where: {
            channelId: item.channelId,
            date: { gte: new Date(item.date.getTime() - 10 * 60 * 1000), lt: item.date },
          },
          orderBy: { date: 'asc' },
          take: 6,
          select: { telegramId: true, message: true, replyToTelegramId: true, date: true },
        });
        recentBefore = rows.map((row) => ({
          telegramId: Number(row.telegramId),
          text: row.message,
          replyToTelegramId: row.replyToTelegramId != null ? Number(row.replyToTelegramId) : null,
          date: row.date,
        }));
      }
      const chain = resolveChainFromKnown(
        {
          telegramId: item.telegramId,
          text: item.text,
          replyToTelegramId: item.replyToTelegramId,
          date: item.date,
        },
        byId,
        recentBefore,
      );
      if (chain.context.length) {
        this.logger.log(
          `chain msg ${item.dbId} root=${chain.rootTelegramId} hops=${chain.context.length} lost=${chain.trackLost}`,
        );
      }
      chains.set(item.dbId, chain);
    }
    return chains;
  }
}
