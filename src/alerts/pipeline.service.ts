import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, type LlmEvent, type LlmResultItem } from '../llm/llm.service';
import { GeoService, type ResolvedPlace } from '../geo/geo.service';
import { AlertsService } from './alerts.service';
import { TelegramService } from '../telegram/telegram.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  isAllClearPost,
  isContinuation,
  isEtaOnly,
  isNoisePost,
  isNoMoreLaunches,
  leftOblast,
  resolveChainFromKnown,
  type ChainMessage,
} from './message-chain';
import { ALERT_DEDUP_MS, canonicalEventKey, eventKeysOverlap } from './event-key';
import { isPlausiblePlaceLabel } from '../geo/place-match';
import { isThreatLabel } from '../llm/threat-slang';
import type { PlaceKind } from '../geo/ua-gazetteer';

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

  enqueue(items: BufferedMessage[]): number {
    const queued = new Set(this.buffer.map((item) => item.dbId));
    const fresh = items.filter((item) => {
      if (queued.has(item.dbId) || this.inFlight.has(item.dbId)) return false;
      queued.add(item.dbId);
      return true;
    });
    if (!fresh.length) return 0;
    this.buffer.push(...fresh);
    this.metrics.bufferSize = this.buffer.length;
    this.logger.debug(`enqueue +${fresh.length} buffer=${this.buffer.length}`);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return fresh.length;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.waitMs);
    }
    return fresh.length;
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
        this.logger.warn('empty LLM result, requeue batch');
        this.buffer.unshift(...batch);
        this.metrics.bufferSize = this.buffer.length;
        return;
      }

      const deliveredEvents = new Set<string>();

      for (const item of batch) {
        const analysis = results.find((r) => r.id === String(item.dbId));
        if (!analysis) continue;

        const chain = chains.get(item.dbId);
        if (isNoisePost(item.text)) {
          await this.persistAnalysis(item.dbId, analysis, null);
          this.logger.debug(`msg ${item.dbId} noise/donate, skip`);
          continue;
        }
        if (isNoMoreLaunches(item.text)) {
          await this.persistAnalysis(item.dbId, analysis, null);
          this.logger.log(`msg ${item.dbId} no more launches, skip`);
          continue;
        }
        if (isEtaOnly(item.text)) {
          this.logger.log(`msg ${item.dbId} ETA only, no push`);
        }
        if (leftOblast(item.text)) {
          this.logger.log(`msg ${item.dbId} left-oblast cue — classify by coordinates`);
        }

        const placeText =
          analysis.trackLost && chain?.context.length
            ? `${chain.context[chain.context.length - 1]}\n${item.text}`
            : item.text;

        // Always scan the gazetteer — primary place source (LLM names are merged on top).
        const scanned = this.geo.findPlacesInText(placeText);
        const events = this.eventsForGeo(analysis, placeText, scanned);
        const storedPlaces: Array<{
          place: ResolvedPlace;
          weapon: string;
          weaponRaw: string | null;
        }> = [];
        let firstKey: string | null = null;

        for (const event of events) {
          const resolved = await this.geo.resolveThreatPlaces({
            text: placeText,
            locations: [{ name: event.name, kind: event.kind }],
            skipLearn: scanned.length > 0,
          });
          // Union: keep scan hits even when LLM grounding/lookup fails.
          let places = this.geo.mergePlaces(scanned, resolved.places);

          if (event.weapon === 'all_clear' && places.length === 0) {
            const city = this.geo.findPlace('Харків', 'city');
            if (city) {
              places = [
                {
                  name: city.name,
                  lat: city.lat,
                  lon: city.lon,
                  code: city.norm,
                  matchType: city.kind,
                },
              ];
            }
          }

          this.logger.log(
            `msg ${item.dbId} @${item.channel} event weapon=${event.weapon} raw=${event.weaponRaw ?? '-'} ` +
              `loc=${event.name}/${event.kind} ` +
              `scan=[${scanned.map((p) => `${p.name}/${p.matchType}`).join(', ')}] ` +
              `llm=[${resolved.places.map((p) => `${p.name}/${p.matchType}`).join(', ')}] ` +
              `resolved=[${places.map((p) => `${p.name}/${p.matchType}`).join(', ')}] ` +
              `foreign=[${resolved.foreign.join(', ')}] unknown=[${resolved.unknown.join(', ')}] ` +
              `lost=${analysis.trackLost} chain=${chain?.context.length ?? 0}`,
          );

          if (!places.length) {
            if (resolved.foreign.length) {
              this.logger.log(`msg ${item.dbId} other city [${resolved.foreign.join(', ')}], skip pair`);
              continue;
            }
            const guesses = [event.name, ...resolved.unknown].filter(
              (name) => isPlausiblePlaceLabel(name) && !isThreatLabel(name),
            );
            this.logger.warn(`msg ${item.dbId} pair without resolved place, skip`);
            if (guesses.length && analysis.notify) {
              void this.telegram.askUnknownToponym({
                channel: item.channel,
                text: item.text,
                guesses,
              });
            }
            continue;
          }

          for (const place of places) {
            storedPlaces.push({
              place,
              weapon: event.weapon,
              weaponRaw: event.weaponRaw,
            });
          }

          const eventKey = canonicalEventKey({
            threatType: event.weapon,
            places,
            trackLost: analysis.trackLost,
          });
          if (!firstKey) firstKey = eventKey;

          if (!analysis.notify) continue;
          if (!analysis.isThreat && event.weapon !== 'all_clear') {
            this.logger.log(`msg ${item.dbId} not a threat (weapon=${event.weapon}), skip pair`);
            continue;
          }
          if (event.weapon === 'all_clear' && !isAllClearPost(item.text)) {
            this.logger.log(`msg ${item.dbId} all_clear without відбій/отбой, skip pair`);
            continue;
          }
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
            threatType: event.weapon,
            weaponRaw: event.weaponRaw,
            trackLost: analysis.trackLost,
            places,
          });
        }

        await this.persistAnalysis(item.dbId, analysis, firstKey);

        if (storedPlaces.length) {
          await this.prisma.threatPlace.deleteMany({ where: { messageId: item.dbId } });
          await this.prisma.threatPlace.createMany({
            data: storedPlaces.map(({ place, weapon, weaponRaw }) => ({
              messageId: item.dbId,
              name: place.name,
              lat: place.lat,
              lon: place.lon,
              oblastCode: place.code,
              matchType: place.matchType,
              weapon,
              weaponRaw,
            })),
          });
        }
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

  private eventsForGeo(
    analysis: LlmResultItem,
    placeText: string,
    scanned: ResolvedPlace[],
  ): LlmEvent[] {
    if (analysis.events.length) return analysis.events;
    if (analysis.threatType === 'all_clear') {
      const hits = scanned.filter((h) => h.matchType !== 'street');
      if (hits.length) {
        return hits.map((h) => ({
          weapon: 'all_clear' as const,
          weaponRaw: null,
          name: h.name,
          kind: h.matchType,
        }));
      }
      return [
        {
          weapon: 'all_clear',
          weaponRaw: null,
          name: 'Харків',
          kind: 'city' as PlaceKind,
        },
      ];
    }
    // Trajectory update / empty LLM places — recover toponyms from gazetteer scan.
    if (
      analysis.notify &&
      analysis.threatType &&
      analysis.threatType !== 'none' &&
      analysis.threatType !== 'other'
    ) {
      if (scanned.length) {
        this.logger.log(
          `events fallback from text: type=${analysis.threatType} places=[${scanned.map((h) => h.name).join(', ')}]`,
        );
        return scanned.map((h) => ({
          weapon: analysis.threatType as LlmEvent['weapon'],
          weaponRaw: null,
          name: h.name,
          kind: h.matchType,
        }));
      }
      // Still scan again if caller passed empty (defensive).
      const hits = this.geo.findPlacesInText(placeText);
      if (hits.length) {
        return hits.map((h) => ({
          weapon: analysis.threatType as LlmEvent['weapon'],
          weaponRaw: null,
          name: h.name,
          kind: h.matchType,
        }));
      }
    }
    return [];
  }

  private persistAnalysis(
    messageId: number,
    analysis: LlmResultItem,
    eventKey: string | null,
  ) {
    return this.prisma.messageAnalysis.upsert({
      where: { messageId },
      create: {
        messageId,
        isThreat: analysis.isThreat,
        severity: null,
        threatType: analysis.threatType,
        summary: analysis.summaryUk,
        eventKey,
        rawJson: JSON.stringify(analysis),
        model: this.llm.modelName,
      },
      update: {
        isThreat: analysis.isThreat,
        severity: null,
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
