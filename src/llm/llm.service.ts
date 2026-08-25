import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';
import { MetricsService } from '../metrics/metrics.service';
import { previewMessage } from '../common/text';
import { enrichThreatType } from './threat-slang';

export type LlmInputItem = {
  id: string;
  channel: string;
  text: string;
  context?: string[];
};

export type LlmResultItem = {
  id: string;
  isThreat: boolean;
  severity: string | null;
  threatType: string | null;
  places: string[];
  oblast: string | null;
  geoScope: string | null;
  eventKey: string | null;
  summaryUk: string | null;
  notify: boolean;
  trackLost: boolean;
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          is_threat: { type: 'boolean' },
          severity: { type: 'string' },
          threat_type: {
            type: 'string',
            enum: [
              'shahed',
              'ballistic',
              'cruise',
              'kinzhal',
              'kh59',
              'kab',
              'missile',
              'recon',
              'aircraft',
              'explosion',
              'air_raid',
              'sam',
              'mlrs',
              'jet_uav',
              'strike_uav',
              'all_clear',
              'other',
            ],
          },
          places: { type: 'array', items: { type: 'string' } },
          oblast: { type: 'string' },
          geo_scope: {
            type: 'string',
            enum: ['street', 'district', 'city', 'suburb', 'oblast'],
          },
          event_key: { type: 'string' },
          summary_uk: { type: 'string' },
        },
        required: ['id', 'is_threat', 'places'],
      },
    },
  },
  required: ['items'],
};

const SYSTEM_PROMPT = `Ти аналітик повітряних загроз Харкова і Харківської області. Канали пишуть сленгом.
threat_type:
- shahed: шахед, мопед, герань, geran
- ballistic: балістика, іскандер
- cruise: крилата, калибр, іскандер-к, онікс
- kinzhal: кинжал / кинджал
- kh59: х-59, -59
- kab: каб, фаб, умпк
- mlrs: рсзо, град, смерч, вільха
- jet_uav: реактивний БПЛА, швидкісна, Р. Шахед
- strike_uav: ударний БПЛА
- missile: ракета (якщо тип неясний)
- recon: дорозвідка, розвідник
- aircraft: 31к, міг-31, ту-95, стратегічна
- explosion: приліт, вибух, упав
- air_raid: повітря / воздух / загроза без типу
- sam: наша бойова, ппо
- all_clear: відбій, отбой, чисто — is_threat=false
geo_scope:
- street / district — назва вулиці або району МІСТА є в тексті
- city — загроза по всьому Харкову, без конкретного району
- suburb — передмістя (Пісочин, Дергачі…)
- oblast — область, смт, села, «північ/схід області», «пригород»
places: лише топоніми, які РЕАЛЬНО є в тексті. Не вигадуй Наукову, Центр, Салтівку.
Краснопавлівка ≠ Павлівка. Кегичівка — область, не вулиця Харкова.
«північ області / пригород» → geo_scope=oblast, places=["північ області"].
context — попередні пости гілки (реплай). 1654/СХІD/TLK так ведуть траєкторію.
Тип загрози з початку ланцюжка. places — з ПОТОЧНОГО тексту (куди далі).
СС = Північна Салтівка, БД = Велика Данилівка. «Ст Салтов / Ст. Салтов / СТ Салтов» = Старий Салтів (область), НЕ Салтівка міста.
Бандероль = шахед. Швидкісна = реактивний БПЛА.
«На Савинці» у реплаї — продовження, не нова загроза без типу.
«Не наблюдается / більше не фіксується» — places з останнього пункту context.
«Вилетів з області / в Полтавську» — не місто, geo_scope=oblast.
Ігноруй «Підпишись на СХІD», донати, підлітний час без нового місця.
Ігноруй рекламу і заклики підписатися. event_key = тип:топонім.`;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: Ollama;
  private readonly model: string;
  private readonly keepAlive: string | number;
  private busy = false;
  private waiters: Array<() => void> = [];

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.client = new Ollama({ host: config.get<string>('OLLAMA_HOST') || 'http://127.0.0.1:11434' });
    this.model = config.get<string>('OLLAMA_MODEL') || 'qwen2.5-3b-m2:latest';
    const keep = config.get<string>('OLLAMA_KEEP_ALIVE') ?? '-1';
    this.keepAlive = keep === '-1' ? -1 : keep;
  }

  async analyzeBatch(items: LlmInputItem[]): Promise<LlmResultItem[]> {
    await this.lock();
    const started = Date.now();
    try {
      const payload = items.map((item) => ({
        id: item.id,
        channel: item.channel,
        text: previewMessage(item.text, 400),
        context: (item.context ?? []).map((line) => previewMessage(line, 220)),
      }));

      this.logger.log(`LLM → ${this.model} batch=${payload.length}`);
      for (const item of payload) {
        const chain = item.context.length ? ` | ctx=${item.context.join(' → ')}` : '';
        this.logger.log(`LLM → [${item.id} @${item.channel}] ${item.text}${chain}`);
      }
      let parsed = await this.callModel(payload);
      if (!parsed) {
        this.logger.warn('invalid JSON, retry once');
        parsed = await this.callModel(payload);
      }
      if (!parsed) {
        this.logger.warn('LLM returned invalid JSON twice, dropping batch');
        return [];
      }

      this.metrics.ollamaOk = true;
      this.metrics.lastBatchMs = Date.now() - started;
      const threats = parsed.filter((p) => p.isThreat).length;
      this.logger.log(`LLM ← done ${this.metrics.lastBatchMs}ms threats=${threats}/${parsed.length}`);
      for (const item of parsed) {
        this.logger.log(
          `LLM ← [${item.id}] threat=${item.isThreat} type=${item.threatType ?? '-'} ` +
            `places=${JSON.stringify(item.places)} oblast=${item.oblast ?? '-'} ` +
            `key=${item.eventKey ?? '-'} summary=${item.summaryUk ?? '-'}`,
        );
      }
      return parsed;
    } catch (err) {
      this.metrics.ollamaOk = false;
      this.logger.error(`Ollama failed: ${err instanceof Error ? err.message : err}`);
      throw err;
    } finally {
      this.unlock();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.list();
      this.metrics.ollamaOk = true;
      return true;
    } catch {
      this.metrics.ollamaOk = false;
      return false;
    }
  }

  private async callModel(payload: LlmInputItem[]): Promise<LlmResultItem[] | null> {
    const response = await this.client.chat({
      model: this.model,
      stream: false,
      keep_alive: this.keepAlive,
      format: RESPONSE_SCHEMA,
      options: {
        temperature: 0,
        num_ctx: 2048,
        num_predict: 512,
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });

    const raw = response.message.content ?? '';
    this.logger.log(`LLM ← raw (${raw.length} chars): ${raw}`);
    return this.parse(raw, payload);
  }

  private parse(content: string, input: LlmInputItem[]): LlmResultItem[] | null {
    try {
      const json = JSON.parse(content) as { items?: unknown };
      if (!Array.isArray(json.items)) return null;
      const byId = new Map<string, LlmResultItem>();
      for (const raw of json.items) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const id = String(row.id ?? '');
        if (!id) continue;
        byId.set(id, {
          id,
          isThreat: Boolean(row.is_threat),
          severity: typeof row.severity === 'string' ? row.severity : null,
          threatType: typeof row.threat_type === 'string' ? row.threat_type : null,
          places: Array.isArray(row.places) ? row.places.map(String) : [],
          oblast: typeof row.oblast === 'string' ? row.oblast : null,
          geoScope: typeof row.geo_scope === 'string' ? row.geo_scope : null,
          eventKey: typeof row.event_key === 'string' ? row.event_key : null,
          summaryUk: typeof row.summary_uk === 'string' ? row.summary_uk : null,
          notify: false,
          trackLost: false,
        });
      }
      return input.map((item) => {
        const base = byId.get(item.id) ?? {
          id: item.id,
          isThreat: false,
          severity: null,
          threatType: null,
          places: [] as string[],
          oblast: null,
          geoScope: null,
          eventKey: null,
          summaryUk: null,
          notify: false,
          trackLost: false,
        };
        const source = item.text ?? '';
        const enriched = enrichThreatType(source, base.threatType, base.isThreat, item.context);
        if (enriched.fromSlang) {
          this.logger.log(`slang [${item.id}] ${base.threatType ?? '∅'} → ${enriched.threatType}`);
        }
        return {
          ...base,
          isThreat: enriched.isThreat,
          threatType: enriched.threatType,
          notify: enriched.notify,
          trackLost: enriched.trackLost,
          eventKey: base.eventKey ?? `${enriched.threatType}:${base.places[0] ?? 'kharkiv'}`,
        };
      });
    } catch (err) {
      this.logger.warn(`JSON parse failed: ${err instanceof Error ? err.message : err} raw=${content.slice(0, 180)}`);
      return null;
    }
  }

  private async lock(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.busy = true;
  }

  private unlock(): void {
    this.busy = false;
    const next = this.waiters.shift();
    if (next) next();
  }
}
