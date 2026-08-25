import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Ollama } from 'ollama';
import { MetricsService } from '../metrics/metrics.service';
import { previewMessage } from '../common/text';
import { isVagueOblastName, normalizeLlmPlace, splitCompoundPlaceNames } from '../geo/place-match';
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
Відповідь СТРОГО один JSON-об'єкт (без markdown, без **жирного**, без тексту навколо):
{"items":[{"id":"<id з входу>","is_threat":true|false,"events":[{"weapon":"...","weapon_raw":"...","name":"...","kind":"..."}],"summary_uk":"..."}]}
Для КОЖНОГО поста з входу — окремий елемент items з тим самим id.
events — масив пар «зброя + місце». Одна зброя + одне місце = один елемент. Два населені пункти → два елементи (навіть з одним weapon).
Новини / реклама / донати → is_threat=false, events=[].

weapon (enum):
- shahed: шахед, шаболда, мопед, герань, geran, бандероль
- ballistic: балістика, іскандер, орешник / орешника
- cruise: крилата, калибр, іскандер-к, онікс
- kinzhal: кинжал / кинджал
- kh59: х-59, -59
- kab: каб, фаб, умпк, БНР (авіація над Бєлгородщиною → можливі пуски КАБ)
- mlrs: рсзо, град, смерч, вільха
- jet_uav: реактивний БПЛА, швидкісна, Р. Шахед, Р. Шаболда
- strike_uav: ударний БПЛА
- missile: ракета (якщо тип неясний)
- recon: дорозвідка, розвідник
- aircraft: 31к, міг-31, ту-95, стратегічна (без БНР — БНР це kab)
- explosion: приліт, вибух, упав
- air_raid: повітря / воздух / тривога без типу зброї
- sam: наша бойова, ппо
- all_clear: ТІЛЬКИ явні «відбій», «отбой», «укриття знято», «все чисто»
- none: не використовуй у events (новини → events=[])
- other: лише якщо тип зовсім неясний

weapon_raw: фрагмент з тексту як є («Орешник», «Шаболда», «Р. Шахед», «мопед», «балістика»). Не перекладати. all_clear → «відбій»/«отбой» з тексту.

name / kind: ОДИН топонім з ПОТОЧНОГО тексту (для «не наблюдается» — з останнього пункту context). Не писати зброю в name.
ЗАБОРОНЕНО в name: «Харків та передмістя», «місто і пригород» — пиши лише «Харків», kind=city.
kind:
- street — вулиця міста
- district — район МІСТА (Салтівка, Олексіївка)
- city — Харків / «по всьому місту» / «Харків та передмістя»
- settlement — смт, село, конкретне передмістя (Пісочин, Дергачі)
- region — адмінрайон області («Чугуївський район») / «північ області»
Немає топоніма, але загроза по місту → name="Харків", kind=city.
Не вирішуй «наше/чуже» — координати рахуємо ми. Топонім як у тексті (без «та передмістя»).
name можна опустити або написати приблизно — бекенд сам читає місця з тексту словником; важливіший weapon.
СС = Північна Салтівка, БД = Велика Данилівка. Козачка / Казачья Лопань / Кащачья Лопань = Козача Лопань (settlement). «Ст Салтов» = Старий Салтів (settlement), НЕ Салтівка.
Краснопавлівка ≠ Павлівка. Сахновщина, Лозова, Зачепилівка — settlement області.
context — попередні пости гілки. Тип зброї (weapon / weapon_raw) з початку ланцюжка; name — куди далі з ПОТОЧНОГО тексту.
«Далі / Далее / Дальше / курс на X» при context з КАБ/шахедом — це ПРОДОВЖЕННЯ загрози: is_threat=true, events з місцями з поточного тексту, weapon з context. НЕ events=[].
НЕ став is_threat=false через «Підпишись» у футері — ігноруй підписку.
Приклади:
«Р. Шаболда на Сахновщину» → events=[{weapon:jet_uav, weapon_raw:"Р. Шаболда", name:"Сахновщина", kind:settlement}]
«Угроза Орешника» → events=[{weapon:ballistic, weapon_raw:"Орешника", name:"Харків", kind:city}]
«Загроза балістики‼️» → events=[{weapon:ballistic, weapon_raw:"балістики", name:"Харків", kind:city}]
«Харків та передмістя - повітряна тривога!» → events=[{weapon:air_raid, weapon_raw:"повітряна тривога", name:"Харків", kind:city}]
«Чугуївський район - повітряна тривога!» → events=[{weapon:air_raid, weapon_raw:"повітряна тривога", name:"Чугуївський район", kind:region}]
«БНР» / «БНР!» → events=[{weapon:kab, weapon_raw:"БНР", name:"Харків", kind:city}]
«На Салтівку» у реплаї до шахеда → events=[{weapon:shahed, weapon_raw з context, name:"Салтівка", kind:district}]
«Шаболда на Салтівку і Олексіївку» → два елементи з одним weapon=shahed
«КАБ перетинає кордон в напрямку Козача Лопань/Цупівка/Прудянка» → три елементи kab на кожне село
«Далее на Прудянку» context=[…КАБ…] → events=[{weapon:kab, weapon_raw:"КАБ", name:"Прудянка", kind:settlement}]
«Дальше курс на Прудянку/Слатино» context=[…КАБ…] → два settlement: Прудянка і Слатино
«На даний час без повторних пусків КАБ» → is_threat=false, events=[] (не нова загроза)
«Берестинський район - тривога знято» → is_threat=false, weapon=all_clear, name="Берестинський район", kind=region
«Богодухівський район - відбій» → weapon=all_clear, name="Богодухівський район", kind=region (НЕ весь Харків)
«Далі на Полтаву» → name="Полтава", не підміняй на Харків
«Не фиксируется» / «Більше не фіксується» при context з місцями → is_threat=true, track через events з місць context, weapon з context
Ігноруй «Підпишись», донати, підлітний час без нового місця.
Ще раз: тільки JSON {"items":[...]}, без markdown.`;

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
    this.model = config.get<string>('OLLAMA_MODEL') || 'qwen3.5:2b-mlx';
    const keep = config.get<string>('OLLAMA_KEEP_ALIVE') ?? '-1';
    this.keepAlive = keep === '-1' ? -1 : keep;
  }

  get modelName(): string {
    return this.model;
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
      // Qwen 3.5 defaults to chain-of-thought; that eats num_predict and breaks JSON.
      think: false,
      keep_alive: this.keepAlive,
      format: RESPONSE_SCHEMA,
      options: {
        temperature: 0,
        num_ctx: 2048,
        num_predict: 1024,
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Поверни ТІЛЬКИ JSON {"items":[...]} для цих постів (id збережи):\n${JSON.stringify(payload)}`,
        },
      ],
    });

    const raw = stripThinking(response.message.content ?? '');
    this.logger.log(`LLM ← raw (${raw.length} chars): ${raw}`);
    return this.parse(raw, payload);
  }

  private parse(content: string, input: LlmInputItem[]): LlmResultItem[] | null {
    const normalized = coerceLlmJson(content, input);
    if (!normalized) {
      this.logger.warn(`JSON parse failed: could not coerce raw=${content.slice(0, 180)}`);
      return null;
    }
    try {
      const byId = new Map<string, { isThreat: boolean; events: LlmEvent[]; summaryUk: string | null }>();
      for (const raw of normalized.items) {
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

        const cleared =
          enriched.threatType === 'all_clear'
            ? events.map((ev) => ({ ...ev, weapon: 'all_clear' as LlmWeapon }))
            : events;
        const firstNotify = cleared.find((e) => e.weapon !== 'none') ?? cleared[0];
        return {
          id: item.id,
          isThreat: enriched.isThreat,
          events: cleared,
          threatType: enriched.threatType === 'all_clear' ? 'all_clear' : (firstNotify?.weapon ?? enriched.threatType),
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
      const rawName = typeof row.name === 'string' ? row.name.trim() : '';
      if (rawName.length < 2 || rawName.length > 64 || !/[а-яa-z]/i.test(rawName)) continue;
      const kindRaw = typeof row.kind === 'string' ? row.kind : 'settlement';
      const kindIn: PlaceKind = PLACE_KINDS.has(kindRaw as PlaceKind)
        ? (kindRaw as PlaceKind)
        : 'settlement';
      const weapon =
        typeof row.weapon === 'string' && (WEAPON_ENUM as readonly string[]).includes(row.weapon)
          ? (row.weapon as LlmWeapon)
          : 'other';
      const weaponLabel =
        typeof row.weapon_raw === 'string'
          ? row.weapon_raw.trim().slice(0, 64) || null
          : null;
      for (const part of splitCompoundPlaceNames(rawName)) {
        if (isVagueOblastName(part) || isThreatLabel(part)) continue;
        const { name, kind } = normalizeLlmPlace(part, kindIn);
        if (isVagueOblastName(name) || isThreatLabel(name)) continue;
        out.push({
          weapon,
          weaponRaw: weaponLabel,
          name,
          kind,
        });
      }
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

/** Drop leaked thinking tags if an old Ollama ignores think:false. */
function stripThinking(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

/**
 * Tiny models (qwen3.5:2b-mlx) often ignore JSON schema and return markdown like:
 * **is_threat:** true
 * **events:** [ {...}, ... ]
 * **summary_uk:** ...
 */
function coerceLlmJson(
  content: string,
  input: LlmInputItem[],
): { items: Array<Record<string, unknown>> } | null {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    ...extractJsonCandidates(trimmed),
    markdownFieldsToJson(trimmed),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (Array.isArray(parsed.items)) {
        return { items: parsed.items as Array<Record<string, unknown>> };
      }
      // Flat single-result object without items / id — fan out to every input id.
      if ('is_threat' in parsed || 'events' in parsed) {
        return {
          items: input.map((item) => ({
            id: item.id,
            is_threat: parsed.is_threat ?? false,
            events: parsed.events ?? [],
            summary_uk: parsed.summary_uk ?? null,
          })),
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out.push(fence[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) out.push(text.slice(start, end + 1));
  return out;
}

/** Convert **key:** value markdown blobs into a JSON object string. */
function markdownFieldsToJson(text: string): string | null {
  // Models emit either **key:** or **key**:
  const field = (name: string) =>
    new RegExp(`\\*\\*${name}:?\\*\\*:?\\s*`, 'i');

  if (!field('is_threat').test(text) && !field('events').test(text)) return null;

  const isThreat = new RegExp(`${field('is_threat').source}(true|false)`, 'i').exec(text)?.[1]?.toLowerCase();
  const eventsRe = new RegExp(`${field('events').source}(\\[[\\s\\S]*?\\])\\s*(?:\\*\\*|$)`, 'i');
  const eventsMatch = eventsRe.exec(text);
  const summaryRe = new RegExp(`${field('summary_uk').source}([\\s\\S]*?)(?:\\n\\*\\*|$)`, 'i');
  const summaryMatch = summaryRe.exec(text);

  if (!isThreat && !eventsMatch) return null;

  let eventsRaw = eventsMatch?.[1]?.trim() ?? '[]';
  eventsRaw = eventsRaw.replace(/,\s*]/g, ']').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const summary = (summaryMatch?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  try {
    JSON.parse(eventsRaw);
  } catch {
    return null;
  }

  return JSON.stringify({
    is_threat: isThreat === 'true',
    events: JSON.parse(eventsRaw),
    summary_uk: summary,
  });
}
