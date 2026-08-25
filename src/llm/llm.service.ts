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

const SYSTEM_PROMPT = `Ти аналітик повітряних загроз Харкова і області. Сленг каналів.
Тільки JSON (без markdown): {"items":[{"id":"<id>","is_threat":true|false,"events":[{"weapon":"...","weapon_raw":"...","name":"...","kind":"..."}],"summary_uk":"..."}]}
Кожен вхідний пост → окремий item з тим самим id. events = пари зброя+місце (1 місце = 1 елемент; 2 села → 2 елементи). Новини/реклама/донати → is_threat=false, events=[].

weapon: shahed(шахед/шаболда/мопед/герань/бандероль/молнія/молния) | ballistic(балістика/іскандер/орешник) | cruise(крилата/калибр/іскандер-к/онікс) | kinzhal | kh59(-59) | kab(каб/фаб/умпк/БНР) | mlrs(рсзо/град/смерч/вільха) | jet_uav(реактивний БПЛА/швидкісна/Р. Шахед/Р. Шаболда) | strike_uav | missile(ракета неясна) | recon(дорозвідка) | aircraft(31к/міг-31/ту-95; БНР=kab) | explosion(приліт/вибух) | air_raid(повітря/тривога без типу) | sam(ппо) | all_clear(ТІЛЬКИ «відбій»/«отбой»/«укриття знято»/«все чисто») | other(неясний). none не в events.
weapon_raw: фрагмент зброї з тексту («Молнія», «мопед»). НЕ клади топонім у weapon_raw. all_clear → «відбій»/«отбой».

name/kind: ОБОВ'ЯЗКОВО топонім з ПОТОЧНОГО тексту («не наблюдается» → з останнього context). Не писати зброю в name.
ЗАБОРОНЕНО «Харків та передмістя»/«місто і пригород» → name="Харків", kind=city.
kind: street | district(Салтівка) | city(Харків/по місту) | settlement(село/передмістя) | region(адмінрайон/північ області). Немає топоніма по місту → Харків/city. Не вирішуй наше/чуже. name можна приблизно — важливіший weapon.
Аліаси: СС=Північна Салтівка, БД=Велика Данилівка, Козачка/Казачья Лопань=Козача Лопань(settlement), «Ст Салтов»=Старий Салтів(НЕ Салтівка). Краснопавлівка≠Павлівка.

context = попередні пости гілки: weapon з початку ланцюжка, name з поточного тексту.
«Далі/Далее/Дальше/курс на X» + context з КАБ/шахедом = продовження: is_threat=true, events з місць поточного, weapon з context (НЕ []).
«Не фиксируется»/«Більше не фіксується» + context → is_threat=true, events з місць context.
«без повторних пусків» → is_threat=false, events=[]. Відбій по району → all_clear + name району (НЕ весь Харків). Ігноруй «Підпишись»/донати/підлітний час без нового місця.

Приклади:
«Р. Шаболда на Сахновщину» → jet_uav/Сахновщина/settlement
«Молнія на Руську Лозову» / «Молния курсом на Русскую Лозовую» → shahed(weapon_raw=Молнія)/Руська Лозова/settlement
«Угроза Орешника» / «Загроза балістики» → ballistic/Харків/city
«Харків та передмістя - повітряна тривога» → air_raid/Харків/city
«Чугуївський район - тривога» → air_raid/Чугуївський район/region
«БНР!» → kab/Харків/city
«На Салтівку» reply до шахеда → shahed/Салтівка/district
«Шаболда на Салтівку і Олексіївку» → 2×shahed
«КАБ … Козача Лопань/Цупівка/Прудянка» → 3×kab
«Далее на Прудянку» / «Дальше курс на Прудянку/Слатино» + context КАБ → kab на ці села
«Богодухівський район - відбій» → all_clear/Богодухівський район/region
«Далі на Полтаву» → name=Полтава (не Харків)`;

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
    this.model = config.get<string>('OLLAMA_MODEL') || 'qwen3.5:0.8b-mlx';
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
        num_predict: 512,
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
      if (byId.size < input.length) {
        this.logger.warn(
          `LLM returned ${byId.size}/${input.length} items — slang/gazetteer will fill gaps`,
        );
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
      const weapon =
        typeof row.weapon === 'string' && (WEAPON_ENUM as readonly string[]).includes(row.weapon)
          ? (row.weapon as LlmWeapon)
          : 'other';
      const weaponLabel =
        typeof row.weapon_raw === 'string'
          ? row.weapon_raw.trim().slice(0, 64) || null
          : null;
      let rawName = typeof row.name === 'string' ? row.name.trim() : '';
      // Tiny models sometimes put the toponym in weapon_raw and omit name.
      if (
        (!rawName || rawName.length < 2) &&
        weaponLabel &&
        !isThreatLabel(weaponLabel) &&
        /[а-яa-z]/i.test(weaponLabel)
      ) {
        rawName = weaponLabel;
      }
      if (rawName.length < 2 || rawName.length > 64 || !/[а-яa-z]/i.test(rawName)) continue;
      if (isThreatLabel(rawName)) continue;
      const kindRaw = typeof row.kind === 'string' ? row.kind : 'settlement';
      const kindIn: PlaceKind = PLACE_KINDS.has(kindRaw as PlaceKind)
        ? (kindRaw as PlaceKind)
        : 'settlement';
      for (const part of splitCompoundPlaceNames(rawName)) {
        if (isVagueOblastName(part) || isThreatLabel(part)) continue;
        const { name, kind } = normalizeLlmPlace(part, kindIn);
        if (isVagueOblastName(name) || isThreatLabel(name)) continue;
        out.push({
          weapon,
          weaponRaw: weaponLabel && isThreatLabel(weaponLabel) ? weaponLabel : null,
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
 * Tiny models (qwen3.5:0.8b-mlx) often ignore JSON schema and return markdown like:
 * **is_threat:** true
 * **events:** [ {...}, ... ]
 * **summary_uk:** ...
 * or nearly-valid JSON missing trailing `]}`.
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

  const expanded: string[] = [];
  for (const candidate of candidates) {
    expanded.push(candidate);
    const repaired = repairTruncatedJson(candidate);
    if (repaired && repaired !== candidate) expanded.push(repaired);
  }

  for (const candidate of expanded) {
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
  if (start < 0) return out;
  const end = text.lastIndexOf('}');
  if (end > start) out.push(text.slice(start, end + 1));
  // Truncated payloads often end mid-structure — take to EOF for repair.
  const toEnd = text.slice(start).trim();
  if (toEnd && toEnd !== out[out.length - 1]) out.push(toEnd);
  return out;
}

/** Close unclosed { [ " so tiny models' truncated JSON can parse. */
function repairTruncatedJson(raw: string): string {
  let s = raw.trim().replace(/,\s*([}\]])/g, '$1');
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length && stack[stack.length - 1] === ch) {
      stack.pop();
    }
  }
  if (inString) s += '"';
  s = s.replace(/,\s*$/, '');
  while (stack.length) s += stack.pop();
  return s;
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
