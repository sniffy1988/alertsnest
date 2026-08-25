import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';
import { normalize } from '../common/text';
import { GAZETTEER, KHARKIV_CENTER, type PlaceKind } from './ua-gazetteer';
import {
  expandPlaceSlang,
  foldPlaceText,
  foldUa,
  inKharkivOblast,
  looksLikeSettlement,
  namesEqual,
  nominativeGuesses,
  OBLAST_BBOX,
  placeStem,
  placeVariants,
  registerPlaceSlang,
} from './place-match';

export type ToponymKind = PlaceKind;

export type MemoryToponym = {
  id: number;
  name: string;
  norm: string;
  aliases: string[];
  lat: number;
  lon: number;
  kind: ToponymKind;
  source: string;
};

export type LearnResult =
  | { status: 'local'; place: MemoryToponym }
  | { status: 'foreign'; label: string }
  | { status: 'unknown'; label: string };

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OVERPASS_QUERY = `
[out:json][timeout:90];
(
  way["highway"]["name"](49.89,36.05,50.12,36.45);
  node["place"~"suburb|neighbourhood|quarter"]["name"](49.89,36.05,50.12,36.45);
);
out center tags;
`.trim();

type NominatimHit = { lat: string; lon: string; name?: string; display_name?: string };

@Injectable()
export class ToponymService implements OnModuleInit {
  private readonly logger = new Logger(ToponymService.name);
  private items: MemoryToponym[] = [];
  private byNorm = new Map<string, MemoryToponym>();
  private lastGeocodeAt = 0;
  private readonly geocodeCache = new Map<string, { lat: number; lon: number; displayName?: string; inOblast: boolean } | 'miss'>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.dropBadLearned();
    await this.ensureSeed();
    await this.refreshMemory();
    await this.sweepResolvedUnknowns();
    const osmCount = await this.prisma.toponym.count({ where: { source: 'osm' } });
    if (osmCount === 0) {
      try {
        const added = await this.importFromOsm();
        this.logger.log(`OSM import added ${added} toponyms`);
        await this.refreshMemory();
      } catch (err) {
        this.logger.warn(`OSM import skipped: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.logger.log(`Toponym dictionary ready: ${this.items.length}`);
  }

  all(): MemoryToponym[] {
    return this.items;
  }

  lookup(raw: string): MemoryToponym | null {
    const key = normalize(raw);
    if (!key) return null;
    for (const variant of placeVariants(raw)) {
      const exact = this.byNorm.get(variant) ?? this.byNorm.get(normalize(variant)) ?? this.byNorm.get(foldUa(variant));
      if (exact) return exact;
    }

    const queryStem = placeStem(raw);
    if (queryStem.length < 5) return null;

    let best: MemoryToponym | null = null;
    let bestLen = 0;
    for (const item of this.items) {
      const labels = [item.name, item.norm, ...item.aliases];
      for (const label of labels) {
        if (!namesEqual(raw, label)) continue;
        const len = foldUa(label).length;
        if (len > bestLen) {
          best = item;
          bestLen = len;
        }
      }
    }
    return best;
  }

  findInText(text: string): MemoryToponym[] {
    const folded = foldPlaceText(text);
    if (!folded) return [];
    const slang = expandPlaceSlang(text);
    const withSt = folded.replace(/(^|\s)ст\s+/g, '$1старий ');
    const haystacks = [...new Set([folded, slang, withSt])];
    const tokens = folded.split(' ').filter(Boolean);
    const hits = new Map<number, MemoryToponym>();
    const scored: Array<{ item: MemoryToponym; len: number }> = [];

    for (const item of this.items) {
      const labels = [item.name, item.norm, ...item.aliases];
      for (const label of labels) {
        const phrase = foldUa(label);
        const phraseHit = haystacks.some((hay) => phrase.includes(' ') && ` ${hay} `.includes(` ${phrase} `));
        if (phraseHit) {
          scored.push({ item, len: phrase.length });
          break;
        }
        if (phrase.length >= 2 && phrase.length <= 3 && tokens.includes(phrase)) {
          scored.push({ item, len: phrase.length });
          break;
        }
        const stem = placeStem(label);
        if (stem.length < 4) continue;
        const ok = tokens.some((token) => {
          if (item.kind === 'city') {
            return /^(харків|харьков|kharkiv|kharkov|харкову|харькову|харкова|харькова|харкові)$/.test(
              foldUa(token),
            );
          }
          if (namesEqual(token, label)) return true;
          const tokenStem = placeStem(token);
          return tokenStem.length >= 4 && tokenStem === stem;
        });
        if (!ok) continue;
        scored.push({ item, len: foldUa(label).length });
        break;
      }
    }

    scored.sort((a, b) => b.len - a.len);
    for (const row of scored) {
      const longer = [...hits.values()].some(
        (existing) =>
          foldUa(existing.name).includes(foldUa(row.item.name)) ||
          foldUa(existing.norm).includes(foldUa(row.item.norm)),
      );
      if (longer) continue;
      hits.set(row.item.id, row.item);
    }
    return [...hits.values()];
  }

  async explain(
    alias: string,
    meaning: string,
  ): Promise<
    | { ok: true; place: string; lat: number; lon: number; learned: boolean }
    | { ok: false; reason: 'bad' | 'unknown_target' | 'foreign' }
  > {
    const rawAlias = alias.trim();
    const rawMeaning = meaning.trim();
    if (rawAlias.length < 2 || rawMeaning.length < 2) return { ok: false, reason: 'bad' };
    let target = this.lookup(rawMeaning);
    let learned = false;
    if (!target) {
      const [result] = await this.learn([rawMeaning]);
      if (result?.status === 'foreign') return { ok: false, reason: 'foreign' };
      if (result?.status !== 'local') return { ok: false, reason: 'unknown_target' };
      target = result.place;
      learned = true;
    }
    await this.addAlias(target, rawAlias);
    if (foldUa(rawAlias) !== foldUa(rawMeaning)) await this.addAlias(target, rawMeaning);
    await this.sweepUnknowns(rawAlias);
    await this.sweepUnknowns(rawMeaning);
    this.logger.log(`taught alias "${rawAlias}" → ${target.name}${learned ? ' (geocoded)' : ''}`);
    return { ok: true, place: target.name, lat: target.lat, lon: target.lon, learned };
  }

  async rememberUnknown(input: {
    labels: string[];
    sampleText: string;
    channel: string;
  }): Promise<{ created: Array<{ id: number; label: string }> }> {
    const created: Array<{ id: number; label: string }> = [];
    const labels = input.labels.map((s) => s.trim()).filter((s) => s.length >= 2);
    const toStore = labels.length ? labels : [input.sampleText.slice(0, 48).trim()].filter(Boolean);
    const seenNorm = new Set<string>();
    for (const label of toStore) {
      if (this.lookup(label)) continue;
      const norm = this.unknownNorm(label);
      if (!norm || this.lookup(norm) || seenNorm.has(norm)) continue;
      seenNorm.add(norm);
      const existing = await this.prisma.unknownToponym.findUnique({ where: { norm } });
      if (existing) {
        await this.prisma.unknownToponym.update({
          where: { id: existing.id },
          data: {
            hitCount: { increment: 1 },
            lastSeenAt: new Date(),
            sampleText: input.sampleText.slice(0, 400),
            channel: input.channel,
          },
        });
        continue;
      }
      const row = await this.prisma.unknownToponym.create({
        data: {
          label,
          norm,
          sampleText: input.sampleText.slice(0, 400),
          channel: input.channel,
        },
      });
      created.push({ id: row.id, label });
    }
    return { created };
  }

  listUnknown(limit = 25) {
    return this.prisma.unknownToponym.findMany({
      orderBy: [{ hitCount: 'desc' }, { lastSeenAt: 'desc' }],
      take: limit,
    });
  }

  async dismissUnknown(idOrLabel: string): Promise<boolean> {
    const id = Number(idOrLabel);
    if (Number.isInteger(id) && id > 0) {
      try {
        await this.prisma.unknownToponym.delete({ where: { id } });
        return true;
      } catch {
        return false;
      }
    }
    const norm = foldUa(idOrLabel);
    const res = await this.prisma.unknownToponym.deleteMany({
      where: { OR: [{ norm }, { label: idOrLabel.trim() }] },
    });
    return res.count > 0;
  }

  private unknownNorm(label: string): string {
    const stem = placeStem(label);
    return stem.length >= 4 ? stem : foldUa(label);
  }

  private async sweepUnknowns(alias: string): Promise<void> {
    const norms = [...new Set([this.unknownNorm(alias), foldUa(alias), normalize(alias)].filter(Boolean))];
    if (norms.length) {
      await this.prisma.unknownToponym.deleteMany({ where: { norm: { in: norms } } });
    }
    await this.sweepResolvedUnknowns();
  }

  private async sweepResolvedUnknowns(): Promise<void> {
    const leftover = await this.prisma.unknownToponym.findMany();
    for (const row of leftover) {
      if (this.lookup(row.label) || this.lookup(row.norm)) {
        await this.prisma.unknownToponym.delete({ where: { id: row.id } }).catch(() => undefined);
      }
    }
  }

  private async addAlias(item: MemoryToponym, seenAs: string): Promise<void> {
    const extras = [...new Set([normalize(seenAs), foldUa(seenAs), seenAs.trim().toLowerCase()].filter(Boolean))];
    const aliases = new Set(item.aliases);
    for (const extra of extras) aliases.add(extra);
    item.aliases = [...aliases];
    for (const extra of extras) {
      this.byNorm.set(extra, item);
      const folded = foldUa(extra);
      if (folded) this.byNorm.set(folded, item);
      registerPlaceSlang(extra, item.name);
    }
    await this.prisma.toponym.update({
      where: { id: item.id },
      data: { aliases: JSON.stringify(item.aliases) },
    });
  }

  resolveNames(names: string[]): MemoryToponym[] {
    const found = new Map<number, MemoryToponym>();
    for (const name of names) {
      const hit = this.lookup(name);
      if (hit) found.set(hit.id, hit);
    }
    return [...found.values()];
  }

  async learn(names: string[], hint?: MemoryToponym | null): Promise<LearnResult[]> {
    const resolved: LearnResult[] = [];
    for (const raw of names) {
      const name = raw.trim();
      if (name.length < 3) continue;
      const existing = this.lookup(name);
      if (existing) {
        await this.touch(existing, name);
        const fresh = this.byNorm.get(existing.norm) ?? existing;
        resolved.push({ status: 'local', place: fresh });
        continue;
      }
      resolved.push(await this.insertLearned(name, hint));
    }
    return resolved;
  }

  private async insertLearned(name: string, hint?: MemoryToponym | null): Promise<LearnResult> {
    const kind = this.guessKind(name);
    const geo = await this.geocode(name, kind);
    if (!geo) {
      this.logger.log(`Skip learn "${name}" (${kind}): no coordinates`);
      return { status: 'unknown', label: name };
    }
    if (!geo.inOblast) {
      this.logger.log(`Skip learn "${name}": outside oblast ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
      return { status: 'foreign', label: geo.displayName ?? name };
    }
    const official = geo.displayName?.split(',')[0]?.trim() || name;
    const aliases = [
      ...new Set(
        [normalize(name), foldUa(name), normalize(official), foldUa(official), ...nominativeGuesses(name)].filter(
          Boolean,
        ),
      ),
    ];
    const row = await this.prisma.toponym.create({
      data: {
        name: official,
        norm: normalize(official),
        aliases: JSON.stringify(aliases),
        lat: geo.lat,
        lon: geo.lon,
        kind,
        source: 'nominatim',
        hitCount: 1,
      },
    });
    const mem = this.toMemory(row);
    this.index(mem);
    await this.sweepUnknowns(name);
    this.logger.log(`Learned toponym "${official}" from "${name}" (${kind}) ${geo.lat.toFixed(4)},${geo.lon.toFixed(4)}`);
    return { status: 'local', place: mem };
  }

  private async touch(item: MemoryToponym, seenAs: string): Promise<void> {
    const alias = normalize(seenAs);
    const aliases = new Set(item.aliases);
    aliases.add(alias);
    item.aliases = [...aliases];
    this.byNorm.set(alias, item);
    await this.prisma.toponym.update({
      where: { id: item.id },
      data: {
        hitCount: { increment: 1 },
        aliases: JSON.stringify(item.aliases),
      },
    });
  }

  private guessKind(name: string): ToponymKind {
    const n = foldUa(name);
    if (n === 'харків' || n === 'харьков') return 'city';
    if (/(област|пригород|околиц|передміст)/.test(n)) return 'region';
    if (looksLikeSettlement(name)) return 'settlement';
    if (n.includes('район') || n.includes('салтів') || n.includes('олексі') || n.includes('хтз')) {
      return 'district';
    }
    if (n.includes('вул') || n.includes('просп') || n.includes('майдан') || n.includes('шосе')) {
      return 'street';
    }
    return 'settlement';
  }

  private async dropBadLearned(): Promise<void> {
    const bad = await this.prisma.toponym.deleteMany({
      where: { source: 'llm' },
    });
    if (bad.count) this.logger.log(`Dropped ${bad.count} learned toponyms with guessed coords`);
  }

  private async geocode(
    name: string,
    kind: ToponymKind,
  ): Promise<{ lat: number; lon: number; displayName?: string; inOblast: boolean } | null> {
    const cacheKey = `${kind}:${foldUa(name)}`;
    const cached = this.geocodeCache.get(cacheKey);
    if (cached === 'miss') return null;
    if (cached) return cached;

    const queries = nominativeGuesses(name);
    let foreign: { lat: number; lon: number; displayName?: string; inOblast: boolean } | null = null;

    for (const query of queries) {
      const local = await this.nominatimSearch(query, kind, true);
      if (local) {
        this.geocodeCache.set(cacheKey, local);
        return local;
      }
    }
    for (const query of queries) {
      const anywhere = await this.nominatimSearch(query, kind, false);
      if (!anywhere) continue;
      if (anywhere.inOblast) {
        this.geocodeCache.set(cacheKey, anywhere);
        return anywhere;
      }
      foreign = anywhere;
    }

    if (foreign) {
      this.geocodeCache.set(cacheKey, foreign);
      return foreign;
    }
    this.geocodeCache.set(cacheKey, 'miss');
    return null;
  }

  private async nominatimSearch(
    name: string,
    kind: ToponymKind,
    bounded: boolean,
  ): Promise<{ lat: number; lon: number; displayName?: string; inOblast: boolean } | null> {
    const wait = 1100 - (Date.now() - this.lastGeocodeAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastGeocodeAt = Date.now();

    const suffix =
      kind === 'street' || kind === 'district'
        ? 'Харків Україна'
        : bounded
          ? 'Харківська область Україна'
          : 'Україна';
    try {
      const response = await axios.get<NominatimHit[]>('https://nominatim.openstreetmap.org/search', {
        timeout: 12_000,
        params: {
          q: `${name} ${suffix}`,
          format: 'jsonv2',
          limit: 5,
          countrycodes: 'ua',
          viewbox: `${OBLAST_BBOX.minLon},${OBLAST_BBOX.maxLat},${OBLAST_BBOX.maxLon},${OBLAST_BBOX.minLat}`,
          bounded: bounded ? 1 : 0,
          ...(kind === 'settlement' || kind === 'city' ? { featureType: 'settlement' } : {}),
        },
        headers: { 'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)', Accept: 'application/json', 'Accept-Language': 'uk' },
      });
      const scored = response.data
        .map((hit) => {
          const lat = Number(hit.lat);
          const lon = Number(hit.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return {
            lat,
            lon,
            displayName: hit.name || hit.display_name,
            inOblast: inKharkivOblast(lat, lon),
            km: this.haversineKm(lat, lon, KHARKIV_CENTER.lat, KHARKIV_CENTER.lon),
          };
        })
        .filter((hit): hit is NonNullable<typeof hit> => hit != null);

      const inOblast = scored.filter((hit) => hit.inOblast);
      const pool = bounded ? inOblast : scored;
      if ((kind === 'street' || kind === 'district') && inOblast.length) {
        const city = inOblast.filter((hit) => hit.km <= 25);
        if (!city.length) return null;
        city.sort((a, b) => a.km - b.km);
        return city[0];
      }
      pool.sort((a, b) => {
        if (a.inOblast !== b.inOblast) return a.inOblast ? -1 : 1;
        return a.km - b.km;
      });
      const best = pool[0];
      if (!best) return null;
      return { lat: best.lat, lon: best.lon, displayName: best.displayName, inOblast: best.inOblast };
    } catch (err) {
      this.logger.warn(`Nominatim "${name}": ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (n: number) => (n * Math.PI) / 180;
    const r = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  private async ensureSeed(): Promise<void> {
    for (const place of GAZETTEER) {
      const aliases = [...new Set([normalize(place.name), ...place.aliases.map(normalize)])];
      const norm = aliases[0];
      const existing = await this.prisma.toponym.findUnique({ where: { norm } });
      if (existing) {
        const merged = [...new Set([...this.parseAliases(existing.aliases), ...aliases])];
        await this.prisma.toponym.update({
          where: { id: existing.id },
          data: { aliases: JSON.stringify(merged), lat: place.lat, lon: place.lon, kind: place.kind },
        });
        continue;
      }
      await this.prisma.toponym.create({
        data: {
          name: place.name,
          norm,
          aliases: JSON.stringify(aliases),
          lat: place.lat,
          lon: place.lon,
          kind: place.kind,
          source: 'seed',
          hitCount: 0,
        },
      });
    }
  }

  private parseAliases(raw: string): string[] {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  private async importFromOsm(): Promise<number> {
    const elements = await this.fetchOverpass();
    this.logger.log(`OSM overpass elements=${elements.length}`);
    let added = 0;
    for (const el of elements) {
      const name = el.tags?.['name:uk'] || el.tags?.name;
      if (!name) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;
      const kind = this.kindFromOsm(el);
      const norm = normalize(name);
      if (!norm || this.byNorm.has(norm)) continue;
      try {
        const aliases = [norm];
        if (el.tags?.['name:ru']) aliases.push(normalize(el.tags['name:ru']));
        if (el.tags?.['name:en']) aliases.push(normalize(el.tags['name:en']));
        const row = await this.prisma.toponym.create({
          data: {
            name,
            norm,
            aliases: JSON.stringify([...new Set(aliases.filter(Boolean))]),
            lat,
            lon,
            kind,
            source: 'osm',
            hitCount: 0,
          },
        });
        this.index(this.toMemory(row));
        added += 1;
      } catch {
        // unique race / duplicate
      }
    }
    return added;
  }

  private async fetchOverpass(): Promise<OsmElement[]> {
    let lastError: unknown;
    for (const url of OVERPASS_URLS) {
      try {
        const response = await axios.post(url, new URLSearchParams({ data: OVERPASS_QUERY }).toString(), {
          timeout: 90_000,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: '*/*',
            'User-Agent': 'alertsNest/1.0 (kharkiv-alerts)',
          },
        });
        const elements = (response.data as { elements?: OsmElement[] }).elements ?? [];
        if (elements.length) return elements;
        this.logger.warn(`OSM ${url} empty response`);
      } catch (err) {
        lastError = err;
        this.logger.warn(`OSM ${url} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    throw lastError ?? new Error('Overpass failed');
  }

  private kindFromOsm(el: OsmElement): ToponymKind {
    const place = el.tags?.place;
    if (place === 'village' || place === 'town' || place === 'hamlet' || place === 'isolated_dwelling') {
      return 'settlement';
    }
    if (place === 'suburb' || place === 'neighbourhood' || place === 'quarter') return 'district';
    if (el.tags?.admin_level) return 'district';
    return 'street';
  }

  private async refreshMemory(): Promise<void> {
    const rows = await this.prisma.toponym.findMany();
    this.items = [];
    this.byNorm.clear();
    for (const row of rows) this.index(this.toMemory(row));
  }

  private toMemory(row: {
    id: number;
    name: string;
    norm: string;
    aliases: string;
    lat: number;
    lon: number;
    kind: string;
    source: string;
  }): MemoryToponym {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(row.aliases) as string[];
    } catch {
      aliases = [row.norm];
    }
    return {
      id: row.id,
      name: row.name,
      norm: row.norm,
      aliases,
      lat: row.lat,
      lon: row.lon,
      kind: row.kind as ToponymKind,
      source: row.source,
    };
  }

  private index(item: MemoryToponym): void {
    if (!this.items.some((x) => x.id === item.id)) this.items.push(item);
    this.byNorm.set(item.norm, item);
    const folded = foldUa(item.norm);
    if (folded) this.byNorm.set(folded, item);
    for (const alias of item.aliases) {
      if (alias) {
        this.byNorm.set(alias, item);
        const foldAlias = foldUa(alias);
        if (foldAlias) this.byNorm.set(foldAlias, item);
        registerPlaceSlang(alias, item.name);
      }
    }
  }
}

type OsmElement = {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};
