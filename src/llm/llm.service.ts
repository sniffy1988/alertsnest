import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';
import { MetricsService } from '../metrics/metrics.service';
import { previewMessage } from '../common/text';
import { isVagueOblastName } from '../geo/place-match';
import type { PlaceKind } from '../geo/ua-gazetteer';
import { enrichThreatType, isThreatLabel, type ThreatKind } from './threat-slang';

export type LlmInputItem = {
  id: string;
  channel: string;
  text: string;
  context?: string[];
};

export type LlmWeapon = ThreatKind;

export type LlmEvent = {
  weapon: LlmWeapon;
  weaponRaw: string | null;
  name: string;
  kind: PlaceKind;
};

export type LlmResultItem = {
  id: string;
  isThreat: boolean;
  events: LlmEvent[];
  threatType: string | null;
  summaryUk: string | null;
  notify: boolean;
  trackLost: boolean;
};

const WEAPON_ENUM = [
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
  'none',
  'other',
] as const satisfies readonly LlmWeapon[];

const PLACE_KINDS = new Set<PlaceKind>(['street', 'district', 'city', 'settlement', 'region']);

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
          events: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                weapon: { type: 'string', enum: [...WEAPON_ENUM] },
                weapon_raw: { type: 'string' },
                name: { type: 'string' },
                kind: {
                  type: 'string',
                  enum: ['street', 'district', 'city', 'settlement', 'region'],
                },
              },
              required: ['weapon', 'weapon_raw', 'name', 'kind'],
            },
          },
          summary_uk: { type: 'string' },
        },
        required: ['id', 'is_threat', 'events'],
      },
    },
  },
  required: ['items'],
};

const SYSTEM_PROMPT = `Ти аналітик повітряних загроз Харкова і Харківської області. Канали пишуть сленгом.
Поверни для кожного поста: is_threat, events[], summary_uk.
events — масив пар «зброя + місце». Одна зброя + одне місце = один елемент. Два населені пункти → два елементи (навіть з одним weapon).
Новини / реклама / донати → is_threat=false, events=[].

weapon (enum):
- shahed: шахед, шаболда, мопед, герань, geran, бандероль
- ballistic: балістика, іскандер, орешник / орешника
- cruise: крилата, калибр, іскандер-к, онікс
- kinzhal: кинжал / кинджал
- kh59: х-59, -59
- kab: каб, фаб, умпк
- mlrs: рсзо, град, смерч, вільха
- jet_uav: реактивний БПЛА, швидкісна, Р. Шахед, Р. Шаболда
- strike_uav: ударний БПЛА
- missile: ракета (якщо тип неясний)
- recon: дорозвідка, розвідник
- aircraft: 31к, міг-31, ту-95, стратегічна
- explosion: приліт, вибух, упав
- air_raid: повітря / воздух / тривога без типу зброї
- sam: наша бойова, ппо
- all_clear: ТІЛЬКИ явні «відбій», «отбой», «укриття знято», «все чисто»
- none: не використовуй у events (новини → events=[])
- other: лише якщо тип зовсім неясний

weapon_raw: фрагмент з тексту як є («Орешник», «Шаболда», «Р. Шахед», «мопед», «балістика»). Не перекладати. all_clear → «відбій»/«отбой» з тексту.

name / kind: топонім з ПОТОЧНОГО тексту (для «не наблюдается» — з останнього пункту context). Не писати зброю в name.
kind:
- street — вулиця
- district — район міста
- city — Харків / «по всьому місту»
- settlement — смт, село, передмістя
- region — район області / «північ області»
Немає топоніма, але загроза по місту → name="Харків", kind=city.
Не вирішуй «наше/чуже» — координати рахуємо ми. Топонім як у тексті.
СС = Північна Салтівка, БД = Велика Данилівка. «Ст Салтов» = Старий Салтів (settlement), НЕ Салтівка.
Краснопавлівка ≠ Павлівка. Сахновщина, Лозова, Зачепилівка — settlement області.
context — попередні пости гілки. Тип зброї з початку ланцюжка; name — куди далі з поточного тексту.
Приклади:
«Р. Шаболда на Сахновщину» → events=[{weapon:jet_uav, weapon_raw:"Р. Шаболда", name:"Сахновщина", kind:settlement}]
«Угроза Орешника» → events=[{weapon:ballistic, weapon_raw:"Орешника", name:"Харків", kind:city}]
«Загроза балістики‼️» → events=[{weapon:ballistic, weapon_raw:"балістики", name:"Харків", kind:city}]
«На Салтівку» у реплаї до шахеда → events=[{weapon:shahed, weapon_raw з context, name:"Салтівка", kind:district}]
«Шаболда на Салтівку і Олексіївку» → два елементи з одним weapon=shahed
«Далі на Полтаву» → name="Полтава", не підміняй на Харків
Ігноруй «Підпишись», донати, підлітний час без нового місця.`;

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
        const ev = item.events
          .map((e) => `${e.weapon}/${e.weaponRaw ?? '-'}→${e.name}/${e.kind}`)
          .join('; ');
        this.logger.log(
          `LLM ← [${item.id}] threat=${item.isThreat} type=${item.threatType ?? '-'} ` +
            `events=[${ev}] summary=${item.summaryUk ?? '-'}`,
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
      const byId = new Map<string, { isThreat: boolean; events: LlmEvent[]; summaryUk: string | null }>();
      for (const raw of json.items) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const id = String(row.id ?? '');
        if (!id) continue;
        byId.set(id, {
          isThreat: Boolean(row.is_threat),
          events: this.cleanEvents(row.events),
          summaryUk: typeof row.summary_uk === 'string' ? row.summary_uk : null,
        });
      }
      return input.map((item) => {
        const base = byId.get(item.id) ?? {
          isThreat: false,
          events: [] as LlmEvent[],
          summaryUk: null,
        };
        const source = item.text ?? '';
        const primaryWeapon = base.events[0]?.weapon ?? null;
        const enriched = enrichThreatType(source, primaryWeapon, base.isThreat, item.context);
        if (enriched.fromSlang) {
          this.logger.log(`slang [${item.id}] ${primaryWeapon ?? '∅'} → ${enriched.threatType}`);
        }

        const events = base.events.map((ev) => {
          const weak = !ev.weapon || ev.weapon === 'other' || ev.weapon === 'none' || ev.weapon === 'all_clear';
          const weapon = (weak ? enriched.threatType : ev.weapon) as LlmWeapon;
          return { ...ev, weapon };
        });

        if (primaryWeapon === 'all_clear' && enriched.threatType !== 'all_clear') {
          this.logger.log(`drop fake all_clear [${item.id}] → ${enriched.threatType} notify=${enriched.notify}`);
        }

        const firstNotify = events.find((e) => e.weapon !== 'none') ?? events[0];
        return {
          id: item.id,
          isThreat: enriched.isThreat,
          events,
          threatType: firstNotify?.weapon ?? enriched.threatType,
          summaryUk: base.summaryUk,
          notify: enriched.notify,
          trackLost: enriched.trackLost,
        };
      });
    } catch (err) {
      this.logger.warn(`JSON parse failed: ${err instanceof Error ? err.message : err} raw=${content.slice(0, 180)}`);
      return null;
    }
  }

  private cleanEvents(raw: unknown): LlmEvent[] {
    if (!Array.isArray(raw)) return [];
    const out: LlmEvent[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (
        name.length < 2 ||
        name.length > 64 ||
        !/[а-яa-z]/i.test(name) ||
        isVagueOblastName(name) ||
        isThreatLabel(name)
      ) {
        continue;
      }
      const kindRaw = typeof row.kind === 'string' ? row.kind : 'settlement';
      const kind: PlaceKind = PLACE_KINDS.has(kindRaw as PlaceKind)
        ? (kindRaw as PlaceKind)
        : 'settlement';
      const weaponRaw =
        typeof row.weapon === 'string' && (WEAPON_ENUM as readonly string[]).includes(row.weapon)
          ? (row.weapon as LlmWeapon)
          : 'other';
      const weaponLabel =
        typeof row.weapon_raw === 'string'
          ? row.weapon_raw.trim().slice(0, 64) || null
          : null;
      out.push({
        weapon: weaponRaw,
        weaponRaw: weaponLabel,
        name,
        kind,
      });
    }
    return out;
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
